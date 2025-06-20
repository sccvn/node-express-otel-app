const mongoose = require('mongoose');
const tracingManager = require('../telemetry/tracing');
const metricsManager = require('../telemetry/metrics');

const CommentSchema = new mongoose.Schema({
  body: String,
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  article: { type: mongoose.Schema.Types.ObjectId, ref: 'Article' },
}, { timestamps: true });

/**
 * Enhanced Comment model with engagement and moderation telemetry
 * 
 * Business Metrics Tracked:
 * - Comment engagement patterns
 * - User interaction frequency
 * - Content moderation indicators
 * - Discussion thread analytics
 */

/**
 * Generate comment JSON with context tracking
 */
CommentSchema.methods.toJSONFor = function (user) {
  return tracingManager.traceBusinessOperation(
    'comment.serialize',
    {
      'comment.id': this._id.toString(),
      'comment.author_id': this.author?._id?.toString(),
      'comment.article_id': this.article?.toString(),
      'serialization.viewer_id': user?._id?.toString() || 'anonymous',
      'serialization.type': 'comment',
    },
    async (span) => {
      try {
        const commentJson = {
          id: this._id,
          body: this.body,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
          author: this.author.toProfileJSONFor ?
            await this.author.toProfileJSONFor(user) :
            { username: this.author.username }
        };

        span.setAttributes({
          'comment.body_length': this.body?.length || 0,
          'comment.word_count': this.body ? this.body.split(' ').length : 0,
          'comment.is_recent': (Date.now() - this.createdAt.getTime()) < 3600000, // Less than 1 hour
          'serialization.viewer_is_author': user?._id?.toString() === this.author?._id?.toString(),
        });

        return commentJson;
      } catch (error) {
        span.recordException(error);
        throw error;
      }
    }
  );
};

/**
 * Static method to find comments for article with performance tracking
 */
CommentSchema.statics.findByArticle = function (articleId, options = {}) {
  return tracingManager.traceBusinessOperation(
    'comment.find_by_article',
    {
      'article.id': articleId.toString(),
      'query.limit': options.limit || 50,
      'query.sort': options.sort || 'createdAt',
    },
    async (span) => {
      return tracingManager.traceDatabaseOperation(
        'find',
        'comments',
        { article: articleId },
        async () => {
          const timer = metricsManager.createTimer();

          const comments = await this.find({ article: articleId })
            .populate('author')
            .sort({ createdAt: options.sort === 'desc' ? -1 : 1 })
            .limit(Number(options.limit) || 50)
            .exec();

          const duration = timer.end();

          // Record query performance
          metricsManager.recordDatabaseOperation(
            'find_by_article',
            'comments',
            duration,
            true,
            comments.length
          );

          span.setAttributes({
            'query.execution_time_ms': duration,
            'query.result_count': comments.length,
            'query.article_id': articleId.toString(),
            'engagement.comments_per_article': comments.length,
          });

          return comments;
        }
      );
    }
  );
};

/**
 * Analyze comment sentiment and content quality (placeholder for ML integration)
 */
CommentSchema.methods.analyzeContent = function () {
  return tracingManager.traceBusinessOperation(
    'comment.content_analysis',
    {
      'comment.id': this._id.toString(),
      'analysis.type': 'content_quality',
    },
    async (span) => {
      try {
        const analysis = {
          wordCount: this.body ? this.body.split(' ').length : 0,
          characterCount: this.body?.length || 0,
          hasQuestionMarks: (this.body?.match(/\?/g) || []).length,
          hasExclamationMarks: (this.body?.match(/!/g) || []).length,
          hasUrls: /https?:\/\/[^\s]+/.test(this.body || ''),
          estimatedReadingTime: Math.ceil((this.body?.length || 0) / 200), // Characters per minute
        };

        // Simple sentiment indicators
        const positiveWords = ['good', 'great', 'excellent', 'amazing', 'love', 'like'];
        const negativeWords = ['bad', 'terrible', 'awful', 'hate', 'dislike', 'horrible'];

        const bodyLower = (this.body || '').toLowerCase();
        analysis.positiveIndicators = positiveWords.filter(word => bodyLower.includes(word)).length;
        analysis.negativeIndicators = negativeWords.filter(word => bodyLower.includes(word)).length;

        span.setAttributes({
          'analysis.word_count': analysis.wordCount,
          'analysis.character_count': analysis.characterCount,
          'analysis.has_urls': analysis.hasUrls,
          'analysis.positive_indicators': analysis.positiveIndicators,
          'analysis.negative_indicators': analysis.negativeIndicators,
          'analysis.estimated_reading_time_seconds': analysis.estimatedReadingTime,
        });

        return analysis;
      } catch (error) {
        span.recordException(error);
        throw error;
      }
    }
  );
};

/**
 * Pre-save middleware with engagement tracking
 */
CommentSchema.pre('save', function (next) {
  const timer = metricsManager.createTimer();
  const isNew = this.isNew;

  tracingManager.traceBusinessOperation(
    'comment.save',
    {
      'comment.id': this._id ? this._id.toString() : 'new',
      'comment.author_id': this.author?.toString(),
      'comment.article_id': this.article?.toString(),
      'database.operation': isNew ? 'create' : 'update',
    },
    async (span) => {
      try {
        if (isNew) {
          // Record comment creation metrics
          metricsManager.recordCommentOperation(
            'create',
            this._id.toString(),
            this.article?.toString(),
            this.author?.toString()
          );

          // Analyze content for quality metrics
          const contentAnalysis = await this.analyzeContent();

          span.setAttributes({
            'content.word_count': contentAnalysis.wordCount,
            'content.quality_score': this.calculateQualityScore(contentAnalysis),
            'engagement.is_question': contentAnalysis.hasQuestionMarks > 0,
            'engagement.enthusiasm_level': contentAnalysis.hasExclamationMarks,
          });
        }

        const duration = timer.end();

        span.setAttributes({
          'database.save_duration_ms': duration,
          'comment.is_new': isNew,
          'comment.body_length': this.body?.length || 0,
        });

        next();
      } catch (error) {
        if (isNew) {
          metricsManager.recordCommentOperation(
            'create',
            this._id.toString(),
            this.article?.toString(),
            this.author?.toString(),
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
 * Calculate content quality score for analytics
 */
CommentSchema.methods.calculateQualityScore = function (analysis) {
  let score = 0;

  // Length-based scoring
  if (analysis.wordCount >= 10) score += 2;
  else if (analysis.wordCount >= 5) score += 1;

  // Engagement indicators
  if (analysis.hasQuestionMarks > 0) score += 1;
  if (analysis.positiveIndicators > 0) score += 1;
  if (analysis.negativeIndicators > 2) score -= 1; // Penalize excessive negativity
  if (analysis.hasUrls) score += 1; // Sharing resources

  return Math.max(0, Math.min(5, score)); // Scale 0-5
};

/**
 * Post-save middleware to update article's comment list
 */
CommentSchema.post('save', function () {
  if (this.isNew && this.article) {
    tracingManager.traceBusinessOperation(
      'comment.update_article_reference',
      {
        'comment.id': this._id.toString(),
        'article.id': this.article.toString(),
        'operation.type': 'add_comment_reference',
      },
      async (span) => {
        try {
          const Article = mongoose.model('Article');
          await Article.findByIdAndUpdate(
            this.article,
            { $addToSet: { comments: this._id } }
          );

          span.setAttributes({
            'article.comment_added': true,
            'article.id': this.article.toString(),
          });
        } catch (error) {
          span.recordException(error);
          console.error('Error updating article comments:', error);
        }
      }
    );
  }
});

/**
 * Pre-remove middleware with cleanup tracking
 */
CommentSchema.pre('remove', function (next) {
  tracingManager.traceBusinessOperation(
    'comment.remove',
    {
      'comment.id': this._id.toString(),
      'comment.author_id': this.author?.toString(),
      'comment.article_id': this.article?.toString(),
    },
    async (span) => {
      try {
        // Remove comment reference from article
        if (this.article) {
          const Article = mongoose.model('Article');
          await Article.findByIdAndUpdate(
            this.article,
            { $pull: { comments: this._id } }
          );
        }

        // Record deletion metrics
        metricsManager.recordCommentOperation(
          'delete',
          this._id.toString(),
          this.article?.toString(),
          this.author?.toString()
        );

        span.setAttributes({
          'cleanup.article_reference_removed': !!this.article,
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

module.exports = mongoose.model('Comment', CommentSchema);