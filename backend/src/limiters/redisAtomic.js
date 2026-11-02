// Centralized sliding-window log in Redis, done atomically in one Lua script.
// - Atomic: Redis runs a script to completion before serving any other command, so
//   "trim, count, add" cannot interleave between replicas. No race, exactly `limit` per window.
// - One clock: the script uses Redis TIME, not each pod's clock, so clock skew between replicas does not matter.
// - Sliding window: no burst of 2 x limit at a fixed-window boundary.
const SCRIPT = `
local key    = KEYS[1]
local limit  = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local id     = ARGV[3]

local t   = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, now .. '-' .. id)
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {0, 0, tonumber(oldest[2]) + window - now}
`;

function createRedisAtomicLimiter({ redis, limit, windowMs, instance }) {
  // EVALSHA with automatic fallback to EVAL; the script is cached in Redis after the first call
  redis.defineCommand('slidingWindow', { numberOfKeys: 1, lua: SCRIPT });
  let seq = 0;

  return {
    name: 'redis',
    async consume(key) {
      // Unique member per request so two requests in the same millisecond are both counted
      const id = `${instance}-${process.pid}-${seq++}`;
      const [allowed, remaining, retryAfterMs] = await redis.slidingWindow(`rl:sw:${key}`, limit, windowMs, id);
      return { allowed: allowed === 1, remaining, retryAfterMs: Math.max(0, retryAfterMs) };
    },
  };
}

module.exports = { createRedisAtomicLimiter, SCRIPT };
