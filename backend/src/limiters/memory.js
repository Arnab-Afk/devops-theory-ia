// Sliding-window log kept in this process's memory.
// Correct for ONE instance, wrong for N replicas: each replica counts only the requests it sees,
// so behind a round-robin load balancer a client gets up to N x limit.
function createMemoryLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map(); // key -> sorted timestamps

  // Drop empty keys now and then so memory does not grow with every client ever seen
  const sweep = setInterval(() => {
    const cutoff = now() - windowMs;
    for (const [key, list] of hits) {
      if (!list.length || list[list.length - 1] <= cutoff) hits.delete(key);
    }
  }, windowMs);
  sweep.unref();

  return {
    name: 'memory',
    async consume(key) {
      const t = now();
      const list = (hits.get(key) || []).filter((ts) => ts > t - windowMs);
      if (list.length < limit) {
        list.push(t);
        hits.set(key, list);
        return { allowed: true, remaining: limit - list.length, retryAfterMs: 0 };
      }
      hits.set(key, list);
      return { allowed: false, remaining: 0, retryAfterMs: list[0] + windowMs - t };
    },
    close() {
      clearInterval(sweep);
    },
  };
}

module.exports = { createMemoryLimiter };
