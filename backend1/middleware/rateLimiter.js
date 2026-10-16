/**
 * CivicVision AI — Zero-Dependency Sliding-Window Rate Limiter
 *
 * Implements bounded rate limiting for sensitive or computationally intensive
 * microservice proxies (such as Tesseract OCR extraction).
 *
 * Security & Reliability:
 * - Keyed by authenticated citizen userId (or remote IP for fallback).
 * - Implements a sliding window timestamp buffer.
 * - Enforces Retry-After header and HTTP 429 Too Many Requests response.
 * - Includes automatic interval cleanup to prevent memory exhaustion.
 */

function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60 * 1000; // 1 minute default
  const max = options.max || 10; // 10 requests per minute default
  const message = options.message || "Rate limit exceeded. Please wait before requesting OCR extraction again.";
  const hits = new Map();

  // Periodic cleanup every 2 minutes
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits.entries()) {
      const valid = timestamps.filter(t => now - t < windowMs);
      if (valid.length === 0) {
        hits.delete(key);
      } else {
        hits.set(key, valid);
      }
    }
  }, 2 * 60 * 1000);
  if (interval.unref) interval.unref();

  const limiter = function rateLimiterMiddleware(req, res, next) {
    const key = (req.user && req.user.userId)
      ? `user_${req.user.userId}`
      : `ip_${req.ip || req.connection?.remoteAddress || "unknown"}`;

    const now = Date.now();
    const timestamps = hits.get(key) || [];
    const validTimestamps = timestamps.filter(t => now - t < windowMs);

    if (validTimestamps.length >= max) {
      const oldest = validTimestamps[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      res.setHeader("Retry-After", retryAfterSec);
      return res.status(429).json({
        error: true,
        success: false,
        message,
        retryAfter: retryAfterSec
      });
    }

    validTimestamps.push(now);
    hits.set(key, validTimestamps);
    next();
  };

  // Expose reset for testing
  limiter._hits = hits;
  limiter._reset = () => hits.clear();

  return limiter;
}

module.exports = {
  createRateLimiter,
  ocrRateLimiter: createRateLimiter({
    windowMs: 60 * 1000,
    max: 10,
    message: "Rate limit exceeded. Please wait before requesting OCR extraction again."
  })
};
