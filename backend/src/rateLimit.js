const { createMemoryLimiter } = require('./limiters/memory');
const { createRedisNaiveLimiter } = require('./limiters/redisNaive');
const { createRedisAtomicLimiter } = require('./limiters/redisAtomic');

const MODES = ['memory', 'redis-naive', 'redis'];

function buildLimiters({ redis, limit, windowMs, instance }) {
  const limiters = { memory: createMemoryLimiter({ limit, windowMs }) };
  if (redis) {
    limiters['redis-naive'] = createRedisNaiveLimiter({ redis, limit, windowMs });
    limiters.redis = createRedisAtomicLimiter({ redis, limit, windowMs, instance });
  }
  return limiters;
}

// Who is being limited: the API key if one is sent, otherwise the client IP
function clientKey(req) {
  return req.get('x-api-key') || req.ip;
}

function rateLimit({ limiters, mode, limit, windowMs, failOpen, allowModeOverride }) {
  return async (req, res, next) => {
    const requested = allowModeOverride && req.get('x-ratelimit-mode');
    const activeMode = MODES.includes(requested) ? requested : mode;
    const limiter = limiters[activeMode];
    res.set('X-RateLimit-Mode', activeMode);
    res.set('X-RateLimit-Limit', String(limit));

    if (!limiter) {
      return res.status(500).json({ error: `Rate limit mode "${activeMode}" needs REDIS_URL` });
    }

    // Separate keyspace per mode so the modes can be compared side by side
    const key = `${activeMode}:${clientKey(req)}`;
    let result;
    try {
      result = await limiter.consume(key);
    } catch (err) {
      // Redis unreachable: the central limiter is a dependency, so decide explicitly what happens
      console.error(`Rate limiter error (${activeMode}): ${err.message}`);
      res.set('X-RateLimit-Degraded', 'true');
      if (failOpen) return next();
      return res.status(503).json({ error: 'Rate limiter unavailable' });
    }

    res.set('X-RateLimit-Remaining', String(result.remaining));
    if (result.allowed && result.commit) {
      // Limiters that record the request only after it has been handled (redis-naive)
      res.on('finish', () => result.commit().catch((err) => console.error(`Rate limiter commit failed: ${err.message}`)));
    }
    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests', retryAfterSeconds: retryAfter, windowMs });
    }
    return next();
  };
}

module.exports = { rateLimit, buildLimiters, MODES };
