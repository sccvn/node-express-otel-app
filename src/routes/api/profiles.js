const router = require('express').Router();
const mongoose = require('mongoose');
const User = mongoose.model('User');
const auth = require('../auth');
const tracingManager = require('../../telemetry/tracing');
const metricsManager = require('../../telemetry/metrics');
const RequestTracingMiddleware = require('../../telemetry/middleware/request-tracer');

// Apply business context middleware
router.use(RequestTracingMiddleware.businessContextMiddleware());

/**
 * GET /profiles/:username - Get user profile
 * 
 * Business Context: User discovery and social interaction
 * Key Metrics: Profile view patterns, user discovery effectiveness, social engagement
 */
router.get('/:username', auth.optional, async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'profile.get',
    {
      'profile.username': req.params.username,
      'viewer.authenticated': !!req.user,
      'viewer.id': req.user?.id,
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        // Find user by username with telemetry
        const user = await tracingManager.traceDatabaseOperation(
          'findOne',
          'users',
          { username: req.params.username },
          () => User.findOne({ username: req.params.username })
        );

        if (!user) {
          span.setAttribute('profile.found', false);
          return res.status(404).json({ errors: { profile: 'not found' } });
        }

        const duration = timer.end();

        // Record profile view metrics
        metricsManager.recordUserOperation(
          'profile_view',
          user._id.toString(),
          true,
          duration
        );

        // Check if viewer is following this profile
        const isFollowing = req.user ? req.user.isFollowing(user._id) : false;
        const isSelfView = req.user?.id === user._id.toString();

        span.setAttributes({
          'profile.found': true,
          'profile.user_id': user._id.toString(),
          'profile.has_bio': !!user.bio,
          'profile.has_custom_image': !!user.image,
          'profile.following_count': user.following?.length || 0,
          'social.is_following': isFollowing,
          'social.is_self_view': isSelfView,
          'query.execution_time_ms': duration,
        });

        // Track user discovery patterns
        if (!isSelfView && req.user) {
          span.setAttribute('social.discovery_type', isFollowing ? 'following_profile' : 'new_discovery');
        }

        return res.json({ profile: await user.toProfileJSONFor(req.user) });

      } catch (error) {
        const duration = timer.end();

        metricsManager.recordUserOperation(
          'profile_view',
          'unknown',
          false,
          duration
        );

        span.recordException(error);
        next(error);
      }
    }
  );
});

/**
 * POST /profiles/:username/follow - Follow user
 * 
 * Business Context: Social network building and user engagement
 * Key Metrics: Follow conversion rates, network growth, social engagement patterns
 */
router.post('/:username/follow', auth.required, async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'user.follow',
    {
      'follower.id': req.user.id,
      'followee.username': req.params.username,
      'social.action': 'follow',
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        // Find user to follow
        const user = await tracingManager.traceDatabaseOperation(
          'findOne',
          'users',
          { username: req.params.username },
          () => User.findOne({ username: req.params.username })
        );

        if (!user) {
          span.setAttribute('followee.found', false);
          return res.status(404).json({ errors: { profile: 'not found' } });
        }

        // Prevent self-following
        if (user._id.toString() === req.user.id) {
          span.setAttributes({
            'social.error': 'self_follow_attempt',
            'followee.id': user._id.toString(),
          });
          return res.status(422).json({ errors: { profile: 'cannot follow yourself' } });
        }

        // Check if already following
        const alreadyFollowing = req.user.isFollowing(user._id);

        if (!alreadyFollowing) {
          // Follow the user
          await req.user.follow(user._id);

          // Record social network metrics
          metricsManager.recordUserOperation(
            'follow',
            req.user.id,
            true,
            timer.end()
          );
        }

        const duration = timer.end();

        span.setAttributes({
          'social.follow_success': true,
          'social.already_following': alreadyFollowing,
          'social.new_following_count': req.user.following.length + (alreadyFollowing ? 0 : 1),
          'followee.id': user._id.toString(),
          'social.action_duration_ms': duration,
          'network.growth': !alreadyFollowing,
        });

        // Track network growth patterns
        if (!alreadyFollowing) {
          span.setAttributes({
            'network.follower_growth_rate': await this.calculateGrowthRate(req.user.id, 'following'),
            'network.followee_popularity': await this.calculateUserPopularity(user._id),
          });
        }

        return res.json({ profile: await user.toProfileJSONFor(req.user) });

      } catch (error) {
        const duration = timer.end();

        metricsManager.recordUserOperation(
          'follow',
          req.user.id,
          false,
          duration
        );

        span.recordException(error);
        next(error);
      }
    }
  );
});

/**
 * DELETE /profiles/:username/follow - Unfollow user
 * 
 * Business Context: Social network dynamics and user engagement changes
 * Key Metrics: Unfollow patterns, network churn, relationship lifecycle
 */
router.delete('/:username/follow', auth.required, async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'user.unfollow',
    {
      'follower.id': req.user.id,
      'followee.username': req.params.username,
      'social.action': 'unfollow',
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        // Find user to unfollow
        const user = await tracingManager.traceDatabaseOperation(
          'findOne',
          'users',
          { username: req.params.username },
          () => User.findOne({ username: req.params.username })
        );

        if (!user) {
          span.setAttribute('followee.found', false);
          return res.status(404).json({ errors: { profile: 'not found' } });
        }

        // Check if currently following
        const currentlyFollowing = req.user.isFollowing(user._id);

        if (currentlyFollowing) {
          // Unfollow the user
          await req.user.unfollow(user._id);

          // Record social network metrics
          metricsManager.recordUserOperation(
            'unfollow',
            req.user.id,
            true,
            timer.end()
          );
        }

        const duration = timer.end();

        span.setAttributes({
          'social.unfollow_success': true,
          'social.was_following': currentlyFollowing,
          'social.new_following_count': req.user.following.length - (currentlyFollowing ? 1 : 0),
          'followee.id': user._id.toString(),
          'social.action_duration_ms': duration,
          'network.churn': currentlyFollowing,
        });

        // Track network churn patterns
        if (currentlyFollowing) {
          span.setAttributes({
            'network.churn_rate': await this.calculateChurnRate(req.user.id),
            'relationship.duration': await this.calculateRelationshipDuration(req.user.id, user._id),
          });
        }

        return res.json({ profile: await user.toProfileJSONFor(req.user) });

      } catch (error) {
        const duration = timer.end();

        metricsManager.recordUserOperation(
          'unfollow',
          req.user.id,
          false,
          duration
        );

        span.recordException(error);
        next(error);
      }
    }
  );
});

/**
 * Helper function to calculate user growth rate
 */
async function calculateGrowthRate(userId, metric) {
  try {
    // This would typically involve time-series analysis
    // For now, we'll provide a simplified calculation
    const user = await User.findById(userId);
    const followingCount = user.following?.length || 0;

    // Simple growth categorization
    if (followingCount > 100) return 'high';
    if (followingCount > 20) return 'medium';
    return 'low';
  } catch (error) {
    return 'unknown';
  }
}

/**
 * Helper function to calculate user popularity
 */
async function calculateUserPopularity(userId) {
  try {
    // Count how many users follow this user
    const followerCount = await User.countDocuments({
      following: { $in: [userId] }
    });

    if (followerCount > 1000) return 'celebrity';
    if (followerCount > 100) return 'popular';
    if (followerCount > 10) return 'known';
    return 'regular';
  } catch (error) {
    return 'unknown';
  }
}

/**
 * Helper function to calculate network churn rate
 */
async function calculateChurnRate(userId) {
  try {
    // This would involve historical follow/unfollow data
    // For now, return a placeholder calculation
    const user = await User.findById(userId);
    const followingCount = user.following?.length || 0;

    // Simplified churn estimation based on following count
    if (followingCount < 5) return 'high';
    if (followingCount < 20) return 'medium';
    return 'low';
  } catch (error) {
    return 'unknown';
  }
}

/**
 * Helper function to calculate relationship duration
 */
async function calculateRelationshipDuration(followerId, followeeId) {
  try {
    // In a real implementation, this would query follow history
    // For now, return estimated duration based on user data
    return 'unknown'; // Would be calculated from follow timestamp
  } catch (error) {
    return 'unknown';
  }
}

module.exports = router;