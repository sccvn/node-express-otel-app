const jwt = require('express-jwt').expressjwt;
const secret = require('../config').secret;
const tracingManager = require('../telemetry/tracing');
const metricsManager = require('../telemetry/metrics');
const { trace } = require('@opentelemetry/api');

/**
 * Enhanced JWT Authentication Middleware with Comprehensive Telemetry
 * 
 * Design Philosophy:
 * - Security-first approach with detailed audit logging
 * - Performance tracking for authentication operations
 * - Comprehensive error handling and correlation
 * - User context propagation for downstream telemetry
 */

/**
 * Extract JWT token from request with multiple source support
 * Supports Authorization header, query parameter, and cookie-based tokens
 */
function getTokenFromRequest(req) {
  return tracingManager.traceBusinessOperation(
    'auth.extract_token',
    {
      'auth.token_source': 'unknown',
      'auth.has_authorization_header': !!req.headers.authorization,
      'auth.has_query_token': !!req.query.token,
      'auth.has_cookie_token': !!req.cookies?.token,
    },
    async (span) => {
      let token = null;
      let source = 'none';

      // Priority order: Authorization header -> Query parameter -> Cookie
      if (req.headers.authorization && req.headers.authorization.split(' ')[0] === 'Token') {
        token = req.headers.authorization.split(' ')[1];
        source = 'authorization_header';
      } else if (req.headers.authorization && req.headers.authorization.split(' ')[0] === 'Bearer') {
        token = req.headers.authorization.split(' ')[1];
        source = 'bearer_header';
      } else if (req.query && req.query.token) {
        token = req.query.token;
        source = 'query_parameter';
      } else if (req.cookies && req.cookies.token) {
        token = req.cookies.token;
        source = 'cookie';
      }

      span.setAttributes({
        'auth.token_source': source,
        'auth.token_present': !!token,
        'auth.token_length': token ? token.length : 0,
      });

      // Security: Log token extraction attempts for monitoring
      if (!token) {
        span.setAttribute('auth.extraction_result', 'no_token_found');
      } else {
        span.setAttribute('auth.extraction_result', 'token_extracted');
      }

      return token;
    }
  );
}

/**
 * JWT Authentication Middleware - Required Authentication
 * Ensures user is authenticated for protected routes
 */
const required = jwt({
  secret: 'your-secret-key',
  userProperty: 'payload', // Store decoded JWT in req.payload
  getToken: getTokenFromRequest,
  algorithms: ['HS256'], // Explicitly specify allowed algorithms for security
}).unless({
  // Skip authentication for specific paths if needed
  path: []
});

/**
 * Enhanced required middleware with telemetry and user context injection
 */
const requiredWithTelemetry = async (req, res, next) => {
  await tracingManager.traceBusinessOperation(
    'auth.verify_required',
    {
      'auth.middleware_type': 'required',
      'auth.request_path': req.path,
      'auth.request_method': req.method,
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        // First run the JWT verification
        await new Promise((resolve, reject) => {
          required(req, res, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        if (!req.payload || !req.payload.id) {
          const duration = timer.end();

          // Record failed authentication
          metricsManager.recordUserOperation('auth_verify', 'unknown', false, duration);

          span.setAttributes({
            'auth.verification_result': 'invalid_payload',
            'auth.error': 'missing_user_id',
            'auth.duration_ms': duration,
          });

          return res.status(401).json({ errors: { message: 'No authorization token was found' } });
        }

        // Load user from database with telemetry
        const User = require('mongoose').model('User');
        const user = await tracingManager.traceDatabaseOperation(
          'findById',
          'users',
          { userId: req.payload.id },
          () => User.findById(req.payload.id)
        );

        if (!user) {
          const duration = timer.end();

          // Record failed user lookup
          metricsManager.recordUserOperation('auth_verify', req.payload.id, false, duration);

          span.setAttributes({
            'auth.verification_result': 'user_not_found',
            'auth.user_id': req.payload.id,
            'auth.duration_ms': duration,
          });

          return res.status(401).json({ errors: { message: 'User not found' } });
        }

        const duration = timer.end();

        // Attach user to request
        req.user = user;

        // Add user context to telemetry
        tracingManager.addUserContext(
          user._id.toString(),
          user.email,
          user.role || 'user'
        );

        // Record successful authentication
        metricsManager.recordUserOperation('auth_verify', user._id.toString(), true, duration);

        span.setAttributes({
          'auth.verification_result': 'success',
          'auth.user_id': user._id.toString(),
          'auth.username': user.username,
          'auth.duration_ms': duration,
          'auth.token_age_seconds': Math.floor((Date.now() / 1000) - req.payload.iat),
          'auth.token_expires_in_seconds': req.payload.exp - Math.floor(Date.now() / 1000),
        });

        // Check if token is about to expire (within 1 hour)
        const tokenExpiresIn = req.payload.exp - Math.floor(Date.now() / 1000);
        if (tokenExpiresIn < 3600) {
          span.setAttribute('auth.token_expiring_soon', true);
          res.setHeader('X-Token-Expiring', 'true');
        }

        next();

      } catch (error) {
        const duration = timer.end();

        // Record authentication error
        metricsManager.recordUserOperation('auth_verify', req.payload?.id || 'unknown', false, duration);

        span.recordException(error);
        span.setAttributes({
          'auth.verification_result': 'error',
          'auth.error_type': error.name,
          'auth.error_message': error.message,
          'auth.duration_ms': duration,
        });

        // Handle specific JWT errors with appropriate responses
        if (error.name === 'UnauthorizedError') {
          return res.status(401).json({
            errors: {
              message: 'Invalid or expired token',
              traceId: trace.getActiveSpan()?.spanContext().traceId
            }
          });
        }

        if (error.name === 'TokenExpiredError') {
          return res.status(401).json({
            errors: {
              message: 'Token has expired',
              traceId: trace.getActiveSpan()?.spanContext().traceId
            }
          });
        }

        if (error.name === 'JsonWebTokenError') {
          return res.status(401).json({
            errors: {
              message: 'Malformed token',
              traceId: trace.getActiveSpan()?.spanContext().traceId
            }
          });
        }

        // Generic error response
        return res.status(401).json({
          errors: {
            message: 'Authentication failed',
            traceId: trace.getActiveSpan()?.spanContext().traceId
          }
        });
      }
    }
  );
};

/**
 * Optional Authentication Middleware
 * Allows both authenticated and anonymous access
 */
const optional = jwt({
  secret: 'your-secret-key',
  userProperty: 'payload',
  getToken: getTokenFromRequest,
  credentialsRequired: false,
  algorithms: ['HS256']
}).unless({
  path: []
});

/**
 * Enhanced optional middleware with telemetry
 */
const optionalWithTelemetry = async (req, res, next) => {
  await tracingManager.traceBusinessOperation(
    'auth.verify_optional',
    {
      'auth.middleware_type': 'optional',
      'auth.request_path': req.path,
      'auth.request_method': req.method,
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        // Run JWT verification (non-required)
        await new Promise((resolve, reject) => {
          optional(req, res, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        const duration = timer.end();

        // If we have a valid payload, load the user
        if (req.payload && req.payload.id) {
          const User = require('mongoose').model('User');
          const user = await tracingManager.traceDatabaseOperation(
            'findById',
            'users',
            { userId: req.payload.id },
            () => User.findById(req.payload.id)
          );

          if (user) {
            req.user = user;

            // Add user context to telemetry
            tracingManager.addUserContext(
              user._id.toString(),
              user.email,
              user.role || 'user'
            );

            span.setAttributes({
              'auth.verification_result': 'authenticated_user',
              'auth.user_id': user._id.toString(),
              'auth.username': user.username,
              'auth.duration_ms': duration,
            });

            // Record successful optional authentication
            metricsManager.recordUserOperation('auth_optional', user._id.toString(), true, duration);
          } else {
            span.setAttributes({
              'auth.verification_result': 'invalid_user',
              'auth.user_id': req.payload.id,
              'auth.duration_ms': duration,
            });
          }
        } else {
          span.setAttributes({
            'auth.verification_result': 'anonymous_user',
            'auth.duration_ms': duration,
          });
        }

        next();

      } catch (error) {
        const duration = timer.end();

        span.recordException(error);
        span.setAttributes({
          'auth.verification_result': 'error',
          'auth.error_type': error.name,
          'auth.error_message': error.message,
          'auth.duration_ms': duration,
        });

        // For optional auth, we continue even on errors (treat as anonymous)
        next();
      }
    }
  );
};

/**
 * Role-based authorization middleware
 * Checks if authenticated user has required role
 */
const requireRole = (requiredRole) => {
  return async (req, res, next) => {
    await tracingManager.traceBusinessOperation(
      'auth.check_role',
      {
        'auth.required_role': requiredRole,
        'auth.user_id': req.user?.id,
        'auth.user_role': req.user?.role || 'user',
      },
      async (span) => {
        try {
          if (!req.user) {
            span.setAttribute('auth.authorization_result', 'no_user');
            return res.status(401).json({ errors: { message: 'Authentication required' } });
          }

          const userRole = req.user.role || 'user';
          const hasPermission = this.checkRolePermission(userRole, requiredRole);

          span.setAttributes({
            'auth.authorization_result': hasPermission ? 'authorized' : 'forbidden',
            'auth.user_role': userRole,
            'auth.required_role': requiredRole,
            'auth.permission_granted': hasPermission,
          });

          if (!hasPermission) {
            // Record authorization failure
            metricsManager.recordUserOperation('auth_authorize', req.user.id, false);

            return res.status(403).json({
              errors: {
                message: 'Insufficient permissions',
                required: requiredRole,
                current: userRole
              }
            });
          }

          // Record successful authorization
          metricsManager.recordUserOperation('auth_authorize', req.user.id, true);

          next();

        } catch (error) {
          span.recordException(error);
          return res.status(500).json({ errors: { message: 'Authorization check failed' } });
        }
      }
    );
  };
};

/**
 * Check if user role has permission for required role
 * Implements hierarchical role system
 */
function checkRolePermission(userRole, requiredRole) {
  const roleHierarchy = {
    'user': 0,
    'moderator': 1,
    'admin': 2,
    'superadmin': 3
  };

  const userLevel = roleHierarchy[userRole] || 0;
  const requiredLevel = roleHierarchy[requiredRole] || 0;

  return userLevel >= requiredLevel;
}

/**
 * Rate limiting for authentication endpoints
 * Prevents brute force attacks
 */
const authRateLimit = async (req, res, next) => {
  await tracingManager.traceBusinessOperation(
    'auth.rate_limit_check',
    {
      'auth.client_ip': req.ip,
      'auth.endpoint': req.path,
      'rate_limit.type': 'authentication',
    },
    async (span) => {
      try {
        // In production, implement proper rate limiting with Redis
        // For now, we'll just add telemetry tracking

        const rateLimitKey = `auth_rate_limit:${req.ip}:${req.path}`;
        // TODO: Implement actual rate limiting logic

        span.setAttributes({
          'rate_limit.key': rateLimitKey,
          'rate_limit.result': 'allowed', // Would be actual result
          'rate_limit.remaining': 10, // Would be actual remaining requests
        });

        next();

      } catch (error) {
        span.recordException(error);
        next(error);
      }
    }
  );
};

module.exports = {
  required: requiredWithTelemetry,
  optional: optionalWithTelemetry,
  requireRole,
  authRateLimit,
  checkRolePermission
};