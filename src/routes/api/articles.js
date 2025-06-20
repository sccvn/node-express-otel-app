const router = require('express').Router();
const mongoose = require('mongoose');
const Article = mongoose.model('Article');
const Comment = mongoose.model('Comment');
const User = mongoose.model('User');
const auth = require('../auth');
const tracingManager = require('../../telemetry/tracing');
const metricsManager = require('../../telemetry/metrics');
const RequestTracingMiddleware = require('../../telemetry/middleware/request-tracer');

// Apply business context middleware
router.use(RequestTracingMiddleware.businessContextMiddleware());

/**
 * GET /articles - List articles with comprehensive filtering and performance tracking
 * 
 * Business Context: Content discovery and browsing patterns
 * Key Metrics: Query performance, filter usage, pagination patterns
 */
router.get('/', auth.optional, async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'article.list',
    {
      'query.tag': req.query.tag,
      'query.author': req.query.author,
      'query.favorited': req.query.favorited,
      'query.limit': req.query.limit || 20,
      'query.offset': req.query.offset || 0,
      'user.authenticated': !!req.user,
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        const query = {};
        const options = {
          limit: Math.min(Number(req.query.limit) || 20, 100), // Cap at 100 for performance
          offset: Number(req.query.offset) || 0
        };

        // Build query filters with telemetry tracking
        if (req.query.tag) {
          query.tag = req.query.tag;
          span.setAttribute('filter.type', 'tag');
        }

        if (req.query.author) {
          query.author = req.query.author;
          span.setAttribute('filter.type', 'author');
        }

        if (req.query.favorited) {
          query.favorited = req.query.favorited;
          span.setAttribute('filter.type', 'favorited');
        }

        // Execute query with performance tracking
        const result = await Article.findWithFilters(query, options);

        // Serialize articles with user context
        const articlesPromises = result.articles.map(article =>
          article.toJSONFor(req.user)
        );
        const articles = await Promise.all(articlesPromises);

        const duration = timer.end();

        // Record comprehensive metrics
        metricsManager.recordApiRequest(
          req.method,
          req.route.path,
          200,
          duration,
          req.user?.id
        );

        span.setAttributes({
          'query.execution_time_ms': duration,
          'query.result_count': articles.length,
          'query.total_available': result.articlesCount,
          'query.pagination.limit': options.limit,
          'query.pagination.offset': options.offset,
          'query.filters_applied': Object.keys(query).length,
          'performance.serialization_time_ms': timer.end() - duration,
        });

        return res.json({
          articles: articles,
          articlesCount: result.articlesCount
        });

      } catch (error) {
        const duration = timer.end();

        metricsManager.recordApiRequest(
          req.method,
          req.route.path,
          500,
          duration,
          req.user.id
        );

        span.recordException(error);
        next(error);
      }
    }
  );
});

/**
 * POST /articles - Create new article
 * 
 * Business Context: Content creation and author productivity
 * Key Metrics: Creation success rate, content quality indicators, tag usage
 */
router.post('/', auth.required, async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'article.create',
    {
      'user.id': req.user.id,
      'article.has_tags': !!(req.body.article?.tagList?.length),
      'article.tag_count': req.body.article?.tagList?.length || 0,
      'content.title_length': req.body.article?.title?.length || 0,
      'content.body_length': req.body.article?.body?.length || 0,
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        const { body: { article } } = req;

        // Validate required fields
        if (!article) {
          span.setAttribute('validation.error', 'missing_article');
          return res.status(422).json({ errors: { article: "can't be blank" } });
        }

        if (!article.title) {
          span.setAttribute('validation.error', 'missing_title');
          return res.status(422).json({ errors: { title: "can't be blank" } });
        }

        if (!article.description) {
          span.setAttribute('validation.error', 'missing_description');
          return res.status(422).json({ errors: { description: "can't be blank" } });
        }

        if (!article.body) {
          span.setAttribute('validation.error', 'missing_body');
          return res.status(422).json({ errors: { body: "can't be blank" } });
        }

        // Create new article
        const finalArticle = new Article(article);
        finalArticle.author = req.user;

        // Generate slug with telemetry
        await finalArticle.slugify();

        // Save article with database telemetry
        const savedArticle = await tracingManager.traceDatabaseOperation(
          'create',
          'articles',
          {
            title: article.title,
            author: req.user.id,
            tags: article.tagList || [],
          },
          () => finalArticle.save()
        );

        // Populate author for response
        await savedArticle.populate('author');

        const duration = timer.end();

        // Record creation metrics
        metricsManager.recordArticleOperation(
          'create',
          savedArticle._id.toString(),
          req.user.id,
          savedArticle.tagList,
          duration
        );

        span.setAttributes({
          'article.creation_success': true,
          'article.creation_duration_ms': duration,
          'article.id': savedArticle._id.toString(),
          'article.slug': savedArticle.slug,
          'article.final_tag_count': savedArticle.tagList?.length || 0,
          'content.estimated_read_time': Math.ceil((savedArticle.body?.length || 0) / 200),
          'author.productivity': await this.calculateAuthorProductivity(req.user.id),
        });

        return res.json({ article: await savedArticle.toJSONFor(req.user) });

      } catch (error) {
        const duration = timer.end();

        // Handle specific errors
        if (error.code === 11000) {
          // Duplicate slug error
          span.setAttributes({
            'creation.error': 'duplicate_slug',
            'creation.error_code': error.code,
          });
          return res.status(422).json({
            errors: { slug: 'already exists' }
          });
        }

        metricsManager.recordArticleOperation(
          'create',
          'unknown',
          req.user.id,
          req.body.article?.tagList || [],
          duration
        );

        span.recordException(error);
        next(error);
      }
    }
  );
});

/**
 * GET /articles/:slug - Get single article
 * 
 * Business Context: Content consumption and engagement tracking
 * Key Metrics: View patterns, popular content identification, user engagement
 */
router.get('/:slug', auth.optional, async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'article.get_single',
    {
      'article.slug': req.params.slug,
      'user.authenticated': !!req.user,
      'user.id': req.user?.id,
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        // Find article with performance tracking
        const article = await tracingManager.traceDatabaseOperation(
          'findOne',
          'articles',
          { slug: req.params.slug },
          () => Article.findOne({ slug: req.params.slug }).populate('author')
        );

        if (!article) {
          span.setAttribute('article.found', false);
          return res.status(404).json({ errors: { article: 'not found' } });
        }

        const duration = timer.end();

        // Record view metrics
        metricsManager.recordArticleOperation(
          'view',
          article._id.toString(),
          req.user?.id,
          article.tagList,
          duration
        );

        // Track content engagement patterns
        span.setAttributes({
          'article.found': true,
          'article.id': article._id.toString(),
          'article.author_id': article.author._id.toString(),
          'article.tag_count': article.tagList?.length || 0,
          'article.favorites_count': article.favoritesCount,
          'article.age_days': Math.floor((Date.now() - article.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
          'query.execution_time_ms': duration,
          'engagement.viewer_is_author': req.user?.id === article.author._id.toString(),
        });

        // Check if this is a popular article (high favorites)
        if (article.favoritesCount > 10) {
          span.setAttribute('content.popularity', 'high');
        } else if (article.favoritesCount > 3) {
          span.setAttribute('content.popularity', 'medium');
        } else {
          span.setAttribute('content.popularity', 'low');
        }

        return res.json({ article: await article.toJSONFor(req.user) });

      } catch (error) {
        const duration = timer.end();

        metricsManager.recordApiRequest(
          req.method,
          req.route.path,
          500,
          duration,
          req.user?.id
        );

        span.recordException(error);
        next(error);
      }
    }
  );
});

/**
 * PUT /articles/:slug - Update article
 * 
 * Business Context: Content editing and maintenance patterns
 * Key Metrics: Edit frequency, content improvement tracking, author behavior
 */
router.put('/:slug', auth.required, async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'article.update',
    {
      'article.slug': req.params.slug,
      'user.id': req.user.id,
      'update.has_title': !!(req.body.article?.title),
      'update.has_description': !!(req.body.article?.description),
      'update.has_body': !!(req.body.article?.body),
      'update.has_tags': !!(req.body.article?.tagList),
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        // Find article with ownership verification
        const article = await tracingManager.traceDatabaseOperation(
          'findOne',
          'articles',
          { slug: req.params.slug, author: req.user.id },
          () => Article.findOne({ slug: req.params.slug }).populate('author')
        );

        if (!article) {
          span.setAttribute('article.found', false);
          return res.status(404).json({ errors: { article: 'not found' } });
        }

        // Verify ownership
        if (article.author._id.toString() !== req.user.id) {
          span.setAttributes({
            'authorization.error': 'not_owner',
            'article.actual_author': article.author._id.toString(),
            'request.user': req.user.id,
          });
          return res.status(403).json({ errors: { article: 'not authorized' } });
        }

        const { body: { article: updates } } = req;
        const changedFields = [];

        // Track what fields are being updated
        if (typeof updates.title !== 'undefined' && updates.title !== article.title) {
          article.title = updates.title;
          changedFields.push('title');
          await article.slugify(); // Regenerate slug if title changed
        }

        if (typeof updates.description !== 'undefined' && updates.description !== article.description) {
          article.description = updates.description;
          changedFields.push('description');
        }

        if (typeof updates.body !== 'undefined' && updates.body !== article.body) {
          const oldLength = article.body?.length || 0;
          const newLength = updates.body?.length || 0;
          article.body = updates.body;
          changedFields.push('body');

          span.setAttributes({
            'content.body_length_change': newLength - oldLength,
            'content.body_old_length': oldLength,
            'content.body_new_length': newLength,
          });
        }

        if (typeof updates.tagList !== 'undefined') {
          const oldTags = article.tagList || [];
          const newTags = updates.tagList || [];
          article.tagList = newTags;
          changedFields.push('tagList');

          span.setAttributes({
            'tags.old_count': oldTags.length,
            'tags.new_count': newTags.length,
            'tags.added': newTags.filter(tag => !oldTags.includes(tag)).length,
            'tags.removed': oldTags.filter(tag => !newTags.includes(tag)).length,
          });
        }

        // Save updated article
        const savedArticle = await tracingManager.traceDatabaseOperation(
          'update',
          'articles',
          { slug: req.params.slug },
          () => article.save()
        );

        const duration = timer.end();

        // Record update metrics
        metricsManager.recordArticleOperation(
          'update',
          savedArticle._id.toString(),
          req.user.id,
          savedArticle.tagList,
          duration
        );

        span.setAttributes({
          'article.update_success': true,
          'article.update_duration_ms': duration,
          'article.changed_fields': changedFields.join(','),
          'article.changed_fields_count': changedFields.length,
          'article.slug_changed': changedFields.includes('title'),
        });

        return res.json({ article: await savedArticle.toJSONFor(req.user) });

      } catch (error) {
        const duration = timer.end();

        metricsManager.recordArticleOperation(
          'update',
          'unknown',
          req.user.id,
          [],
          duration
        );

        span.recordException(error);
        next(error);
      }
    }
  );
});

/**
 * DELETE /articles/:slug - Delete article
 * 
 * Business Context: Content lifecycle and cleanup operations
 * Key Metrics: Deletion patterns, content retention, cleanup efficiency
 */
router.delete('/:slug', auth.required, async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'article.delete',
    {
      'article.slug': req.params.slug,
      'user.id': req.user.id,
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        // Find article with ownership verification
        const article = await tracingManager.traceDatabaseOperation(
          'findOne',
          'articles',
          { slug: req.params.slug, author: req.user.id },
          () => Article.findOne({ slug: req.params.slug }).populate('author')
        );

        if (!article) {
          span.setAttribute('article.found', false);
          return res.status(404).json({ errors: { article: 'not found' } });
        }

        // Verify ownership
        if (article.author._id.toString() !== req.user.id) {
          span.setAttributes({
            'authorization.error': 'not_owner',
            'article.actual_author': article.author._id.toString(),
            'request.user': req.user.id,
          });
          return res.status(403).json({ errors: { article: 'not authorized' } });
        }

        // Collect metrics before deletion
        const articleMetrics = {
          id: article._id.toString(),
          favoritesCount: article.favoritesCount,
          commentsCount: article.comments?.length || 0,
          tagCount: article.tagList?.length || 0,
          ageDays: Math.floor((Date.now() - article.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
        };

        // Delete article (triggers pre-remove middleware for cleanup)
        await tracingManager.traceDatabaseOperation(
          'remove',
          'articles',
          { slug: req.params.slug },
          () => article.remove()
        );

        const duration = timer.end();

        // Record deletion metrics
        metricsManager.recordArticleOperation(
          'delete',
          articleMetrics.id,
          req.user.id,
          article.tagList,
          duration
        );

        span.setAttributes({
          'article.deletion_success': true,
          'article.deletion_duration_ms': duration,
          'article.id': articleMetrics.id,
          'cleanup.favorites_count': articleMetrics.favoritesCount,
          'cleanup.comments_count': articleMetrics.commentsCount,
          'cleanup.tags_count': articleMetrics.tagCount,
          'article.lifetime_days': articleMetrics.ageDays,
        });

        return res.status(204).end();

      } catch (error) {
        const duration = timer.end();

        metricsManager.recordArticleOperation(
          'delete',
          'unknown',
          req.user.id,
          [],
          duration
        );

        span.recordException(error);
        next(error);
      }
    }
  );
});

/**
 * POST /articles/:slug/favorite - Favorite article
 * 
 * Business Context: User engagement and content preference tracking
 * Key Metrics: Engagement rates, popular content identification, user behavior
 */
router.post('/:slug/favorite', auth.required, async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'article.favorite',
    {
      'article.slug': req.params.slug,
      'user.id': req.user.id,
      'engagement.action': 'favorite',
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        // Find article
        const article = await tracingManager.traceDatabaseOperation(
          'findOne',
          'articles',
          { slug: req.params.slug },
          () => Article.findOne({ slug: req.params.slug }).populate('author')
        );

        if (!article) {
          span.setAttribute('article.found', false);
          return res.status(404).json({ errors: { article: 'not found' } });
        }

        // Check if already favorited
        const alreadyFavorited = req.user.isFavorite(article._id);

        if (!alreadyFavorited) {
          // Add to user's favorites
          await req.user.favorite(article._id);

          // Update article's favorite count
          await article.updateFavoriteCount();
        }

        const duration = timer.end();

        // Record engagement metrics
        metricsManager.recordArticleOperation(
          'favorite',
          article._id.toString(),
          req.user.id,
          article.tagList,
          duration
        );

        span.setAttributes({
          'article.id': article._id.toString(),
          'article.author_id': article.author._id.toString(),
          'engagement.already_favorited': alreadyFavorited,
          'engagement.new_favorites_count': article.favoritesCount + (alreadyFavorited ? 0 : 1),
          'engagement.duration_ms': duration,
          'engagement.cross_author': req.user.id !== article.author._id.toString(),
        });

        return res.json({ article: await article.toJSONFor(req.user) });

      } catch (error) {
        const duration = timer.end();

        metricsManager.recordArticleOperation(
          'favorite',
          'unknown',
          req.user.id,
          [],
          duration
        );

        span.recordException(error);
        next(error);
      }
    }
  );
});

/**
 * DELETE /articles/:slug/favorite - Unfavorite article
 * 
 * Business Context: User engagement and preference changes
 * Key Metrics: Engagement retention, content lifecycle, user behavior patterns
 */
router.delete('/:slug/favorite', auth.required, async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'article.unfavorite',
    {
      'article.slug': req.params.slug,
      'user.id': req.user.id,
      'engagement.action': 'unfavorite',
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        // Find article
        const article = await tracingManager.traceDatabaseOperation(
          'findOne',
          'articles',
          { slug: req.params.slug },
          () => Article.findOne({ slug: req.params.slug }).populate('author')
        );

        if (!article) {
          span.setAttribute('article.found', false);
          return res.status(404).json({ errors: { article: 'not found' } });
        }

        // Check if currently favorited
        const currentlyFavorited = req.user.isFavorite(article._id);

        if (currentlyFavorited) {
          // Remove from user's favorites
          await req.user.unfavorite(article._id);

          // Update article's favorite count
          await article.updateFavoriteCount();
        }

        const duration = timer.end();

        // Record engagement metrics
        metricsManager.recordArticleOperation(
          'unfavorite',
          article._id.toString(),
          req.user.id,
          article.tagList,
          duration
        );

        span.setAttributes({
          'article.id': article._id.toString(),
          'article.author_id': article.author._id.toString(),
          'engagement.was_favorited': currentlyFavorited,
          'engagement.new_favorites_count': article.favoritesCount - (currentlyFavorited ? 1 : 0),
          'engagement.duration_ms': duration,
        });

        return res.json({ article: await article.toJSONFor(req.user) });

      } catch (error) {
        const duration = timer.end();

        metricsManager.recordArticleOperation(
          'unfavorite',
          'unknown',
          req.user.id,
          [],
          duration
        );

        span.recordException(error);
        next(error);
      }
    }
  );
});

/**
 * GET /articles/:slug/comments - Get article comments
 * 
 * Business Context: Discussion engagement and community interaction
 * Key Metrics: Comment volume, discussion quality, engagement patterns
 */
router.get('/:slug/comments', auth.optional, async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'comment.list_for_article',
    {
      'article.slug': req.params.slug,
      'user.authenticated': !!req.user,
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        // Find article first
        const article = await tracingManager.traceDatabaseOperation(
          'findOne',
          'articles',
          { slug: req.params.slug },
          () => Article.findOne({ slug: req.params.slug })
        );

        if (!article) {
          span.setAttribute('article.found', false);
          return res.status(404).json({ errors: { article: 'not found' } });
        }

        // Get comments for article
        const comments = await Comment.findByArticle(article._id, {
          sort: 'createdAt',
          limit: 100 // Reasonable limit for comment display
        });

        // Serialize comments with user context
        const commentsPromises = comments.map(comment =>
          comment.toJSONFor(req.user)
        );
        const serializedComments = await Promise.all(commentsPromises);

        const duration = timer.end();

        span.setAttributes({
          'article.id': article._id.toString(),
          'comments.count': comments.length,
          'comments.query_duration_ms': duration,
          'discussion.engagement_level': this.calculateEngagementLevel(comments.length),
          'discussion.has_recent_activity': comments.some(c =>
            (Date.now() - c.createdAt.getTime()) < 24 * 60 * 60 * 1000
          ),
        });

        return res.json({ comments: serializedComments });

      } catch (error) {
        const duration = timer.end();

        metricsManager.recordApiRequest(
          req.method,
          req.route.path,
          500,
          duration,
          req.user?.id
        );

        span.recordException(error);
        next(error);
      }
    }
  );
});

/**
 * POST /articles/:slug/comments - Create comment
 * 
 * Business Context: User engagement and discussion participation
 * Key Metrics: Comment creation rate, discussion quality, user participation
 */
router.post('/:slug/comments', auth.required, async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'comment.create',
    {
      'article.slug': req.params.slug,
      'user.id': req.user.id,
      'comment.body_length': req.body.comment?.body?.length || 0,
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        const { body: { comment } } = req;

        // Validate comment body
        if (!comment || !comment.body) {
          span.setAttribute('validation.error', 'missing_comment_body');
          return res.status(422).json({ errors: { body: "can't be blank" } });
        }

        // Find article
        const article = await tracingManager.traceDatabaseOperation(
          'findOne',
          'articles',
          { slug: req.params.slug },
          () => Article.findOne({ slug: req.params.slug })
        );

        if (!article) {
          span.setAttribute('article.found', false);
          return res.status(404).json({ errors: { article: 'not found' } });
        }

        // Create comment
        const finalComment = new Comment(comment);
        finalComment.article = article;
        finalComment.author = req.user;

        // Save comment with telemetry
        const savedComment = await tracingManager.traceDatabaseOperation(
          'create',
          'comments',
          {
            article: article._id,
            author: req.user.id,
            body_length: comment.body.length,
          },
          () => finalComment.save()
        );

        // Populate author for response
        await savedComment.populate('author');

        const duration = timer.end();

        // Record comment creation metrics
        metricsManager.recordCommentOperation(
          'create',
          savedComment._id.toString(),
          article._id.toString(),
          req.user.id,
          duration
        );

        // Analyze comment content
        const contentAnalysis = await savedComment.analyzeContent();

        span.setAttributes({
          'comment.creation_success': true,
          'comment.creation_duration_ms': duration,
          'comment.id': savedComment._id.toString(),
          'comment.body_length': comment.body.length,
          'comment.word_count': contentAnalysis.wordCount,
          'comment.quality_score': savedComment.calculateQualityScore(contentAnalysis),
          'article.id': article._id.toString(),
          'engagement.author_commenting_on_own': req.user.id === article.author?.toString(),
        });

        return res.json({ comment: await savedComment.toJSONFor(req.user) });

      } catch (error) {
        const duration = timer.end();

        metricsManager.recordCommentOperation(
          'create',
          'unknown',
          'unknown',
          req.user.id,
          duration
        );

        span.recordException(error);
        next(error);
      }
    }
  );
});

/**
 * DELETE /articles/:slug/comments/:id - Delete comment
 * 
 * Business Context: Content moderation and user management
 * Key Metrics: Deletion patterns, moderation effectiveness, user behavior
 */
router.delete('/:slug/comments/:id', auth.required, async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'comment.delete',
    {
      'comment.id': req.params.id,
      'article.slug': req.params.slug,
      'user.id': req.user.id,
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        // Find comment with ownership verification
        const comment = await tracingManager.traceDatabaseOperation(
          'findById',
          'comments',
          { id: req.params.id },
          () => Comment.findById(req.params.id).populate('author')
        );

        if (!comment) {
          span.setAttribute('comment.found', false);
          return res.status(404).json({ errors: { comment: 'not found' } });
        }

        // Verify ownership (only comment author can delete)
        if (comment.author._id.toString() !== req.user.id) {
          span.setAttributes({
            'authorization.error': 'not_owner',
            'comment.actual_author': comment.author._id.toString(),
            'request.user': req.user.id,
          });
          return res.status(403).json({ errors: { comment: 'not authorized' } });
        }

        // Collect metrics before deletion
        const commentMetrics = {
          id: comment._id.toString(),
          bodyLength: comment.body?.length || 0,
          ageDays: Math.floor((Date.now() - comment.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
        };

        // Delete comment (triggers pre-remove middleware)
        await tracingManager.traceDatabaseOperation(
          'remove',
          'comments',
          { id: req.params.id },
          () => comment.remove()
        );

        const duration = timer.end();

        // Record deletion metrics
        metricsManager.recordCommentOperation(
          'delete',
          commentMetrics.id,
          comment.article?.toString(),
          req.user.id,
          duration
        );

        span.setAttributes({
          'comment.deletion_success': true,
          'comment.deletion_duration_ms': duration,
          'comment.body_length': commentMetrics.bodyLength,
          'comment.lifetime_days': commentMetrics.ageDays,
        });

        return res.status(204).end();

      } catch (error) {
        const duration = timer.end();

        metricsManager.recordCommentOperation(
          'delete',
          req.params.id,
          'unknown',
          req.user.id,
          duration
        );

        span.recordException(error);
        next(error);
      }
    }
  );
});

/**
 * Helper function to calculate author productivity
 */
async function calculateAuthorProductivity(authorId) {
  try {
    const recentArticles = await Article.countDocuments({
      author: authorId,
      createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } // Last 30 days
    });

    if (recentArticles >= 10) return 'high';
    if (recentArticles >= 3) return 'medium';
    return 'low';
  } catch (error) {
    return 'unknown';
  }
}

/**
 * Helper function to calculate discussion engagement level
 */
function calculateEngagementLevel(commentCount) {
  if (commentCount >= 20) return 'high';
  if (commentCount >= 5) return 'medium';
  if (commentCount >= 1) return 'low';
  return 'none';
}



/**
 * GET /articles/feed - Get personalized user feed
 * 
 * Business Context: Personalized content delivery and user engagement
 * Key Metrics: Feed performance, personalization effectiveness, user retention
 */
router.get('/feed', auth.required, async function (req, res, next) {
  await tracingManager.traceBusinessOperation(
    'article.get_feed',
    {
      'user.id': req.user.id,
      'user.following_count': req.user.following?.length || 0,
      'feed.limit': req.query.limit || 20,
      'feed.offset': req.query.offset || 0,
    },
    async (span) => {
      const timer = metricsManager.createTimer();

      try {
        const options = {
          limit: Math.min(Number(req.query.limit) || 20, 100),
          offset: Number(req.query.offset) || 0
        };

        // Get personalized feed
        const result = await Article.getUserFeed(req.user, options);

        // Serialize articles with user context
        const articlesPromises = result.articles.map(article =>
          article.toJSONFor(req.user)
        );
        const articles = await Promise.all(articlesPromises);

        const duration = timer.end();

        // Record feed performance metrics
        metricsManager.recordApiRequest(
          req.method,
          req.route.path,
          200,
          duration,
          req.user.id
        );

        span.setAttributes({
          'feed.execution_time_ms': duration,
          'feed.article_count': articles.length,
          'feed.total_available': result.articlesCount,
          'feed.personalization.following_count': req.user.following.length,
          'feed.engagement.has_content': articles.length > 0,
          'feed.performance.per_article_ms': articles.length > 0 ? duration / articles.length : 0,
        });

        // Track feed engagement patterns
        if (articles.length === 0 && req.user.following.length === 0) {
          span.setAttribute('feed.issue', 'no_following');
        } else if (articles.length === 0) {
          span.setAttribute('feed.issue', 'no_content_from_following');
        }

        return res.json({
          articles: articles,
          articlesCount: result.articlesCount
        });

      } catch (error) {
        const duration = timer.end();

        metricsManager.recordApiRequest(
          req.method,
          req.route.path,
          500,
          duration,
          req.user?.id
        );

        span.recordException(error);
        next(error);
      }
    }
  );
});

module.exports = router;