// Initialize telemetry before any other imports
require('./telemetry').initializeTelemetry();

const app = require('./app');
const mongoose = require('mongoose');
const tracingManager = require('./telemetry/tracing');
const metricsManager = require('./telemetry/metrics');

// Server configuration with telemetry
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/conduit';

/**
 * Enhanced server startup with comprehensive telemetry integration
 * 
 * Features:
 * - Database connection monitoring
 * - Server startup metrics
 * - Graceful shutdown handling
 * - Health check registration
 * - Performance monitoring
 */

async function startServer() {
  await tracingManager.traceBusinessOperation(
    'server.startup',
    {
      'server.port': PORT,
      'server.environment': process.env.NODE_ENV || 'development',
      'startup.phase': 'initialization',
    },
    async (span) => {
      const startupTimer = metricsManager.createTimer();

      try {
        // Connect to MongoDB with telemetry
        console.log('Connecting to MongoDB...');

        await tracingManager.traceDatabaseOperation(
          'connect',
          'mongodb',
          { uri: MONGODB_URI.replace(/\/\/.*@/, '//***:***@') }, // Hide credentials
          async () => {
            const connectTimer = metricsManager.createTimer();

            await mongoose.connect(MONGODB_URI, {
              useNewUrlParser: true,
              useUnifiedTopology: true,
              // Connection pool settings for production
              maxPoolSize: 10,
              serverSelectionTimeoutMS: 5000,
              socketTimeoutMS: 45000,
              family: 4, // Use IPv4, skip trying IPv6
            });

            const connectDuration = connectTimer.end();

            span.setAttributes({
              'database.connection.duration_ms': connectDuration,
              'database.connection.pool_size': 10,
              'database.type': 'mongodb',
            });

            console.log(`MongoDB connected in ${connectDuration}ms`);
            return true;
          }
        );

        // Start HTTP server with telemetry
        const server = await new Promise((resolve, reject) => {
          const httpServer = app.listen(PORT, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve(httpServer);
            }
          });

          // Set server timeouts for production
          httpServer.timeout = 30000; // 30 second timeout
          httpServer.keepAliveTimeout = 61000; // Slightly longer than load balancer
          httpServer.headersTimeout = 62000; // Longer than keepAliveTimeout
        });

        const startupDuration = startupTimer.end();

        // Record startup metrics
        metricsManager.recordUserOperation('server_startup', 'system', true, startupDuration);

        span.setAttributes({
          'server.startup.duration_ms': startupDuration,
          'server.startup.success': true,
          'server.listen.port': PORT,
          'server.pid': process.pid,
        });

        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📊 Telemetry initialized for ${process.env.NODE_ENV || 'development'} environment`);
        console.log(`🔍 Trace endpoint: ${process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 'http://localhost:4318/v1/traces'}`);
        console.log(`📈 Metrics endpoint: ${process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || 'http://localhost:4318/v1/metrics'}`);

        // Setup graceful shutdown
        setupGracefulShutdown(server);

        return server;

      } catch (error) {
        const startupDuration = startupTimer.end();

        // Record startup failure
        metricsManager.recordUserOperation('server_startup', 'system', false, startupDuration);

        span.recordException(error);
        span.setAttributes({
          'server.startup.duration_ms': startupDuration,
          'server.startup.success': false,
          'server.startup.error': error.message,
        });

        console.error('❌ Server startup failed:', error);
        process.exit(1);
      }
    }
  );
}

/**
 * Setup graceful shutdown handling with telemetry
 */
function setupGracefulShutdown(server) {
  const shutdown = async (signal) => {
    console.log(`\n🛑 ${signal} received, starting graceful shutdown...`);

    await tracingManager.traceBusinessOperation(
      'server.shutdown',
      {
        'shutdown.signal': signal,
        'shutdown.type': 'graceful',
      },
      async (span) => {
        const shutdownTimer = metricsManager.createTimer();

        try {
          // Stop accepting new connections
          server.close(async () => {
            console.log('✅ HTTP server closed');

            // Close database connections
            await mongoose.connection.close();
            console.log('✅ Database connections closed');

            const shutdownDuration = shutdownTimer.end();

            span.setAttributes({
              'shutdown.duration_ms': shutdownDuration,
              'shutdown.success': true,
            });

            console.log(`✅ Graceful shutdown completed in ${shutdownDuration}ms`);
            process.exit(0);
          });

          // Force shutdown after timeout
          setTimeout(() => {
            console.error('❌ Forced shutdown after timeout');
            process.exit(1);
          }, 10000); // 10 second timeout

        } catch (error) {
          span.recordException(error);
          console.error('❌ Error during shutdown:', error);
          process.exit(1);
        }
      }
    );
  };

  // Handle shutdown signals
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught exceptions with telemetry
  process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);

    const span = require('@opentelemetry/api').trace.getActiveSpan();
    if (span) {
      span.recordException(error);
      span.setAttributes({
        'error.type': 'uncaught_exception',
        'error.fatal': true,
      });
    }

    process.exit(1);
  });

  // Handle unhandled promise rejections with telemetry
  process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);

    const span = require('@opentelemetry/api').trace.getActiveSpan();
    if (span) {
      span.recordException(new Error(`Unhandled Rejection: ${reason}`));
      span.setAttributes({
        'error.type': 'unhandled_rejection',
        'error.fatal': true,
      });
    }

    process.exit(1);
  });
}

// Start the server
startServer().catch((error) => {
  console.error('💥 Failed to start server:', error);
  process.exit(1);
});