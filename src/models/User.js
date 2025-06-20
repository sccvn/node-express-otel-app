const mongoose = require('mongoose');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const secret = require('../config').secret;
const tracingManager = require('../telemetry/tracing');
const metricsManager = require('../telemetry/metrics');

const UserSchema = new mongoose.Schema({
  username: { type: String, lowercase: true, unique: true, required: true, index: true },
  email: { type: String, lowercase: true, unique: true, required: true, index: true },
  bio: String,
  image: String,
  favorites: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Article' }],
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  hash: String,
  salt: String,
}, { timestamps: true });

/**
 * Enhanced User model with comprehensive telemetry integration
 * 
 * Design Approach:
 * - Instrument all database operations with tracing
 * - Collect business metrics for user operations
 * - Maintain security through PII handling
 * - Provide performance insights for authentication flows
 */

/**
 * Generate JWT token with telemetry tracking
 */
UserSchema.methods.generateJWT = function () {
  return tracingManager.traceBusinessOperation(
    'user.generate_jwt',
    {
      'user.id': this._id.toString(),
      'user.username': this.username,
      'jwt.operation': 'generate',
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        const today = new Date();
        const exp = new Date(today);
        exp.setDate(today.getDate() + 60);

        const token = jwt.sign({
          id: this._id,
          username: this.username,
          exp: parseInt(exp.getTime() / 1000),
        }, secret);

        // Record success metrics
        const duration = timer.end();
        metricsManager.recordUserOperation('generate_token', this._id.toString(), true, duration);

        span.setAttributes({
          'jwt.expiration_days': 60,
          'jwt.generation_duration_ms': duration,
        });

        return token;
      } catch (error) {
        metricsManager.recordUserOperation('generate_token', this._id.toString(), false);
        throw error;
      }
    }
  );
};

/**
 * Password validation with security telemetry
 */
UserSchema.methods.validPassword = function (password) {
  return tracingManager.traceBusinessOperation(
    'user.validate_password',
    {
      'user.id': this._id.toString(),
      'auth.method': 'password',
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        const hash = crypto.pbkdf2Sync(password, this.salt, 10000, 512, 'sha512').toString('hex');
        const isValid = this.hash === hash;

        const duration = timer.end();

        // Record authentication metrics
        metricsManager.recordUserOperation('validate_password', this._id.toString(), isValid, duration);

        // Track security events
        if (!isValid) {
          span.setAttributes({
            'security.event': 'invalid_password',
            'security.user_id': this._id.toString(),
          });
        }

        span.setAttributes({
          'auth.validation_duration_ms': duration,
          'auth.success': isValid,
        });

        return isValid;
      } catch (error) {
        metricsManager.recordUserOperation('validate_password', this._id.toString(), false);
        throw error;
      }
    }
  );
};

/**
 * Set password with security tracking
 */
UserSchema.methods.setPassword = function (password) {
  return tracingManager.traceBusinessOperation(
    'user.set_password',
    {
      'user.id': this._id.toString(),
      'security.operation': 'password_change',
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        this.salt = crypto.randomBytes(16).toString('hex');
        this.hash = crypto.pbkdf2Sync(password, this.salt, 10000, 512, 'sha512').toString('hex');

        const duration = timer.end();
        metricsManager.recordUserOperation('set_password', this._id.toString(), true, duration);

        span.setAttributes({
          'security.password_strength': this.evaluatePasswordStrength(password),
          'crypto.hash_duration_ms': duration,
        });

      } catch (error) {
        metricsManager.recordUserOperation('set_password', this._id.toString(), false);
        throw error;
      }
    }
  );
};

/**
 * Follow user with relationship tracking
 */
UserSchema.methods.follow = function (id) {
  return tracingManager.traceBusinessOperation(
    'user.follow',
    {
      'user.follower_id': this._id.toString(),
      'user.followee_id': id.toString(),
      'social.action': 'follow',
    },
    async (span) => {
      return tracingManager.traceDatabaseOperation(
        'update',
        'users',
        { follower: this._id, followee: id },
        async () => {
          if (this.following.indexOf(id) === -1) {
            this.following.push(id);

            // Record social interaction metrics
            metricsManager.recordUserOperation('follow', this._id.toString(), true);

            span.setAttributes({
              'social.relationship_created': true,
              'social.following_count': this.following.length,
            });

            return this.save();
          }
          return this;
        }
      );
    }
  );
};

/**
 * Unfollow user with relationship tracking
 */
UserSchema.methods.unfollow = function (id) {
  return tracingManager.traceBusinessOperation(
    'user.unfollow',
    {
      'user.follower_id': this._id.toString(),
      'user.followee_id': id.toString(),
      'social.action': 'unfollow',
    },
    async (span) => {
      return tracingManager.traceDatabaseOperation(
        'update',
        'users',
        { follower: this._id, followee: id },
        async () => {
          const index = this.following.indexOf(id);
          if (index !== -1) {
            this.following.splice(index, 1);

            // Record social interaction metrics
            metricsManager.recordUserOperation('unfollow', this._id.toString(), true);

            span.setAttributes({
              'social.relationship_removed': true,
              'social.following_count': this.following.length,
            });

            return this.save();
          }
          return this;
        }
      );
    }
  );
};

/**
 * Check if user is following another user
 */
UserSchema.methods.isFollowing = function (id) {
  return this.following.some(function (followId) {
    return followId.toString() === id.toString();
  });
};

/**
 * Favorite article with engagement tracking
 */
UserSchema.methods.favorite = function (id) {
  return tracingManager.traceBusinessOperation(
    'user.favorite_article',
    {
      'user.id': this._id.toString(),
      'article.id': id.toString(),
      'engagement.action': 'favorite',
    },
    async (span) => {
      return tracingManager.traceDatabaseOperation(
        'update',
        'users',
        { user: this._id, article: id },
        async () => {
          if (this.favorites.indexOf(id) === -1) {
            this.favorites.push(id);

            // Record engagement metrics
            metricsManager.recordArticleOperation('favorite', id.toString(), this._id.toString());

            span.setAttributes({
              'engagement.favorites_count': this.favorites.length,
              'engagement.action_result': 'added',
            });

            return this.save();
          }
          return this;
        }
      );
    }
  );
};

/**
 * Unfavorite article with engagement tracking
 */
UserSchema.methods.unfavorite = function (id) {
  return tracingManager.traceBusinessOperation(
    'user.unfavorite_article',
    {
      'user.id': this._id.toString(),
      'article.id': id.toString(),
      'engagement.action': 'unfavorite',
    },
    async (span) => {
      return tracingManager.traceDatabaseOperation(
        'update',
        'users',
        { user: this._id, article: id },
        async () => {
          const index = this.favorites.indexOf(id);
          if (index !== -1) {
            this.favorites.splice(index, 1);

            // Record engagement metrics
            metricsManager.recordArticleOperation('unfavorite', id.toString(), this._id.toString());

            span.setAttributes({
              'engagement.favorites_count': this.favorites.length,
              'engagement.action_result': 'removed',
            });

            return this.save();
          }
          return this;
        }
      );
    }
  );
};

/**
 * Check if user has favorited an article
 */
UserSchema.methods.isFavorite = function (id) {
  return this.favorites.some(function (favoriteId) {
    return favoriteId.toString() === id.toString();
  });
};

/**
 * Generate user profile JSON with privacy controls
 */
UserSchema.methods.toProfileJSONFor = function (user) {
  return tracingManager.traceBusinessOperation(
    'user.serialize_profile',
    {
      'user.profile_id': this._id.toString(),
      'user.viewer_id': user ? user._id.toString() : 'anonymous',
      'serialization.type': 'profile',
    },
    async (span) => {
      const profile = {
        username: this.username,
        bio: this.bio,
        image: this.image || 'https://static.productionready.io/images/smiley-cyrus.jpg',
        following: user ? user.isFollowing(this._id) : false
      };

      span.setAttributes({
        'profile.has_bio': !!this.bio,
        'profile.has_custom_image': !!this.image,
        'profile.is_following': profile.following,
      });

      return profile;
    }
  );
};

/**
 * Evaluate password strength for security metrics
 */
UserSchema.methods.evaluatePasswordStrength = function (password) {
  let score = 0;
  if (password.length >= 8) score += 1;
  if (/[A-Z]/.test(password)) score += 1;
  if (/[a-z]/.test(password)) score += 1;
  if (/[0-9]/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;

  if (score >= 4) return 'strong';
  if (score >= 3) return 'medium';
  return 'weak';
};

/**
 * Static method to find user with telemetry
 */
UserSchema.statics.findByEmail = function (email) {
  return tracingManager.traceDatabaseOperation(
    'findOne',
    'users',
    { email: email },
    () => this.findOne({ email: email })
  );
};

/**
 * Static method to find user by username with telemetry
 */
UserSchema.statics.findByUsername = function (username) {
  return tracingManager.traceDatabaseOperation(
    'findOne',
    'users',
    { username: username },
    () => this.findOne({ username: username })
  );
};

// Pre-save middleware with telemetry
UserSchema.pre('save', function (next) {
  const timer = metricsManager.createTimer();
  const isNew = this.isNew;

  tracingManager.traceBusinessOperation(
    'user.save',
    {
      'user.id': this._id ? this._id.toString() : 'new',
      'database.operation': isNew ? 'create' : 'update',
      'user.username': this.username,
    },
    async (span) => {
      try {
        // Update entity counts
        if (isNew) {
          metricsManager.updateEntityCounts('users', 1);
          metricsManager.recordUserOperation('register', this._id.toString(), true);
        }

        const duration = timer.end();
        span.setAttributes({
          'database.save_duration_ms': duration,
          'user.is_new': isNew,
        });

        next();
      } catch (error) {
        if (isNew) {
          metricsManager.recordUserOperation('register', this._id.toString(), false);
        }
        next(error);
      }
    }
  );
});

// Pre-remove middleware with telemetry
UserSchema.pre('remove', function (next) {
  metricsManager.updateEntityCounts('users', -1);
  next();
});

module.exports = mongoose.model('User', UserSchema);