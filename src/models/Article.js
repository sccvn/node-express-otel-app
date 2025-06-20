const mongoose = require('mongoose');
const uniqueValidator = require('mongoose-unique-validator');
const slug = require('slug');
const User = mongoose.model('User');
const tracingManager = require('../telemetry/tracing');
const metricsManager = require('../telemetry/metrics');

const ArticleSchema = new mongoose.Schema({
  slug: { type: String, lowercase: true, unique: true },
  title: String,
  description: String,
  body: String,
  favoritesCount: { type: Number, default: 0 },
  comments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Comment' }],
  tagList: [{ type: String }],
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

ArticleSchema.plugin(uniqueValidator, { message: 'is already taken' });

/**
 * Enhanced Article model with comprehensive telemetry integration
 * 
 * Business Metrics Tracked:
 * - Article creation and engagement patterns
 * - Tag usage and trending analysis
 * - Author productivity metrics
 * - Content performance indicators
 */

/**
 * Pre-validate middleware for slug generation with telemetry
 */
ArticleSchema.pre('validate', function (next) {
  if (!this.slug) {
    this.slugify();
  }
  next();
});

/**
 * Generate URL-friendly slug with collision handling
 */
ArticleSchema.methods.slugify = function () {
  return tracingManager.traceBusinessOperation(
    'article.generate_slug',
    {
      'article.title': this.title,
      'article.author_id': this.author?.toString(),
      'slug.operation': 'generate',
    },
    async (span) => {
      try {
        const baseSlug = slug(this.title, { lower: true });
        let uniqueSlug = baseSlug;
        let counter = 1;

        // Check for slug uniqueness with telemetry
        while (await this.constructor.findOne({ slug: uniqueSlug })) {
          uniqueSlug = `${baseSlug}-${counter}`;
          counter++;

          // Prevent infinite loops in edge cases
          if (counter > 100) {
            uniqueSlug = `${baseSlug}-${Date.now()}`;
            break;
          }
        }

        this.slug = uniqueSlug;

        span.setAttributes({
          'slug.base': baseSlug,
          'slug.final': uniqueSlug,
          'slug.collision_count': counter - 1,
          'slug.generation_attempts': counter,
        });

        return uniqueSlug;
      } catch (error) {
        span.recordException(error);
        // Fallback slug generation
        this.slug = `${slug(this.title, { lower: true })}-${Date.now()}`;
        throw error;
      }
    }
  );
};

/**
 * Update favorites count with atomic operations and telemetry
 */
ArticleSchema.methods.updateFavoriteCount = function () {
  return tracingManager.traceBusinessOperation(
    'article.update_favorite_count',
    {
      'article.id': this._id.toString(),
      'article.slug': this.slug,
      'favorites.current_count': this.favoritesCount,
    },
    async (span) => {
      return tracingManager.traceDatabaseOperation(
        'aggregate',
        'users',
        { favorites: this._id },
        async () => {
          const favoriteCount = await User.countDocuments({
            favorites: { $in: [this._id] }
          });

          const previousCount = this.favoritesCount;
          this.favoritesCount = favoriteCount;

          span.setAttributes({
            'favorites.previous_count': previousCount,
            'favorites.new_count': favoriteCount,
            'favorites.count_delta': favoriteCount - previousCount,
          });

          // Record engagement metrics
          if (favoriteCount !== previousCount) {
            metricsManager.recordArticleOperation(
              'favorite_count_update',
              this._id.toString(),
              this.author?.toString(),
              this.tagList
            );
          }

          return this.save();
        }
      );
    }
  );
};

/**
 * Generate article JSON with comprehensive context tracking
 */
ArticleSchema.methods.toJSONFor = function (user) {
  return tracingManager.traceBusinessOperation(
    'article.serialize',
    {
      'article.id': this._id.toString(),
      'article.slug': this.slug,
      'article.author_id': this.author?._id?.toString(),
      'serialization.viewer_id': user?._id?.toString() || 'anonymous',
      'serialization.type': 'article',
    },
    async (span) => {
      try {
        const articleJson = {
          slug: this.slug,
          title: this.title,
          description: this.description,
          body: this.body,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
          tagList: this.tagList,
          favorited: user ? user.isFavorite(this._id) : false,
          favoritesCount: this.favoritesCount,
          author: this.author.toProfileJSONFor ?
            await this.author.toProfileJSONFor(user) :
            { username: this.author.username }
        };

        span.setAttributes({
          'article.title_length': this.title?.length || 0,
          'article.body_length': this.body?.length || 0,
          'article.tag_count': this.tagList?.length || 0,
          'article.favorites_count': this.favoritesCount,
          'article.is_favorited': articleJson.favorited,
          'article.has_description': !!this.description,
          'serialization.output_size': JSON.stringify(articleJson).length,
        });

        return articleJson;
      } catch (error) {
        span.recordException(error);
        throw error;
      }
    }
  );
};

/**
 * Static method to find articles with comprehensive filtering and telemetry
 */
ArticleSchema.statics.findWithFilters = function (query = {}, options = {}) {
  return tracingManager.traceBusinessOperation(
    'article.find_with_filters',
    {
      'query.has_tag': !!query.tag,
      'query.has_author': !!query.author,
      'query.has_favorited': !!query.favorited,
      'query.limit': options.limit || 20,
      'query.offset': options.offset || 0,
    },
    async (span) => {
      return tracingManager.traceDatabaseOperation(
        'find',
        'articles',
        query,
        async () => {
          const timer = metricsManager.createTimer();

          // Build MongoDB query
          let mongoQuery = {};

          if (query.tag) {
            mongoQuery.tagList = { $in: [query.tag] };
          }

          if (query.author) {
            const author = await User.findOne({ username: query.author });
            if (author) {
              mongoQuery.author = author._id;
            } else {
              // Return empty result if author not found
              return { articles: [], articlesCount: 0 };
            }
          }

          if (query.favorited) {
            const favoriter = await User.findOne({ username: query.favorited });
            if (favoriter) {
              mongoQuery._id = { $in: favoriter.favorites };
            } else {
              return { articles: [], articlesCount: 0 };
            }
          }

          // Execute queries in parallel for performance
          const [articles, count] = await Promise.all([
            this.find(mongoQuery)
              .limit(Number(options.limit) || 20)
              .skip(Number(options.offset) || 0)
              .sort({ createdAt: 'desc' })
              .populate('author')
              .exec(),
            this.countDocuments(mongoQuery)
          ]);

          const duration = timer.end();

          // Record query performance metrics
          metricsManager.recordDatabaseOperation(
            'find_with_filters',
            'articles',
            duration,
            true,
            articles.length
          );

          span.setAttributes({
            'query.execution_time_ms': duration,
            'query.result_count': articles.length,
            'query.total_count': count,
            'query.mongodb_filter': JSON.stringify(mongoQuery),
            'query.performance.limit': options.limit || 20,
            'query.performance.offset': options.offset || 0,
          });

          return { articles, articlesCount: count };
        }
      );
    }
  );
};

/**
 * Get user's personalized feed with engagement tracking
 */
ArticleSchema.statics.getUserFeed = function (user, options = {}) {
  return tracingManager.traceBusinessOperation(
    'article.get_user_feed',
    {
      'user.id': user._id.toString(),
      'user.following_count': user.following?.length || 0,
      'feed.limit': options.limit || 20,
      'feed.offset': options.offset || 0,
    },
    async (span) => {
      return tracingManager.traceDatabaseOperation(
        'find',
        'articles',
        { feed_for_user: user._id },
        async () => {
          const timer = metricsManager.createTimer();

          // Get articles from followed users
          const articles = await this.find({
            author: { $in: user.following }
          })
            .limit(Number(options.limit) || 20)
            .skip(Number(options.offset) || 0)
            .populate('author')
            .sort({ createdAt: 'desc' })
            .exec();

          const count = await this.countDocuments({
            author: { $in: user.following }
          });

          const duration = timer.end();

          // Record feed performance metrics
          metricsManager.recordDatabaseOperation(
            'get_user_feed',
            'articles',
            duration,
            true,
            articles.length
          );

          span.setAttributes({
            'feed.execution_time_ms': duration,
            'feed.article_count': articles.length,
            'feed.total_available': count,
            'feed.following_authors': user.following.length,
            'feed.personalization': 'following_based',
          });

          return { articles, articlesCount: count };
        }
      );
    }
  );
};

/**
 * Pre-save middleware with comprehensive telemetry
 */
ArticleSchema.pre('save', function (next) {
  const timer = metricsManager.createTimer();
  const isNew = this.isNew;

  tracingManager.traceBusinessOperation(
    'article.save',
    {
      'article.id': this._id ? this._id.toString() : 'new',
      'article.slug': this.slug,
      'article.author_id': this.author?.toString(),
      'database.operation': isNew ? 'create' : 'update',
      'article.tag_count': this.tagList?.length || 0,
    },
    async (span) => {
      try {
        // Track content metrics for new articles
        if (isNew) {
          metricsManager.updateEntityCounts('articles', 1);
          metricsManager.recordArticleOperation(
            'create',
            this._id.toString(),
            this.author?.toString(),
            this.tagList
          );

          // Track tag usage for trending analysis
          if (this.tagList && this.tagList.length > 0) {
            this.tagList.forEach(tag => {
              metricsManager.recordArticleOperation(
                'tag_usage',
                this._id.toString(),
                this.author?.toString(),
                [tag]
              );
            });
          }
        }

        const duration = timer.end();

        span.setAttributes({
          'database.save_duration_ms': duration,
          'article.is_new': isNew,
          'article.title_length': this.title?.length || 0,
          'article.body_length': this.body?.length || 0,
          'content.has_description': !!this.description,
          'content.estimated_read_time': Math.ceil((this.body?.length || 0) / 200), // Words per minute
        });

        next();
      } catch (error) {
        if (isNew) {
          metricsManager.recordArticleOperation(
            'create',
            this._id.toString(),
            this.author?.toString(),
            this.tagList,
            null,
            false
          );
        }
        next(error);
      }
    }
  );
});

/**
 * Pre-remove middleware with cleanup telemetry
 */
ArticleSchema.pre('remove', function (next) {
  tracingManager.traceBusinessOperation(
    'article.remove',
    {
      'article.id': this._id.toString(),
      'article.slug': this.slug,
      'article.author_id': this.author?.toString(),
      'cleanup.comments_count': this.comments?.length || 0,
    },
    async (span) => {
      try {
        // Update entity counts
        metricsManager.updateEntityCounts('articles', -1);

        // Remove article from all user favorites
        await User.updateMany(
          { favorites: this._id },
          { $pull: { favorites: this._id } }
        );

        // Delete associated comments
        if (this.comments && this.comments.length > 0) {
          await mongoose.model('Comment').deleteMany({
            _id: { $in: this.comments }
          });
        }

        span.setAttributes({
          'cleanup.favorites_removed': true,
          'cleanup.comments_deleted': this.comments?.length || 0,
          'cleanup.success': true,
        });

        next();
      } catch (error) {
        span.recordException(error);
        next(error);
      }
    }
  );
});

module.exports = mongoose.model('Article', ArticleSchema);