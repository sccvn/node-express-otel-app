const router = require('express').Router();

// Import route modules
router.use('/api', require('./api'));

module.exports = router;