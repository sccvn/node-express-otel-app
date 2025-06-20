/**
 * Application Configuration with Environment Support
 * 
 * Centralizes all configuration with proper environment variable handling
 * and sensible defaults for development
 */

const config = {
  // JWT Configuration
  secret: process.env.JWT_SECRET || 'conduit-secret-key-change-in-production',

  // Database Configuration
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/conduit',
    options: {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: parseInt(process.env.MONGODB_POOL_SIZE) || 10,
      serverSelectionTimeoutMS: parseInt(process.env.MONGODB_TIMEOUT) || 5000,
    }
  },

  // Server Configuration
  server: {
    port: parseInt(process.env.PORT) || 3000,
    host: process.env.HOST || '0.0.0.0',
    environment: process.env.NODE_ENV || 'development',
  },

  // Security Configuration
  security: {
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS) || 10,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '60d',
    corsOrigins: process.env.CORS_ORIGINS ?
      process.env.CORS_ORIGINS.split(',') :
      ['http://localhost:3000', 'http://localhost:4200'],
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
    rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  },

  // OpenTelemetry Configuration
  telemetry: {
    serviceName: process.env.OTEL_SERVICE_NAME || 'realworld-api',
    serviceVersion: process.env.OTEL_SERVICE_VERSION || '1.0.0',
    serviceNamespace: process.env.OTEL_SERVICE_NAMESPACE || 'conduit',
    tracesEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 'http://localhost:4318/v1/traces',
    metricsEndpoint: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || 'http://localhost:4318/v1/metrics',
    samplingRatio: parseFloat(process.env.OTEL_SAMPLING_RATIO) || 1.0,
  },

  // Application Features
  features: {
    enableUserRegistration: process.env.ENABLE_USER_REGISTRATION !== 'false',
    enableComments: process.env.ENABLE_COMMENTS !== 'false',
    enableFavorites: process.env.ENABLE_FAVORITES !== 'false',
    enableFollowing: process.env.ENABLE_FOLLOWING !== 'false',
    maxArticlesPerUser: parseInt(process.env.MAX_ARTICLES_PER_USER) || 1000,
    maxCommentsPerArticle: parseInt(process.env.MAX_COMMENTS_PER_ARTICLE) || 1000,
  },

  // Validation Rules
  validation: {
    username: {
      minLength: 3,
      maxLength: 20,
      pattern: /^[a-zA-Z0-9_-]+$/
    },
    password: {
      minLength: 6,
      maxLength: 100,
      requireUppercase: process.env.PASSWORD_REQUIRE_UPPERCASE === 'true',
      requireNumbers: process.env.PASSWORD_REQUIRE_NUMBERS === 'true',
      requireSpecialChars: process.env.PASSWORD_REQUIRE_SPECIAL === 'true',
    },
    email: {
      maxLength: 254,
      pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    },
    article: {
      titleMaxLength: 200,
      descriptionMaxLength: 500,
      bodyMaxLength: 50000,
      maxTags: 10,
      tagMaxLength: 50,
    },
    comment: {
      bodyMaxLength: 5000,
      minLength: 1,
    }
  }
};

// Validate required configuration in production
if (config.server.environment === 'production') {
  const requiredEnvVars = [
    'JWT_SECRET',
    'MONGODB_URI',
  ];

  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    console.error(`Missing required environment variables: ${missingVars.join(', ')}`);
    process.exit(1);
  }

  // Warn about default values in production
  if (config.secret === 'conduit-secret-key-change-in-production') {
    console.error('WARNING: Using default JWT secret in production!');
    process.exit(1);
  }
}

module.exports = config;