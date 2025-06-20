/**
 * Production-ready OpenTelemetry configuration
 * 
 * Environment-based configuration for different deployment scenarios:
 * - Development: Local OTLP collector
 * - Staging: Centralized observability platform
 * - Production: High-performance, security-focused configuration
 */

const config = {
  secret: process.env.SECRET || 'your-secret-key',
  development: {
    // Local development configuration
    tracing: {
      endpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 'http://localhost:4318/v1/traces',
      headers: {},
      compression: 'none',
      timeout: 10000,
    },
    metrics: {
      endpoint: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || 'http://localhost:4318/v1/metrics',
      headers: {},
      exportInterval: 15000, // 15 seconds for development
      timeout: 10000,
    },
    logging: {
      level: 'debug',
      enableConsole: true,
      enableStructured: false,
    },
    sampling: {
      type: 'probabilistic',
      ratio: 1.0, // Sample everything in development
    },
    resource: {
      attributes: {
        'deployment.environment': 'development',
        'service.instance.id': require('os').hostname(),
      }
    }
  },

  staging: {
    // Staging environment configuration
    tracing: {
      endpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 'https://otlp-staging.company.com/v1/traces',
      headers: {
        'Authorization': `Bearer ${process.env.OTEL_AUTH_TOKEN}`,
        'X-Environment': 'staging',
      },
      compression: 'gzip',
      timeout: 30000,
    },
    metrics: {
      endpoint: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || 'https://otlp-staging.company.com/v1/metrics',
      headers: {
        'Authorization': `Bearer ${process.env.OTEL_AUTH_TOKEN}`,
        'X-Environment': 'staging',
      },
      exportInterval: 30000, // 30 seconds
      timeout: 30000,
    },
    logging: {
      level: 'info',
      enableConsole: false,
      enableStructured: true,
    },
    sampling: {
      type: 'probabilistic',
      ratio: 0.1, // 10% sampling in staging
    },
    resource: {
      attributes: {
        'deployment.environment': 'staging',
        'service.instance.id': process.env.HOSTNAME || require('os').hostname(),
        'k8s.pod.name': process.env.K8S_POD_NAME,
        'k8s.namespace.name': process.env.K8S_NAMESPACE,
      }
    }
  },

  production: {
    // Production environment configuration
    tracing: {
      endpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 'https://otlp.company.com/v1/traces',
      headers: {
        'Authorization': `Bearer ${process.env.OTEL_AUTH_TOKEN}`,
        'X-Environment': 'production',
        'X-API-Key': process.env.OBSERVABILITY_API_KEY,
      },
      compression: 'gzip',
      timeout: 30000,
      // Production-optimized batch settings
      batchTimeout: 2000,
      batchSize: 512,
      maxQueueSize: 2048,
    },
    metrics: {
      endpoint: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || 'https://otlp.company.com/v1/metrics',
      headers: {
        'Authorization': `Bearer ${process.env.OTEL_AUTH_TOKEN}`,
        'X-Environment': 'production',
        'X-API-Key': process.env.OBSERVABILITY_API_KEY,
      },
      exportInterval: 60000, // 1 minute for production efficiency
      timeout: 30000,
    },
    logging: {
      level: 'warn',
      enableConsole: false,
      enableStructured: true,
      enableAuditLog: true,
    },
    sampling: {
      type: 'adaptive', // Use tail-based sampling in production
      ratio: 0.01, // 1% head-based sampling
      errorSamplingRatio: 1.0, // Always sample errors
      slowRequestThreshold: 1000, // Sample requests > 1s
    },
    resource: {
      attributes: {
        'deployment.environment': 'production',
        'service.instance.id': process.env.HOSTNAME || require('os').hostname(),
        'k8s.pod.name': process.env.K8S_POD_NAME,
        'k8s.namespace.name': process.env.K8S_NAMESPACE,
        'k8s.cluster.name': process.env.K8S_CLUSTER_NAME,
        'cloud.provider': process.env.CLOUD_PROVIDER || 'aws',
        'cloud.region': process.env.AWS_REGION || process.env.CLOUD_REGION,
        'cloud.availability_zone': process.env.AWS_AVAILABILITY_ZONE,
      }
    },
    // Production security settings
    security: {
      enablePIIFiltering: true,
      enableSQLSanitization: true,
      maxAttributeLength: 256,
      sensitiveHeaders: ['authorization', 'cookie', 'x-api-key'],
    }
  }
};

/**
 * Get configuration for current environment
 */
function getConfig() {
  const env = process.env.NODE_ENV || 'development';
  const baseConfig = config[env] || config.development;

  // Merge with environment variables
  return {
    ...baseConfig,
    serviceName: process.env.OTEL_SERVICE_NAME || 'realworld-api',
    serviceVersion: process.env.npm_package_version || '1.0.0',
    serviceNamespace: process.env.OTEL_SERVICE_NAMESPACE || 'conduit',
  };
}

/**
 * Validate configuration for production deployment
 */
function validateProductionConfig(config) {
  const requiredEnvVars = [
    'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
    'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
    'OTEL_AUTH_TOKEN',
    'OBSERVABILITY_API_KEY',
  ];

  const missing = requiredEnvVars.filter(envVar => !process.env[envVar]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables for production telemetry: ${missing.join(', ')}`);
  }

  return true;
}

/**
 * Create sampling configuration based on environment
 */
function createSamplingConfig(config) {
  switch (config.sampling.type) {
    case 'probabilistic':
      return {
        type: 'probabilistic',
        ratio: config.sampling.ratio,
      };

    case 'adaptive':
      return {
        type: 'adaptive',
        baseRatio: config.sampling.ratio,
        errorRatio: config.sampling.errorSamplingRatio,
        slowRequestThreshold: config.sampling.slowRequestThreshold,
      };

    default:
      return {
        type: 'probabilistic',
        ratio: 0.1,
      };
  }
}

module.exports = {
  getConfig,
  validateProductionConfig,
  createSamplingConfig,
  config,
};