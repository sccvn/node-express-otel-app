// CRITICAL: Initialize telemetry BEFORE any other imports
// This ensures auto-instrumentation captures all dependencies
const { initializeTelemetry } = require('./telemetry');
const sdk = initializeTelemetry();

const fs = require('fs');
const http = require('http');
const path = require('path');
const methods = require('methods');
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const cors = require('cors');
const passport = require('passport');
const errorhandler = require('errorhandler');
const mongoose = require('mongoose');

// Import telemetry components
const tracingManager = require('./telemetry/tracing');
const metricsManager = require('./telemetry/metrics');
const RequestTracingMiddleware = require('./telemetry/middleware/request-tracer');

const isProduction = process.env.NODE_ENV === 'production';

// Create global Express app
const app = express();

/**
 * Enhanced Express Configuration with Telemetry Integration
 * 
 * Design Philosophy:
 * - Telemetry middleware applied early for comprehensive coverage
 * - Performance monitoring for all key application components
 * - Business context propagation throughout request lifecycle
 * - Error correlation and tracking
 */

// Apply telemetry middleware FIRST for complete request coverage
app.use(RequestTracingMiddleware.createMiddleware());

// Standard Express middleware with telemetry-aware configuration
app.use(cors({
  credentials: true,
  origin: function (origin, callback) {
    // Enhanced CORS with telemetry tracking
    const span = tracingManager.getCurrentTraceContext();
    if (span) {
      const activeSpan = require('@opentelemetry/api').trace.getActiveSpan();
      if (activeSpan) {
        activeSpan.setAttributes({
          'cors.origin': origin || 'no-origin',
          'cors.credentials': true,
        });
      }
    }
    callback(null, true);
  }
}));

// Enhanced body parsing with size tracking
app.use(bodyParser.urlencoded({
  extended: false,
  limit: '50mb' // Reasonable limit to prevent abuse
}));
app.use(bodyParser.json({
  limit: '50mb',
  // Custom JSON parser with telemetry
  verify: function (req, res, buf, encoding) {
    const span = require('@opentelemetry/api').trace.getActiveSpan();
    if (span && buf) {
      span.setAttributes({
        'http.request.body.size_bytes': buf.length,
        'http.request.body.encoding': encoding,
      });
    }
  }
}));

// Session configuration with telemetry
app.use(session({
  secret: 'your-secret-key',
  cookie: { maxAge: 60000 },
  resave: false,
  saveUninitialized: false,
  // Custom session store callbacks for telemetry
  // The express-session middleware expects the store to be an instance of a session store class (like MemoryStore, connect - redis, etc.) that implements event emitters, including the.on() method.
  // store: {
  //   // In production, use Redis or similar with telemetry integration
  //   get: function (sid, callback) {
  //     // Add session lookup telemetry here
  //     callback(null, null);
  //   },
  //   set: function (sid, session, callback) {
  //     // Add session storage telemetry here
  //     callback();
  //   }
  // }
}));

app.use(passport.initialize());
app.use(passport.session());

// Health check endpoint with comprehensive system status
app.get('/health', async (req, res) => {
  await tracingManager.traceBusinessOperation(
    'system.health_check',
    {
      'health.check_type': 'http',
      'health.endpoint': '/health',
    },
    async (span) => {
      try {
        // Check database connectivity
        const dbHealthy = await tracingManager.traceDatabaseOperation(
          'ping',
          'health',
          {},
          async () => {
            const startTime = Date.now();
            try {
              await mongoose.connection.db.admin().ping();
              return { healthy: true, latency: Date.now() - startTime };
            } catch (error) {
              return { healthy: false, error: error.message };
            }
          }
        );

        // Get memory usage
        const memUsage = process.memoryUsage();

        // Get uptime
        const uptime = process.uptime();

        const healthStatus = {
          status: dbHealthy.healthy ? 'healthy' : 'unhealthy',
          timestamp: new Date().toISOString(),
          uptime: uptime,
          database: {
            status: dbHealthy.healthy ? 'connected' : 'disconnected',
            latency_ms: dbHealthy.latency || null,
            error: dbHealthy.error || null,
          },
          memory: {
            heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
            heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
            rss_mb: Math.round(memUsage.rss / 1024 / 1024),
          },
          environment: process.env.NODE_ENV,
          version: process.env.npm_package_version || '1.0.0',
        };

        span.setAttributes({
          'health.status': healthStatus.status,
          'health.database.healthy': dbHealthy.healthy,
          'health.database.latency_ms': dbHealthy.latency || 0,
          'health.memory.heap_used_mb': healthStatus.memory.heap_used_mb,
          'health.uptime_seconds': uptime,
        });

        res.status(dbHealthy.healthy ? 200 : 503).json(healthStatus);
      } catch (error) {
        span.recordException(error);
        res.status(503).json({
          status: 'error',
          error: error.message,
          timestamp: new Date().toISOString(),
        });
      }
    }
  );
});

// Metrics endpoint for Prometheus scraping
app.get('/metrics', (req, res) => {
  // This would typically export Prometheus format metrics
  // For now, we'll provide a simple JSON response
  res.json({
    message: 'Metrics available via OTLP endpoint',
    otlp_endpoint: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || 'http://localhost:4318/v1/metrics',
  });
});

// Load models with telemetry integration
if (!isProduction) {
  app.use(errorhandler());
}

// Enhanced model loading with telemetry
require('./models/User');
require('./models/Article');
require('./models/Comment');
require('./config/passport');

// Business context middleware applied after authentication
app.use(RequestTracingMiddleware.businessContextMiddleware());

// Route registration with telemetry tracking
app.use(require('./routes'));

// Enhanced error handling with telemetry correlation
app.use(function (err, req, res, next) {
  tracingManager.traceBusinessOperation(
    'error.global_handler',
    {
      'error.type': err.constructor.name,
      'error.message': err.message,
      'error.status': err.status || 500,
      'error.request_path': req.path,
      'error.request_method': req.method,
    },
    async (span) => {
      // Record error metrics
      metricsManager.recordApiRequest(
        req.method,
        req.route?.path || req.path,
        err.status || 500,
        Date.now() - (req.startTime || Date.now()),
        req.user?.id
      );

      // Add comprehensive error context
      span.recordException(err);
      span.setAttributes({
        'error.stack': err.stack,
        'error.user_id': req.user?.id || 'anonymous',
        'error.request_id': req.headers['x-request-id'],
        'error.trace_id': span.spanContext().traceId,
      });

      // Log structured error for external log aggregation
      console.error('Global error handler:', {
        error: err.message,
        stack: err.stack,
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        userId: req.user?.id,
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString(),
      });

      if (!res.headersSent) {
        if (err.status === 422) {
          return res.status(422).json({
            errors: Object.assign({
              body: err.message,
            }, err.errors)
          });
        }

        if (!isProduction) {
          return res.status(err.status || 500).json({
            errors: {
              message: err.message,
              error: err,
              traceId: span.spanContext().traceId,
            }
          });
        }

        return res.status(err.status || 500).json({
          errors: {
            message: isProduction ? 'Internal server error' : err.message,
            traceId: span.spanContext().traceId,
          }
        });
      }
    }
  );
});

// Graceful shutdown handling with telemetry cleanup
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, starting graceful shutdown...');

  try {
    // Close database connections
    await mongoose.connection.close();
    console.log('Database connections closed');

    // Shutdown telemetry (handled in telemetry/index.js)
    // SDK shutdown is already registered there

    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

module.exports = app;