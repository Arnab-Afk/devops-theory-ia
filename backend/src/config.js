const os = require('os');

module.exports = {
  port: Number(process.env.PORT || 3000),
  // Name shown in X-Served-By so the demo can tell replicas apart (pod name in Kubernetes, container id in Compose)
  instance: process.env.INSTANCE_NAME || os.hostname(),
  redisUrl: process.env.REDIS_URL || '',
  // memory | redis-naive | redis
  mode: process.env.RATE_LIMIT_MODE || 'redis',
  limit: Number(process.env.RATE_LIMIT || 20),
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 10000),
  // If Redis is down: true = let requests through (availability), false = reject them (protection)
  failOpen: process.env.RATE_LIMIT_FAIL_OPEN !== 'false',
  // Simulated work per request in ms (like a database call), so requests overlap as in a real API
  workMs: Number(process.env.WORK_MS || 20),
  // Lets the dashboard pick a mode per request with the X-RateLimit-Mode header. Demo only.
  allowModeOverride: process.env.ALLOW_MODE_OVERRIDE === 'true',
};
