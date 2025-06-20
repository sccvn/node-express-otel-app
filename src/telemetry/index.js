const { NodeSDK } = require('@opentelemetry/sdk-node');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-otlp-http');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { WinstonInstrumentation } = require('@opentelemetry/instrumentation-winston');

/**
 * Initialize OpenTelemetry SDK with production-ready configuration
 * This must be called before any application code is imported
 *
 * Design Decision: Using NodeSDK for simplified configuration while maintaining
 * flexibility for custom instrumentation
 */
function initializeTelemetry() {
  // Create resource with comprehensive service identification
  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'realworld-api',
    [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version || '1.0.0',
    [SemanticResourceAttributes.SERVICE_NAMESPACE]: process.env.OTEL_SERVICE_NAMESPACE || 'conduit',
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
    [SemanticResourceAttributes.SERVICE_INSTANCE_ID]: process.env.HOSTNAME || require('os').hostname(),
    // Custom attributes for business context
    'service.team': 'backend-team',
    'service.component': 'api-server'
  });

  // Configure OTLP exporters with retry and batching
  const traceExporter = new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 'http://localhost:4318/v1/traces',
    headers: {
      'Authorization': process.env.OTEL_EXPORTER_OTLP_HEADERS || ''
    },
  });

  const metricExporter = new OTLPMetricExporter({
    url: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || 'http://localhost:4318/v1/metrics',
    headers: {
      'Authorization': process.env.OTEL_EXPORTER_OTLP_HEADERS || ''
    },
  });

  // Initialize SDK with comprehensive auto-instrumentation
  const sdk = new NodeSDK({
    resource,
    // Auto-instrumentation for common libraries - reduces manual work
    // while providing comprehensive coverage
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable problematic instrumentations if needed
        '@opentelemetry/instrumentation-fs': {
          enabled: false, // Can be noisy in production
        },
        // Enhanced HTTP instrumentation configuration
        '@opentelemetry/instrumentation-http': {
          enabled: true,
          ignoreIncomingRequestHook: (req) => {
            // Ignore health check endpoints to reduce noise
            return req.url?.includes('/health') || req.url?.includes('/metrics');
          },
          // Capture request/response headers for debugging
          requestHook: (span, request) => {
            span.setAttributes({
              'http.request.header.user-agent': request.headers['user-agent'],
              'http.request.header.content-type': request.headers['content-type'],
            });
          },
        },
        // Database instrumentation with query capture
        '@opentelemetry/instrumentation-mongoose': {
          enabled: true,
          // Capture MongoDB queries for performance analysis
          enhancedDatabaseReporting: true,
        },
      }),
      // Add Winston logging correlation
      new WinstonInstrumentation({
        enabled: true,
        // Inject trace context into log records
        logHook: (span, record) => {
          record['trace_id'] = span.spanContext().traceId;
          record['span_id'] = span.spanContext().spanId;
        },
      }),
    ],
    // Custom span processor with optimized batching
    spanProcessors: [
      new BatchSpanProcessor(traceExporter, {
        // Optimize for production throughput
        maxExportBatchSize: 512,
        exportTimeoutMillis: 30000,
        scheduledDelayMillis: 1000,
        // Prevent memory leaks under high load
        maxQueueSize: 2048,
      }),
    ],
    // Metric collection with appropriate intervals
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 30000, // 30 second intervals for production
      exportTimeoutMillis: 10000,
    }),
  });

  // Initialize the SDK
  sdk.start();

  // Graceful shutdown handling
  process.on('SIGTERM', async () => {
    try {
      await sdk.shutdown();
      console.log('OpenTelemetry SDK shut down successfully');
    } catch (error) {
      console.error('Error shutting down OpenTelemetry SDK', error);
    } finally {
      process.exit(0);
    }
  });

  return sdk;
}

module.exports = { initializeTelemetry };
