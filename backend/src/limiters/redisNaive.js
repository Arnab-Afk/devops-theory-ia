// Shared fixed-window counter in Redis, written the "obvious" way: check the count, handle the
// request, then record it (a common pattern, e.g. to count only requests that were actually served).
// Every replica now sees the same count, but check and increment are separate steps.
// Every request that arrives while others are still being handled reads the same old count
// (check-then-act race), so far more than `limit` requests get through under concurrency.
// Even with no work in between, a plain GET followed by INCR has the same race, just a narrower window.
function createRedisNaiveLimiter({ redis, limit, windowMs }) {
  return {
    name: 'redis-naive',
    async consume(key) {
      const window = Math.floor(Date.now() / windowMs);
      const redisKey = `rl:naive:${key}:${window}`;

      const current = Number(await redis.get(redisKey)) || 0;
      if (current >= limit) {
        return { allowed: false, remaining: 0, retryAfterMs: (window + 1) * windowMs - Date.now() };
      }
      return {
        allowed: true,
        remaining: Math.max(0, limit - current - 1),
        retryAfterMs: 0,
        // Called by the middleware once the response has been sent
        commit: async () => {
          const count = await redis.incr(redisKey);
          if (count === 1) await redis.pexpire(redisKey, windowMs);
        },
      };
    },
  };
}

module.exports = { createRedisNaiveLimiter };
