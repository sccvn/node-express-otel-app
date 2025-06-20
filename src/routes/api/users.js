const mongoose = require('mongoose');
const router = require('express').Router();
const passport = require('passport');
const User = mongoose.model('User');
const auth = require('../auth');
const tracingManager = require('../../telemetry/tracing');
const metricsManager = require('../../telemetry/metrics');
const RequestTracingMiddleware = require('../../telemetry/middleware/request-tracer');

// Apply business context middleware to all routes
router.use(RequestTracingMiddleware.businessContextMiddleware());

/**
 * User Registration Endpoint with Comprehensive Telemetry
 * 
 * Business Context: New user onboarding
 * Key Metrics: Registration success rate, validation errors, performance
 */
router.post('/', async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'user.registration_flow',
    {
      'registration.source': req.headers['user-agent'] ? 'web' : 'api',
      'registration.has_bio': !!req.body.user?.bio,
      'registration.has_image': !!req.body.user?.image,
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        const { body: { user } } = req;

        // Validate required fields with detailed error tracking
        if (!user) {
          span.setAttributes({
            'validation.error': 'missing_user_object',
            'validation.field': 'user',
          });
          return res.status(422).json({
            errors: { user: "can't be blank" }
          });
        }

        if (!user.username) {
          span.setAttributes({
            'validation.error': 'missing_username',
            'validation.field': 'username',
          });
          return res.status(422).json({
            errors: { username: "can't be blank" }
          });
        }

        if (!user.email) {
          span.setAttributes({
            'validation.error': 'missing_email',
            'validation.field': 'email',
          });
          return res.status(422).json({
            errors: { email: "can't be blank" }
          });
        }

        if (!user.password) {
          span.setAttributes({
            'validation.error': 'missing_password',
            'validation.field': 'password',
          });
          return res.status(422).json({
            errors: { password: "can't be blank" }
          });
        }

        // Create new user with telemetry tracking
        const finalUser = new User();
        finalUser.username = user.username;
        finalUser.email = user.email;
        finalUser.bio = user.bio;
        finalUser.image = user.image;

        // Set password with security tracking
        await finalUser.setPassword(user.password);

        // Save user with database telemetry
        const savedUser = await tracingManager.traceDatabaseOperation(
          'create',
          'users',
          {
            username: user.username,
            email: tracingManager.hashPII(user.email), // Hash PII for telemetry
          },
          () => finalUser.save()
        );

        // Generate JWT with telemetry
        const token = await savedUser.generateJWT();

        const duration = timer.end();

        // Record comprehensive registration metrics
        metricsManager.recordUserOperation(
          'register',
          savedUser._id.toString(),
          true,
          duration
        );

        span.setAttributes({
          'registration.success': true,
          'registration.duration_ms': duration,
          'registration.user_id': savedUser._id.toString(),
          'registration.username': savedUser.username,
        });

        return res.json({
          user: {
            username: savedUser.username,
            email: savedUser.email,
            bio: savedUser.bio,
            image: savedUser.image,
            token: token
          }
        });

      } catch (error) {
        const duration = timer.end();

        // Record failed registration metrics
        metricsManager.recordUserOperation('register', 'unknown', false, duration);

        // Track specific error types
        if (error.code === 11000) {
          // Duplicate key error
          span.setAttributes({
            'registration.error': 'duplicate_user',
            'registration.error_code': error.code,
          });

          const field = Object.keys(error.keyPattern)[0];
          return res.status(422).json({
            errors: { [field]: 'already exists' }
          });
        }

        span.recordException(error);
        span.setAttributes({
          'registration.error': error.message,
          'registration.success': false,
        });

        next(error);
      }
    }
  );
});

/**
 * User Login Endpoint with Authentication Telemetry
 * 
 * Business Context: User authentication and session management
 * Key Metrics: Login success rate, authentication time, security events
 */
router.post('/login', async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'user.authentication_flow',
    {
      'auth.method': 'password',
      'auth.source': req.headers['user-agent'] ? 'web' : 'api',
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        const { body: { user } } = req;

        // Validate login payload
        if (!user) {
          span.setAttributes({
            'auth.error': 'missing_credentials',
            'auth.field': 'user',
          });
          return res.status(422).json({ errors: { user: "can't be blank" } });
        }

        if (!user.email) {
          span.setAttributes({
            'auth.error': 'missing_email',
            'auth.field': 'email',
          });
          return res.status(422).json({ errors: { email: "can't be blank" } });
        }

        if (!user.password) {
          span.setAttributes({
            'auth.error': 'missing_password',
            'auth.field': 'password',
          });
          return res.status(422).json({ errors: { password: "can't be blank" } });
        }

        // Find user with telemetry
        const foundUser = await tracingManager.traceDatabaseOperation(
          'findOne',
          'users',
          { email: tracingManager.hashPII(user.email) },
          () => User.findOne({ email: user.email })
        );

        if (!foundUser) {
          const duration = timer.end();

          metricsManager.recordUserOperation('login', 'unknown', false, duration);

          span.setAttributes({
            'auth.error': 'user_not_found',
            'auth.success': false,
            'auth.duration_ms': duration,
          });

          return res.status(422).json({
            errors: { 'email or password': 'is invalid' }
          });
        }

        // Validate password with security telemetry
        const isValidPassword = await foundUser.validPassword(user.password);

        if (!isValidPassword) {
          const duration = timer.end();

          metricsManager.recordUserOperation('login', foundUser._id.toString(), false, duration);

          span.setAttributes({
            'auth.error': 'invalid_password',
            'auth.success': false,
            'auth.user_id': foundUser._id.toString(),
            'auth.duration_ms': duration,
          });

          return res.status(422).json({
            errors: { 'email or password': 'is invalid' }
          });
        }

        // Generate JWT token
        const token = await foundUser.generateJWT();

        const duration = timer.end();

        // Record successful login metrics
        metricsManager.recordUserOperation('login', foundUser._id.toString(), true, duration);

        // Add user context to current trace
        tracingManager.addUserContext(
          foundUser._id.toString(),
          foundUser.email,
          'user'
        );

        span.setAttributes({
          'auth.success': true,
          'auth.user_id': foundUser._id.toString(),
          'auth.username': foundUser.username,
          'auth.duration_ms': duration,
        });

        return res.json({
          user: {
            username: foundUser.username,
            email: foundUser.email,
            bio: foundUser.bio,
            image: foundUser.image,
            token: token
          }
        });

      } catch (error) {
        const duration = timer.end();

        metricsManager.recordUserOperation('login', 'unknown', false, duration);

        span.recordException(error);
        span.setAttributes({
          'auth.error': error.message,
          'auth.success': false,
          'auth.duration_ms': duration,
        });

        next(error);
      }
    }
  );
});

/**
 * Get Current User Profile with Context Tracking
 */
router.get('/', auth.required, async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'user.get_current_profile',
    {
      'user.id': req.user.id,
      'profile.type': 'current_user',
    },
    async (span) => {
      try {
        // Add user context to trace
        tracingManager.addUserContext(req.user.id, req.user.email, 'user');

        const token = await req.user.generateJWT();

        span.setAttributes({
          'profile.username': req.user.username,
          'profile.has_bio': !!req.user.bio,
          'profile.has_image': !!req.user.image,
        });

        return res.json({
          user: {
            username: req.user.username,
            email: req.user.email,
            bio: req.user.bio,
            image: req.user.image,
            token: token
          }
        });
      } catch (error) {
        span.recordException(error);
        next(error);
      }
    }
  );
});

/**
 * Update User Profile with Change Tracking
 */
router.put('/', auth.required, async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'user.update_profile',
    {
      'user.id': req.user.id,
      'profile.operation': 'update',
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        const { body: { user } } = req;

        // Track what fields are being updated
        const updatedFields = [];

        if (typeof user.username !== 'undefined') {
          req.user.username = user.username;
          updatedFields.push('username');
        }
        if (typeof user.email !== 'undefined') {
          req.user.email = user.email;
          updatedFields.push('email');
        }
        if (typeof user.bio !== 'undefined') {
          req.user.bio = user.bio;
          updatedFields.push('bio');
        }
        if (typeof user.image !== 'undefined') {
          req.user.image = user.image;
          updatedFields.push('image');
        }
        if (typeof user.password !== 'undefined') {
          await req.user.setPassword(user.password);
          updatedFields.push('password');
        }

        // Save with database telemetry
        const savedUser = await tracingManager.traceDatabaseOperation(
          'update',
          'users',
          { userId: req.user.id },
          () => req.user.save()
        );

        const token = await savedUser.generateJWT();

        const duration = timer.end();

        // Record profile update metrics
        metricsManager.recordUserOperation('update_profile', req.user.id, true, duration);

        span.setAttributes({
          'profile.updated_fields': updatedFields.join(','),
          'profile.fields_count': updatedFields.length,
          'profile.update_duration_ms': duration,
        });

        return res.json({
          user: {
            username: savedUser.username,
            email: savedUser.email,
            bio: savedUser.bio,
            image: savedUser.image,
            token: token
          }
        });

      } catch (error) {
        const duration = timer.end();

        metricsManager.recordUserOperation('update_profile', req.user.id, false, duration);

        span.recordException(error);
        span.setAttributes({
          'profile.update_error': error.message,
          'profile.update_duration_ms': duration,
        });

        next(error);
      }
    }
  );
});

module.exports = router;