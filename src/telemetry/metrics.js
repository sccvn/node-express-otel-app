const { metrics } = require('@opentelemetry/api');
const { MeterProvider } = require('@opentelemetry/sdk-metrics');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

/**
 * Business metrics collection for the RealWorld application
 *
 * Design Principles:
 * - Collect metrics that directly correlate to business value
 * - Use appropriate metric types for different use cases
 * - Implement cardinality controls to prevent metric explosion
 * - Provide actionable insights for both technical and business stakeholders
 */
class MetricsManager {
  constructor() {
    // Get the global meter for consistent metric collection
    this.meter = metrics.getMeter('realworld-api', '1.0.0');

    this.initializeMetrics();
  }

  /**
   * Initialize all custom metrics with appropriate types and descriptions
   * Metric selection based on RealWorld application's core business operations
   */
  initializeMetrics() {
    // Business Operation Counters
    // Track frequency of core business operations
    this.userOperationsCounter = this.meter.createCounter('user_operations_total', {
      description: 'Total number of user operations (registration, login, profile updates)',
      unit: '1',
    });

    this.articleOperationsCounter = this.meter.createCounter('article_operations_total', {
      description: 'Total number of article operations (create, update, delete, view)',
      unit: '1',
    });

    this.commentOperationsCounter = this.meter.createCounter('comment_operations_total', {
      description: 'Total number of comment operations (create, delete)',
      unit: '1',
    });

    // Performance Histograms
    // Track latency distributions for performance monitoring
    this.authenticationLatency = this.meter.createHistogram('authentication_duration_ms', {
      description: 'Time taken for user authentication operations',
      unit: 'ms',
      // Custom buckets optimized for authentication latency patterns
      boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    });

    this.databaseOperationLatency = this.meter.createHistogram('database_operation_duration_ms', {
      description: 'Time taken for database operations',
      unit: 'ms',
      boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
    });

    this.apiRequestLatency = this.meter.createHistogram('api_request_duration_ms', {
      description: 'API request processing time',
      unit: 'ms',
      boundaries: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
    });

    // Business Gauges
    // Track current state of business entities
    this.activeUsersGauge = this.meter.createUpDownCounter('active_users_count', {
      description: 'Number of currently active users',
      unit: '1',
    });

    this.articlesGauge = this.meter.createUpDownCounter('articles_count', {
      description: 'Total number of articles in the system',
      unit: '1',
    });

    // Error Tracking
    this.errorCounter = this.meter.createCounter('errors_total', {
      description: 'Total number of errors by type and endpoint',
      unit: '1',
    });

    // Security Metrics
    this.securityEventsCounter = this.meter.createCounter('security_events_total', {
      description: 'Security-related events (failed logins, unauthorized access)',
      unit: '1',
    });

    // Resource Utilization
    this.memoryUsageGauge = this.meter.createObservableGauge('memory_usage_bytes', {
      description: 'Current memory usage',
      unit: 'bytes',
    });

    // Register callback for memory usage
    this.memoryUsageGauge.addCallback((result) => {
      const memUsage = process.memoryUsage();
      result.observe(memUsage.heapUsed, {
        memory_type: 'heap_used',
      });
      result.observe(memUsage.heapTotal, {
        memory_type: 'heap_total',
      });
      result.observe(memUsage.rss, {
        memory_type: 'rss',
      });
    });
  }

  /**
   * Record user operation metrics
   * Tracks user engagement and authentication patterns
   */
  recordUserOperation(operation, userId, success = true, duration = null) {
    const attributes = {
      operation_type: operation, // 'register', 'login', 'update_profile', 'follow', 'unfollow'
      success: success.toString(),
      user_type: this.getUserType(userId),
    };

    this.userOperationsCounter.add(1, attributes);

    // Record authentication latency for login operations
    if (operation === 'login' && duration !== null) {
      this.authenticationLatency.record(duration, {
        operation: 'login',
        success: success.toString(),
      });
    }

    // Track security events for failed operations
    if (!success && ['login', 'register'].includes(operation)) {
      this.securityEventsCounter.add(1, {
        event_type: `failed_${operation}`,
        severity: 'medium',
      });
    }
  }

  /**
   * Record article-related metrics
   * Tracks content creation and engagement patterns
   */
  recordArticleOperation(operation, articleId, userId, tags = [], duration = null) {
    const attributes = {
      operation_type: operation, // 'create', 'update', 'delete', 'view', 'favorite', 'unfavorite'
      has_tags: tags.length > 0 ? 'true' : 'false',
      tag_count: tags.length.toString(),
      user_type: this.getUserType(userId),
    };

    this.articleOperationsCounter.add(1, attributes);

    // Record performance metrics
    if (duration !== null) {
      this.databaseOperationLatency.record(duration, {
        operation: `article_${operation}`,
        collection: 'articles',
      });
    }

    // Track popular tags (with cardinality control)
    if (tags.length > 0 && operation === 'create') {
      tags.slice(0, 3).forEach(tag => { // Limit to top 3 tags to control cardinality
        this.articleOperationsCounter.add(1, {
          operation_type: 'tag_usage',
          tag_name: this.sanitizeTagName(tag),
        });
      });
    }
  }

  /**
   * Record comment operation metrics
   * Tracks user engagement through comments
   */
  recordCommentOperation(operation, commentId, articleId, userId, duration = null) {
    const attributes = {
      operation_type: operation, // 'create', 'delete'
      user_type: this.getUserType(userId),
    };

    this.commentOperationsCounter.add(1, attributes);

    if (duration !== null) {
      this.databaseOperationLatency.record(duration, {
        operation: `comment_${operation}`,
        collection: 'comments',
      });
    }
  }

  /**
   * Record API request metrics with comprehensive context
   * Provides insights into API usage patterns and performance
   */
  recordApiRequest(method, endpoint, statusCode, duration, userId = null) {
    // Normalize endpoint to prevent cardinality explosion
    const normalizedEndpoint = this.normalizeEndpoint(endpoint);

    const attributes = {
      method: method.toUpperCase(),
      endpoint: normalizedEndpoint,
      status_code: statusCode.toString(),
      status_class: `${Math.floor(statusCode / 100)}xx`,
      authenticated: userId ? 'true' : 'false',
    };

    // Record latency
    this.apiRequestLatency.record(duration, attributes);

    // Record errors
    if (statusCode >= 400) {
      this.errorCounter.add(1, {
        ...attributes,
        error_type: statusCode >= 500 ? 'server_error' : 'client_error',
      });
    }
  }

  /**
   * Record database operation performance
   * Tracks database health and query performance
   */
  recordDatabaseOperation(operation, collection, duration, success = true, recordCount = null) {
    const attributes = {
      operation: operation, // 'find', 'create', 'update', 'delete', 'aggregate'
      collection: collection,
      success: success.toString(),
    };

    this.databaseOperationLatency.record(duration, attributes);

    if (recordCount !== null) {
      attributes.record_count_range = this.getRecordCountRange(recordCount);
    }

    if (!success) {
      this.errorCounter.add(1, {
        ...attributes,
        error_type: 'database_error',
      });
    }
  }

  /**
   * Update business entity counts
   * Tracks system growth and usage patterns
   */
  updateEntityCounts(entityType, delta) {
    switch (entityType) {
      case 'users':
        this.activeUsersGauge.add(delta);
        break;
      case 'articles':
        this.articlesGauge.add(delta);
        break;
    }
  }

  /**
   * Helper Methods for Metric Enrichment
   */

  /**
   * Determine user type for segmentation
   * Enables analysis by user cohorts
   */
  getUserType(userId) {
    if (!userId) return 'anonymous';

    // Simple heuristic - in production, this could be based on user data
    const hash = userId.toString().charCodeAt(0);
    if (hash % 10 === 0) return 'premium';
    return 'standard';
  }

  /**
   * Normalize API endpoints to prevent cardinality explosion
   * Groups similar endpoints while maintaining useful granularity
   */
  normalizeEndpoint(endpoint) {
    // Replace dynamic IDs with placeholders
    return endpoint
      .replace(/\/[0-9a-fA-F]{24}/g, '/:id') // MongoDB ObjectIds
      .replace(/\/\d+/g, '/:id') // Numeric IDs
      .replace(/\/[^\/]+@[^\/]+/g, '/:email') // Email addresses
      .replace(/\/[\w-]+$/g, '/:slug') // Article slugs
      .substring(0, 100); // Limit length
  }

  /**
   * Sanitize tag names to prevent cardinality issues
   */
  sanitizeTagName(tag) {
    return tag.toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .substring(0, 20);
  }

  /**
   * Categorize record counts for better aggregation
   */
  getRecordCountRange(count) {
    if (count === 0) return '0';
    if (count === 1) return '1';
    if (count <= 10) return '2-10';
    if (count <= 100) return '11-100';
    if (count <= 1000) return '101-1000';
    return '1000+';
  }

  /**
   * Create a custom timer for measuring operation duration
   */
  createTimer() {
    const start = Date.now();
    return {
      end: () => Date.now() - start,
    };
  }
}

module.exports = new MetricsManager();
