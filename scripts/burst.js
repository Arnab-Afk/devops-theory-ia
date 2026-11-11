#!/usr/bin/env node
// Fires N truly concurrent requests at the API (as one client) and reports how many got through,
// per rate-limiting mode and per replica.
//
//   node scripts/burst.js                                   # 100 requests, all three modes
//   node scripts/burst.js --mode redis --requests 200
//   node scripts/burst.js --url http://<host>:8080 --mode memory
//
// Needs Node 18+ (built-in fetch). No dependencies.

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, [])
);

const URL_BASE = (args.url || process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const REQUESTS = Number(args.requests || 100);
const MODES = args.mode && args.mode !== 'all' ? [args.mode] : ['memory', 'redis-naive', 'redis'];
const JSON_OUT = args.json === 'true';

async function burst(mode) {
  // Fresh client key per run so runs never share a window
  const key = `burst-${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const send = () =>
    fetch(`${URL_BASE}/api/resource`, { headers: { 'x-api-key': key, 'x-ratelimit-mode': mode } })
      .then(async (res) => {
        await res.arrayBuffer();
        return { status: res.status, replica: res.headers.get('x-served-by'), mode: res.headers.get('x-ratelimit-mode') };
      })
      .catch((err) => ({ status: 0, replica: null, error: err.cause?.code || err.message }));

  const started = performance.now();
  const results = await Promise.all(Array.from({ length: REQUESTS }, send)); // all in flight at once
  const ms = Math.round(performance.now() - started);

  const perReplica = {};
  for (const r of results) {
    if (!r.replica) continue;
    perReplica[r.replica] ??= { allowed: 0, blocked: 0 };
    if (r.status === 200) perReplica[r.replica].allowed++;
    if (r.status === 429) perReplica[r.replica].blocked++;
  }
  return {
    mode,
    servedMode: results.find((r) => r.mode)?.mode,
    sent: REQUESTS,
    allowed: results.filter((r) => r.status === 200).length,
    blocked: results.filter((r) => r.status === 429).length,
    errors: results.filter((r) => r.status !== 200 && r.status !== 429).length,
    ms,
    perReplica,
  };
}

async function main() {
  const config = await fetch(`${URL_BASE}/api/config`).then((r) => r.json()).catch(() => null);
  if (!config) {
    console.error(`Cannot reach ${URL_BASE}/api/config. Is the stack running?`);
    process.exit(1);
  }
  const limit = config.limit;

  const runs = [];
  for (const mode of MODES) runs.push(await burst(mode));

  if (JSON_OUT) {
    console.log(JSON.stringify({ url: URL_BASE, limit, windowMs: config.windowMs, runs }, null, 2));
    return;
  }

  console.log(`\n${REQUESTS} concurrent requests from ONE client -> ${URL_BASE}`);
  console.log(`Limit: ${limit} requests per ${config.windowMs / 1000}s per client\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('Mode', 13) + pad('Allowed', 9) + pad('429', 6) + pad('Errors', 8) + pad('vs limit', 14) + pad('Replicas', 10) + 'Allowed per replica');
  console.log('-'.repeat(95));
  for (const r of runs) {
    if (r.servedMode && r.servedMode !== r.mode) {
      console.log(`${pad(r.mode, 13)}(server ignored the mode header and used "${r.servedMode}": set ALLOW_MODE_OVERRIDE=true)`);
      continue;
    }
    const over = r.allowed - limit;
    const verdict = over > 0 ? `+${over} (${(r.allowed / limit).toFixed(1)}x)` : over === 0 ? 'exact' : `${over}`;
    const replicas = Object.keys(r.perReplica);
    const split = replicas.map((k) => r.perReplica[k].allowed).join(' / ');
    console.log(pad(r.mode, 13) + pad(r.allowed, 9) + pad(r.blocked, 6) + pad(r.errors, 8) + pad(verdict, 14) + pad(replicas.length, 10) + split);
  }
  console.log('\nmemory      = each replica counts on its own      -> up to replicas x limit');
  console.log('redis-naive = shared counter, check then record   -> race condition under concurrency');
  console.log('redis       = shared, atomic Lua script           -> exactly the limit\n');

  if (args.check === 'true') process.exit(check(runs, limit) ? 0 : 1);
}

// --check: fail (exit 1) unless every mode behaves as the theory says. Used by CI.
function check(runs, limit) {
  let ok = true;
  const expect = (cond, msg) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
    ok = ok && cond;
  };
  for (const r of runs) {
    const replicas = Object.keys(r.perReplica).length;
    expect(r.errors === 0, `${r.mode}: no errors (${r.errors})`);
    if (r.mode === 'redis') expect(r.allowed === limit, `redis: exactly ${limit} allowed (${r.allowed})`);
    if (r.mode === 'memory') {
      // Each replica enforces the limit on its own share of the traffic. Kubernetes spreads requests
      // randomly, so a replica may receive fewer than `limit`: expect min(received, limit) from each.
      const expected = Object.values(r.perReplica).reduce((sum, p) => sum + Math.min(p.allowed + p.blocked, limit), 0);
      expect(replicas > 1 && r.allowed === expected && r.allowed > limit,
        `memory: each of ${replicas} replicas allows up to ${limit} -> ${expected} expected (${r.allowed})`);
    }
    if (r.mode === 'redis-naive') expect(r.allowed > limit, `redis-naive: race lets more than ${limit} through (${r.allowed})`);
  }
  return ok;
}

main();
