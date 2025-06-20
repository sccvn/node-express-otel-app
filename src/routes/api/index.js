const router = require('express').Router();

// Import all API route modules
router.use('/users', require('./users'));
router.use('/profiles', require('./profiles'));
router.use('/articles', require('./articles'));
// router.use('/tags', require('./tags'));

// API health check with telemetry
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

module.exports = router;