# Distributed Rate Limiting for Microservices using Redis

**Theory IA, DevOps.** Deploy multiple backend replicas, implement centralized rate limiting
using Redis, and demonstrate its behaviour under concurrent requests.

## 1. Problem

Rate limiting caps how many requests a client may make in a time window (here: **20 requests per
10 seconds per API key**). It protects services from overload and abuse, enforces fair use and
pricing tiers, and limits the damage of runaway clients or retry storms. Blocked requests receive
`429 Too Many Requests` with a `Retry-After` header (RFC 6585).

On a single server this is easy: keep a counter in memory. Microservices are different. A service
runs as **N stateless replicas** behind a load balancer and is scaled up and down automatically.
Requests from one client are spread over all replicas, so no single replica sees the client's
true request rate. The limit has to be enforced on **shared state**, and that state has to be
updated **atomically** because the replicas handle requests concurrently.

## 2. Rate limiting algorithms

| Algorithm | Idea | Pros | Cons |
|---|---|---|---|
| Fixed window counter | `INCR key:window`, reset each window | O(1) memory, one command | up to 2 × limit in a burst straddling a window boundary |
| Sliding window log | store a timestamp per request, count those in the last W ms | exact | memory O(limit) per client |
| Sliding window counter | weighted mix of current and previous fixed window | O(1), close to exact | approximation |
| Token bucket | tokens refill at rate r up to capacity b; each request takes one | allows controlled bursts, smooth average | two values to keep consistent (tokens, last refill) |
| Leaky bucket | requests drain from a queue at a constant rate | perfectly smooth output | adds queueing delay |

This project uses a **sliding window log** for the correct implementation (exact, no boundary
burst) and a **fixed window counter** for the naive one (the most common first attempt).

## 3. Why distribution makes it hard

### 3.1 Per-replica state multiplies the limit
With a counter in each replica's memory and round-robin load balancing, each replica sees about
1/N of a client's requests, so the client gets up to **N × limit**. Worse, N changes: when the
Horizontal Pod Autoscaler adds pods under load, the effective limit rises exactly when the system
is busiest. Sticky sessions do not fix this: they break on scaling, failover and multiple clients
behind one IP, and they defeat load balancing.

### 3.2 Shared state needs atomic updates
Moving the counter to Redis gives every replica the same view. But the obvious code is a
**check-then-act** sequence:

```
count = GET key            -- step 1: check
if count >= limit: 429
handle request             -- other requests run steps 1-3 meanwhile
INCR key                   -- step 3: record
```

Every request that arrives before the first `INCR` lands reads the same old count and is let
through. The race window is the gap between check and record: a network round trip at least,
and the whole request duration if the code records only served requests. It grows with
concurrency and latency, which is exactly when a limiter matters.

Ways to make check-and-record atomic in Redis:

| Technique | Notes |
|---|---|
| `INCR` first, then compare the returned value | atomic for a fixed window; `EXPIRE` must be set separately (or with a script) |
| `MULTI`/`EXEC` | batches commands, but cannot branch on a value read inside the transaction |
| `WATCH` + `MULTI` | optimistic locking; retries under contention |
| **Lua script (`EVAL`/`EVALSHA`)** | runs to completion with no other command interleaved; can read, decide and write. Used here |
| Redis Functions (7.0+) | the same idea, stored server-side |

### 3.3 Clock skew
A sliding window compares timestamps. If each replica used its own clock, skew between pods would
shift windows per replica. The script takes the time from **Redis `TIME`**, so there is one clock.

### 3.4 Redis becomes a dependency
Every request now costs one Redis round trip (sub-millisecond in the same cluster), and Redis can
fail. The service must choose:

- **Fail open**: serve requests without limiting. Favours availability. Used here; responses are marked `X-RateLimit-Degraded: true`.
- **Fail closed**: reject with 503. Favours protection (e.g. login or payment endpoints).

At larger scale Redis is made highly available (replica + Sentinel, or Redis Cluster). Keys are
per client, so they shard naturally across a cluster; a script must only touch keys in one hash slot.

## 4. Implementation

### 4.1 Architecture

```
 client ─► nginx (round robin) ─► api replica 1..N ─► Redis
                 └─ dashboard        (Express)          (counters)
```

- **API** (`backend/`, Node.js + Express): `GET /api/resource` behind the rate-limit middleware.
  The limiter is pluggable (`RATE_LIMIT_MODE`), and for the demo a request may choose its mode with
  the `X-RateLimit-Mode` header so all three can be compared on the same deployment.
  `WORK_MS` (20 ms) simulates the real work behind the endpoint.
- **Gateway** (`gateway/`): nginx upstream that re-resolves the API service, so new replicas join
  the rotation. `proxy_next_upstream off` stops a failed request from being retried (and counted) on a second replica.
- **Redis 7.4**: no persistence; counters only live for one window.

### 4.2 The three limiters

**`memory`** (`limiters/memory.js`): sliding window log in a JavaScript `Map`. Correct on one
instance; used to show the multiplication effect.

**`redis-naive`** (`limiters/redisNaive.js`): fixed window in Redis with `GET`, then `INCR` after
the response is sent. Shared, but not atomic.

**`redis`** (`limiters/redisAtomic.js`): one Lua script per request:

```lua
local t   = redis.call('TIME')                          -- Redis clock, not the pod's
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)    -- drop requests older than the window
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, now .. '-' .. id)        -- record this request
  redis.call('PEXPIRE', key, window)                    -- idle clients cost no memory
  return {1, limit - count - 1, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {0, 0, tonumber(oldest[2]) + window - now}       -- retry after (ms)
```

The member includes a per-request id so two requests in the same millisecond both count. The
script is loaded once and then called by SHA (`EVALSHA`).

### 4.3 DevOps

| Stage | Where |
|---|---|
| Containers | `backend/Dockerfile` (non-root, healthcheck), `gateway/Dockerfile` |
| Local multi-replica deployment | `docker-compose.yml` (3 API replicas, scalable with `--scale`) |
| Kubernetes | `k8s/`: API Deployment (3 replicas, probes, resource requests), HPA 3-6 on CPU, Redis, gateway LoadBalancer, Kustomize ConfigMap |
| CI/CD | GitHub Actions: tests with a Redis service, end-to-end burst with `--check`, images pushed to GHCR tagged by commit SHA |

## 5. Experiments

**Method:** `scripts/burst.js` sends N requests from one client **at the same time**
(`Promise.all`, one HTTP connection each) with a fresh API key per run. Limit 20 per 10 s.
Measured on a Linux host with Docker Compose and on k3s (k3d) Kubernetes.

### 5.1 Three replicas (Docker Compose)

| Mode | 100 requests | 300 requests | Allowed per replica (300) |
|---|---|---|---|
| `memory` | 60 | 60 | 20 / 20 / 20 |
| `redis-naive` | 81-100 | 131-187 | 44 / 44 / 43 |
| `redis` | **20** | **20** | 8 / 5 / 7 |

### 5.2 Scaling out

| Deployment | `memory` | `redis-naive` | `redis` |
|---|---|---|---|
| Compose, 5 replicas, 200 requests | 100 (5 × 20) | 200 | **20** |
| Kubernetes, 3 pods, 200 requests | 60 | 122 | **20** |
| Kubernetes, 6 pods, 400 requests | 120 (6 × 20) | 194 | **20** |

### 5.3 Redis failure
With Redis stopped, requests are served (`200`, `X-RateLimit-Degraded: true`) because the service
fails open; with `RATE_LIMIT_FAIL_OPEN=false` they get `503`. After Redis restarts the next burst
is limited to exactly 20 again.

### 5.4 Integration tests (no network, no load balancer)
Three limiter instances with separate Redis connections, 100 concurrent calls: the atomic limiter
allowed exactly 20 every run; the naive one allowed 100 of 100.

## 6. Discussion

- **Per-replica limiting** is wrong by exactly the replica count (60 = 3 × 20, 100 = 5 × 20,
  120 = 6 × 20). It is not "approximately right": it is a different limit that changes with scaling.
- **Shared but non-atomic** limiting can be worse than per-replica limiting under a burst
  (131-200 allowed). Centralizing the state is necessary but not sufficient.
- **Shared and atomic** limiting gave exactly 20 in every run, independent of replica count,
  concurrency and which replica served each request.
- The naive race depends on timing. It appears even with no work between `GET` and `INCR` (100/100
  in the in-process test). Over a real network the window is at least one round trip; in this
  demo it is the request duration, which is typical of code that only counts served requests.
- **Cost:** one Redis round trip per request and a sorted-set entry per request in the window
  (at most `limit` entries per client, expiring with the window). For very high limits a
  sliding-window counter or token bucket in Lua keeps O(1) memory with the same atomicity.

**Limitations:** single Redis instance (no HA); limits per API key only (no global or per-route
quotas); the browser dashboard cannot open enough connections to show the race, so the CLI is used.

## 7. Conclusion

Horizontally scaled microservices need rate limits enforced on shared state. Redis provides that
state with sub-millisecond latency, and a Lua script makes the check-and-record step atomic and
uses a single clock. In every measurement the atomic Redis limiter enforced exactly the configured
limit, from 3 to 6 replicas, while the per-replica limiter multiplied it by the replica count and
the non-atomic Redis limiter let through up to 10 times the limit.

## References

1. Redis documentation: *EVAL / Scripting with Lua*, *Sorted sets*, *TIME*, *Redis patterns: rate limiter*. https://redis.io/docs/
2. RFC 6585, *Additional HTTP Status Codes* (429 Too Many Requests).
3. IETF draft *RateLimit header fields for HTTP* (draft-ietf-httpapi-ratelimit-headers).
4. Kubernetes documentation: *Horizontal Pod Autoscaling*, *Services*.
5. Cloudflare blog, *How we built rate limiting capable of scaling to millions of domains* (sliding window counter).
6. Stripe engineering blog, *Scaling your API with rate limiters*.
