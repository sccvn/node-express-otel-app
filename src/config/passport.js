const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const mongoose = require('mongoose');
const User = mongoose.model('User');
const tracingManager = require('../telemetry/tracing');
const metricsManager = require('../telemetry/metrics');

/**
 * Enhanced Passport Configuration with Telemetry Integration
 * 
 * Implements local authentication strategy with comprehensive tracking
 * of authentication attempts, failures, and security events
 */

passport.use(new LocalStrategy({
  usernameField: 'user[email]',
  passwordField: 'user[password]'
}, async function (email, password, done) {
  await tracingManager.traceBusinessOperation(
    'auth.passport_verify',
    {
      'auth.strategy': 'local',
      'auth.email_provided': !!email,
      'auth.password_provided': !!password,
      'auth.email_domain': email ? email.split('@')[1] : 'unknown',
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        // Input validation
        if (!email) {
          span.setAttribute('auth.error', 'missing_email');
          return done(null, false, { errors: { 'email': "can't be blank" } });
        }

        if (!password) {
          span.setAttribute('auth.error', 'missing_password');
          return done(null, false, { errors: { 'password': "can't be blank" } });
        }

        // Find user by email with telemetry
        const user = await tracingManager.traceDatabaseOperation(
          'findOne',
          'users',
          { email: tracingManager.hashPII(email) },
          () => User.findOne({ email: email })
        );

        if (!user) {
          const duration = timer.end();

          // Record failed authentication attempt
          metricsManager.recordUserOperation('passport_auth', 'unknown', false, duration);

          span.setAttributes({
            'auth.result': 'user_not_found',
            'auth.email_hash': tracingManager.hashPII(email),
            'auth.duration_ms': duration,
            'security.event': 'login_attempt_unknown_email',
          });

          return done(null, false, {
            errors: { 'email or password': 'is invalid' }
          });
        }

        // Validate password with security tracking
        const isValidPassword = await user.validPassword(password);

        const duration = timer.end();

        if (!isValidPassword) {
          // Record failed password validation
          metricsManager.recordUserOperation('passport_auth', user._id.toString(), false, duration);

          span.setAttributes({
            'auth.result': 'invalid_password',
            'auth.user_id': user._id.toString(),
            'auth.username': user.username,
            'auth.duration_ms': duration,
            'security.event': 'login_attempt_invalid_password',
          });

          return done(null, false, {
            errors: { 'email or password': 'is invalid' }
          });
        }

        // Successful authentication
        metricsManager.recordUserOperation('passport_auth', user._id.toString(), true, duration);

        // Add user context to telemetry
        tracingManager.addUserContext(
          user._id.toString(),
          user.email,
          user.role || 'user'
        );

        span.setAttributes({
          'auth.result': 'success',
          'auth.user_id': user._id.toString(),
          'auth.username': user.username,
          'auth.duration_ms': duration,
          'auth.user_created_days_ago': Math.floor((Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
          'auth.user_last_login': user.lastLoginAt || 'never',
        });

        // Update last login timestamp (optional)
        try {
          user.lastLoginAt = new Date();
          await user.save();
        } catch (error) {
          // Don't fail authentication if we can't update last login
          console.warn('Failed to update last login:', error.message);
        }

        return done(null, user);

      } catch (error) {
        const duration = timer.end();

        // Record authentication system error
        metricsManager.recordUserOperation('passport_auth', 'system_error', false, duration);

        span.recordException(error);
        span.setAttributes({
          'auth.result': 'system_error',
          'auth.error_type': error.constructor.name,
          'auth.error_message': error.message,
          'auth.duration_ms': duration,
        });

        return done(error);
      }
    }
  );
}));

module.exports = passport;