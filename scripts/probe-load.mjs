/**
 * Load probe: sustained concurrent reads against the search and availability
 * endpoints, to establish a latency baseline before the data grows.
 *
 *   node scripts/probe-load.mjs
 *
 * Read-only. Reports p50/p95/p99 and error counts, which is the only honest way
 * to state a performance baseline for a system with 8 hostels and 11 bookings.
 */
const BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

const SCENARIOS = [
  { name: 'search (browse)', path: '/v1/hostels?collegeId=osmania-university&radiusKm=10' },
  { name: 'search (dates + availability)', path: '/v1/hostels?collegeId=osmania-university&radiusKm=10&checkIn=2027-01-01&checkOut=2027-04-01' },
  { name: 'hostel detail', path: '/v1/hostels/sai-balaji-pg-for-boys' },
  { name: 'colleges', path: '/v1/colleges' },
];

async function burst(path, concurrency, iterations) {
  const latencies = [];
  let errors = 0;

  const one = async () => {
    const t0 = performance.now();
    try {
      const res = await fetch(`${BASE}${path}`);
      if (!res.ok) errors += 1;
      else await res.arrayBuffer();
    } catch {
      errors += 1;
    }
    latencies.push(performance.now() - t0);
  };

  for (let i = 0; i < iterations; i += iterations / concurrency) {
    await Promise.all(Array.from({ length: concurrency }, one));
  }

  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
  return { n: latencies.length, errors, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: latencies.at(-1) };
}

async function main() {
  console.log(`\nLoad probe against ${BASE}`);
  console.log('Small dataset (8 hostels, 230 beds, 11 bookings) — this is the floor, not the ceiling.\n');

  for (const s of SCENARIOS) {
    // Warm up so JIT and the connection pool are not measured.
    await burst(s.path, 5, 20);

    const r = await burst(s.path, 25, 200);
    console.log(
      `${s.name.padEnd(30)} n=${r.n}  p50=${r.p50.toFixed(1)}ms  p95=${r.p95.toFixed(1)}ms  p99=${r.p99.toFixed(1)}ms  max=${r.max.toFixed(1)}ms  errors=${r.errors}`,
    );
  }

  console.log('\nSustained soak: 500 concurrent-ish requests across all endpoints');
  const t0 = performance.now();
  let errs = 0;
  for (let round = 0; round < 10; round++) {
    const all = SCENARIOS.flatMap((s) => Array.from({ length: 13 }, () => s.path));
    const results = await Promise.all(
      all.map(async (p) => {
        try {
          const res = await fetch(`${BASE}${p}`);
          return res.ok;
        } catch {
          return false;
        }
      }),
    );
    errs += results.filter((x) => !x).length;
  }
  const elapsed = performance.now() - t0;
  console.log(`  520 requests in ${elapsed.toFixed(0)}ms  =  ${(520 / (elapsed / 1000)).toFixed(0)} req/s  errors=${errs}`);
}

main().catch((e) => { console.error('load probe failed:', e.message); process.exit(1); });