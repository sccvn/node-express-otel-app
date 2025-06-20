const { trace, context, SpanStatusCode, SpanKind } = require('@opentelemetry/api');
const { SemanticAttributes } = require('@opentelemetry/semantic-conventions');

/**
 * Production-ready tracing utilities for the RealWorld application
 *
 * Design Philosophy:
 * - Minimal performance overhead through efficient span creation
 * - Rich contextual information for debugging and monitoring
 * - Consistent span naming and attribute conventions
 */
class TracingManager {
  constructor() {
    this.tracer = trace.getTracer('realworld-api', '1.0.0');
  }

  /**
   * Create a business logic span with standardized attributes
   * Used for tracking business operations like user authentication, article creation
   *
   * @param {string} operationName - Business operation name (e.g., 'user.authenticate')
   * @param {Object} attributes - Business-specific attributes
   * @param {Function} operation - Async operation to trace
   */
  async traceBusinessOperation(operationName, attributes = {}, operation) {
    return this.tracer.startActiveSpan(
      operationName,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          'operation.type': 'business_logic',
          'service.operation': operationName,
          ...attributes,
        },
      },
      async (span) => {
        try {
          const result = await operation(span);

          // Add result metadata to span
          if (result && typeof result === 'object') {
            if (result.id) span.setAttribute('entity.id', result.id);
            if (result.type) span.setAttribute('entity.type', result.type);
          }

          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          // Comprehensive error tracking
          span.recordException(error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
          });
          span.setAttributes({
            'error.type': error.constructor.name,
            'error.message': error.message,
            'error.stack': error.stack,
          });
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  /**
   * Create a database operation span with query details
   * Provides deep visibility into database performance
   *
   * @param {string} operation - Database operation (find, create, update, delete)
   * @param {string} collection - MongoDB collection name
   * @param {Object} query - Query details (sanitized)
   * @param {Function} dbOperation - Database operation function
   */
  async traceDatabaseOperation(operation, collection, query, dbOperation) {
    return this.tracer.startActiveSpan(
      `db.${collection}.${operation}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          [SemanticAttributes.DB_SYSTEM]: 'mongodb',
          [SemanticAttributes.DB_NAME]: process.env.MONGODB_URI?.split('/').pop() || 'conduit',
          [SemanticAttributes.DB_COLLECTION_NAME]: collection,
          [SemanticAttributes.DB_OPERATION]: operation,
          'db.query.type': operation,
          // Sanitize query for security - remove sensitive data
          'db.query.summary': this.sanitizeQuery(query),
        },
      },
      async (span) => {
        const startTime = Date.now();
        try {
          const result = await dbOperation();

          // Add performance metrics
          span.setAttributes({
            'db.query.duration_ms': Date.now() - startTime,
            'db.result.count': Array.isArray(result) ? result.length : (result ? 1 : 0),
          });

          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.recordException(error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
          });
          span.setAttributes({
            'db.error.code': error.code,
            'db.error.type': error.constructor.name,
          });
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  /**
   * Create an external API call span
   * Tracks outbound HTTP requests and their performance
   */
  async traceExternalCall(service, endpoint, method, operation) {
    return this.tracer.startActiveSpan(
      `external.${service}.${method.toLowerCase()}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          [SemanticAttributes.HTTP_METHOD]: method,
          [SemanticAttributes.HTTP_URL]: endpoint,
          'external.service.name': service,
          'external.service.type': 'http',
        },
      },
      async (span) => {
        try {
          const result = await operation();

          if (result && result.status) {
            span.setAttributes({
              [SemanticAttributes.HTTP_STATUS_CODE]: result.status,
              'http.response.size': result.data ? JSON.stringify(result.data).length : 0,
            });
          }

          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.recordException(error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
          });
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  /**
   * Add user context to current span
   * Enriches traces with user information for debugging
   */
  addUserContext(userId, userEmail, userRole) {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.setAttributes({
        'user.id': userId,
        'user.email': userEmail ? this.hashPII(userEmail) : undefined,
        'user.role': userRole,
        'enduser.id': userId, // OpenTelemetry semantic convention
      });
    }
  }

  /**
   * Add business context to spans
   * Provides domain-specific context for better observability
   */
  addBusinessContext(context) {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan && context) {
      const businessAttributes = {};

      // Map business context to span attributes
      if (context.articleId) businessAttributes['article.id'] = context.articleId;
      if (context.articleSlug) businessAttributes['article.slug'] = context.articleSlug;
      if (context.commentId) businessAttributes['comment.id'] = context.commentId;
      if (context.tagName) businessAttributes['tag.name'] = context.tagName;
      if (context.operation) businessAttributes['business.operation'] = context.operation;

      activeSpan.setAttributes(businessAttributes);
    }
  }

  /**
   * Sanitize database queries to remove sensitive information
   * Prevents PII leakage in telemetry data
   */
  sanitizeQuery(query) {
    if (!query || typeof query !== 'object') return String(query);

    const sanitized = { ...query };

    // Remove common sensitive fields
    const sensitiveFields = ['password', 'token', 'secret', 'key', 'email'];
    sensitiveFields.forEach(field => {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    });

    return JSON.stringify(sanitized);
  }

  /**
   * Hash PII data for correlation while maintaining privacy
   */
  hashPII(data) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  }

  /**
   * Get current trace context for manual correlation
   */
  getCurrentTraceContext() {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      const spanContext = activeSpan.spanContext();
      return {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        traceFlags: spanContext.traceFlags,
      };
    }
    return null;
  }
}

module.exports = new TracingManager();
