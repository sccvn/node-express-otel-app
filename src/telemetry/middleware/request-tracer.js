const tracingManager = require('../tracing');
const metricsManager = require('../metrics');
const { trace, context } = require('@opentelemetry/api');
const { SemanticAttributes } = require('@opentelemetry/semantic-conventions');

/**
 * Advanced request tracing middleware for the RealWorld application
 * 
 * Provides comprehensive observability for HTTP requests including:
 * - Distributed tracing with W3C trace context
 * - Business context correlation
 * - Performance metrics collection
 * - Error tracking and correlation
 * - User session tracking
 */
class RequestTracingMiddleware {
  /**
   * Create the main request tracing middleware
   * This should be one of the first middleware in the Express chain
   */
  static createMiddleware() {
    return async (req, res, next) => {
      const startTime = Date.now();
      const timer = metricsManager.createTimer();

      // Extract or create trace context
      const activeContext = context.active();

      // Create a span for this HTTP request
      const tracer = trace.getTracer('realworld-api-http', '1.0.0');

      await tracer.startActiveSpan(
        `${req.method} ${req.route?.path || req.path}`,
        {
          kind: 1, // SpanKind.SERVER
          attributes: {
            [SemanticAttributes.HTTP_METHOD]: req.method,
            [SemanticAttributes.HTTP_URL]: req.url,
            [SemanticAttributes.HTTP_ROUTE]: req.route?.path || req.path,
            [SemanticAttributes.HTTP_SCHEME]: req.protocol,
            [SemanticAttributes.HTTP_HOST]: req.get('host'),
            [SemanticAttributes.HTTP_USER_AGENT]: req.get('user-agent'),
            [SemanticAttributes.HTTP_REQUEST_CONTENT_LENGTH]: req.get('content-length'),
            // Custom attributes for business context
            'http.request.id': req.headers['x-request-id'] || generateRequestId(),
            'http.client.ip': req.ip || req.connection.remoteAddress,
            'http.request.body.size': req.get('content-length') || 0,
          },
        },
        activeContext,
        async (span) => {
          // Attach span to request for downstream use
          req.span = span;
          req.traceContext = tracingManager.getCurrentTraceContext();

          // Add request ID to response headers for correlation
          res.setHeader('X-Trace-Id', span.spanContext().traceId);
          res.setHeader('X-Request-Id', req.headers['x-request-id'] || generateRequestId());

          // Track response completion
          const originalSend = res.send;
          const originalJson = res.json;
          let responseSize = 0;

          // Intercept response methods to capture response data
          res.send = function (data) {
            responseSize = Buffer.byteLength(data || '', 'utf8');
            return originalSend.call(this, data);
          };

          res.json = function (data) {
            responseSize = Buffer.byteLength(JSON.stringify(data || {}), 'utf8');
            return originalJson.call(this, data);
          };

          // Handle response completion
          const finishHandler = () => {
            const duration = timer.end();

            // Update span with response information
            span.setAttributes({
              [SemanticAttributes.HTTP_STATUS_CODE]: res.statusCode,
              [SemanticAttributes.HTTP_RESPONSE_CONTENT_LENGTH]: responseSize,
              'http.response.size': responseSize,
              'http.request.duration_ms': duration,
            });

            // Determine if request was successful
            const isError = res.statusCode >= 400;
            if (isError) {
              span.setStatus({
                code: 2, // SpanStatusCode.ERROR
                message: `HTTP ${res.statusCode}`,
              });
            } else {
              span.setStatus({ code: 1 }); // SpanStatusCode.OK
            }

            // Record metrics
            metricsManager.recordApiRequest(
              req.method,
              req.route?.path || req.path,
              res.statusCode,
              duration,
              req.user?.id
            );

            // Add business context if available
            if (req.user) {
              tracingManager.addUserContext(
                req.user.id,
                req.user.email,
                req.user.role || 'user'
              );
            }

            // Clean up
            span.end();
          };

          // Listen for response finish
          res.on('finish', finishHandler);
          res.on('close', finishHandler);

          // Continue to next middleware
          next();
        }
      );
    };
  }

  /**
   * Middleware to extract and correlate business context
   * Should be applied after authentication middleware
   */
  static businessContextMiddleware() {
    return (req, res, next) => {
      const businessContext = {};

      // Extract business entities from request
      if (req.params.slug) businessContext.articleSlug = req.params.slug;
      if (req.params.id) businessContext.entityId = req.params.id;
      if (req.body?.article?.tagList) businessContext.tags = req.body.article.tagList;
      if (req.query.tag) businessContext.filterTag = req.query.tag;
      if (req.query.author) businessContext.authorFilter = req.query.author;
      if (req.query.favorited) businessContext.favoritedBy = req.query.favorited;

      // Determine business operation
      const path = req.route?.path || req.path;
      const method = req.method;
      businessContext.operation = this.identifyBusinessOperation(method, path);

      // Add to tracing context
      tracingManager.addBusinessContext(businessContext);

      // Store for downstream use
      req.businessContext = businessContext;

      next();
    };
  }

  /**
   * Identify business operation from HTTP method and path
   * Maps technical endpoints to business operations
   */
  static identifyBusinessOperation(method, path) {
    const operationMap = {
      'POST /api/users': 'user.register',
      'POST /api/users/login': 'user.authenticate',
      'GET /api/user': 'user.get_profile',
      'PUT /api/user': 'user.update_profile',
      'POST /api/profiles/:username/follow': 'user.follow',
      'DELETE /api/profiles/:username/follow': 'user.unfollow',
      'GET /api/profiles/:username': 'user.get_public_profile',
      'GET /api/articles': 'article.list',
      'GET /api/articles/feed': 'article.get_feed',
      'POST /api/articles': 'article.create',
      'GET /api/articles/:slug': 'article.get',
      'PUT /api/articles/:slug': 'article.update',
      'DELETE /api/articles/:slug': 'article.delete',
      'POST /api/articles/:slug/favorite': 'article.favorite',
      'DELETE /api/articles/:slug/favorite': 'article.unfavorite',
      'GET /api/articles/:slug/comments': 'comment.list',
      'POST /api/articles/:slug/comments': 'comment.create',
      'DELETE /api/articles/:slug/comments/:id': 'comment.delete',
      'GET /api/tags': 'tag.list',
    };

    const key = `${method} ${path}`;
    return operationMap[key] || `${method.toLowerCase()}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
  }
}

/**
 * Generate unique request ID for correlation
 */
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

module.exports = RequestTracingMiddleware;