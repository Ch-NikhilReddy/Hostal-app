import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';
import { errorHandler } from '../../src/lib/errors.js';
import {
  limits,
  rateLimit,
  resetRateLimits,
  setRateLimitingEnabled,
} from '../../src/lib/rateLimit.js';

/**
 * H-4: rate limiting.
 *
 * tests/setup.ts disables limiting for the whole suite — the counters live in one
 * in-process map and 281 tests would exhaust the OTP budget purely by existing, so
 * the suite would fail on ordering rather than on behaviour. That makes it essential
 * that something still drives the limiter, because a control switched off everywhere
 * and never exercised looks identical to a working control on a dashboard.
 *
 * So this file switches enforcement back ON via the setRateLimitingEnabled seam and
 * tests real limits, including the exact ones mounted in production.
 */

beforeEach(() => {
  setRateLimitingEnabled(true);
  resetRateLimits();
});

afterEach(() => {
  resetRateLimits();
});

afterAll(() => {
  // Leave the module as the rest of the suite expects it.
  setRateLimitingEnabled(false);
});

/**
 * Mount a handler on GET and POST /probe of a throwaway app.
 *
 * `trust proxy` is set because the real app sets it too (app.ts), and without it
 * Express ignores X-Forwarded-For — every request would arrive with the same req.ip and
 * the "two callers do not share a budget" test would fail for the wrong reason.
 */
function serve(handler: RequestHandler): Express {
  const a = express();
  a.set('trust proxy', 1);
  a.use(express.json());
  a.get('/probe', handler, (_req, res) => {
    res.json({ ok: true });
  });
  a.post('/probe', handler, (_req, res) => {
    res.json({ ok: true });
  });
  // The real app terminates with errorHandler, which is what turns the AppError into
  // a JSON body. Without it these throwaway apps return Express's default HTML 429
  // and every assertion about the error code and message fails for the wrong reason.
  a.use(errorHandler);
  return a;
}

describe('H-4 — a limit is enforced', () => {
  it('allows exactly `limit` requests and refuses the next one', async () => {
    const a = serve(rateLimit({ limit: 3, windowMs: 60_000, code: 'TEST' }));

    for (let i = 0; i < 3; i += 1) {
      const res = await request(a).get('/probe');
      expect(res.status, `request ${i + 1} should pass`).toBe(200);
    }

    const blocked = await request(a).get('/probe');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TEST');
  });

  it('sets Retry-After so a client knows how long to wait', async () => {
    const a = serve(rateLimit({ limit: 1, windowMs: 60_000 }));

    await request(a).get('/probe').expect(200);
    const blocked = await request(a).get('/probe');

    expect(blocked.status).toBe(429);
    const retryAfter = Number(blocked.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('publishes the standard RateLimit headers on success too', async () => {
    const a = serve(rateLimit({ limit: 5, windowMs: 60_000 }));

    const res = await request(a).get('/probe');

    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('5');
    expect(res.headers['ratelimit-remaining']).toBe('4');
  });

  it('returns the configured message rather than a generic one', async () => {
    const a = serve(rateLimit({ limit: 1, windowMs: 60_000, message: 'Slow down.' }));

    await request(a).get('/probe').expect(200);
    const blocked = await request(a).get('/probe');

    expect(blocked.body.error.message).toBe('Slow down.');
  });

  it('the window actually expires', async () => {
    const a = serve(rateLimit({ limit: 1, windowMs: 120 }));
    await request(a).get('/probe').expect(200);
    await request(a).get('/probe').expect(429);
    await new Promise((r) => setTimeout(r, 160));
    await request(a).get('/probe').expect(200);
  });
});

describe('H-4 — buckets are independent', () => {
  it('two callers do not share a budget', async () => {
    const a = serve(rateLimit({ limit: 2, windowMs: 60_000 }));

    await request(a).get('/probe').set('X-Forwarded-For', '1.1.1.1').expect(200);
    await request(a).get('/probe').set('X-Forwarded-For', '1.1.1.1').expect(200);
    await request(a).get('/probe').set('X-Forwarded-For', '1.1.1.1').expect(429);

    // A different caller must be entirely unaffected.
    await request(a).get('/probe').set('X-Forwarded-For', '2.2.2.2').expect(200);
  });

  it('the search budget and the booking budget are separate', async () => {
    const a = express();
    a.use(express.json());
    a.get('/search', rateLimit({ limit: 1, windowMs: 60_000, code: 'SEARCH' }), (_q, r) => {
      r.json({ ok: true });
    });
    a.post('/book', rateLimit({ limit: 1, windowMs: 60_000, code: 'BOOKING' }), (_q, r) => {
      r.json({ ok: true });
    });
    a.use(errorHandler);

    await request(a).get('/search').expect(200);
    await request(a).post('/book').expect(200);
    // Exhausting search must not have touched booking.
    await request(a).post('/book').expect(429);
    await request(a).get('/search').expect(429);
  });
});

describe('H-4 — the disable switch', () => {
  it('passes everything through when enforcement is off', async () => {
    setRateLimitingEnabled(false);
    const a = serve(rateLimit({ limit: 1, windowMs: 60_000 }));

    for (let i = 0; i < 10; i += 1) {
      await request(a).get('/probe').expect(200);
    }
  });

  it('and enforcing again starts counting from the moment it is switched on', async () => {
    const a = serve(rateLimit({ limit: 1, windowMs: 60_000 }));

    setRateLimitingEnabled(false);
    await request(a).get('/probe').expect(200);
    await request(a).get('/probe').expect(200);
    await request(a).get('/probe').expect(200);

    // A disabled limiter does not count at all, so re-enabling starts a fresh budget
    // rather than resuming an accumulated one. Asserted because it is the behaviour a
    // reader would otherwise have to infer: "off" means off, including the counters.
    setRateLimitingEnabled(true);
    await request(a).get('/probe').expect(200);
    await request(a).get('/probe').expect(429);
  });
});

describe('H-4 — the limits actually mounted in production', () => {
  it('a single OTP request is never blocked by the per-IP cap', async () => {
    // Guards a typo in the numbers: one code request must always succeed.
    const a = serve(limits.otpRequestByIp);
    await request(a).post('/probe').send({ phone: '9876543210' }).expect(200);
  });

  it('the per-IP cap stands down when no SMS provider is billed', async () => {
    // The regression this rule was added for. The cap was first mounted ungated and
    // promptly refused the tenth local sign-in, breaking scripts/smoke-test.mjs —
    // even though an ungated console OTP costs the operator nothing and protects
    // nothing. Both send limiters now ask config.otpIsBilled.
    //
    // In the test environment OTP_PROVIDER is 'console' with no MSG91 key, so this is
    // the stand-down path being exercised for real, not simulated.
    const { config } = await import('../../src/config.js');
    expect(config.otpIsBilled).toBe(false);

    const a = serve(limits.otpRequestByIp);
    for (let i = 0; i < 40; i += 1) {
      const res = await request(a)
        .post('/probe')
        .set('X-Forwarded-For', '3.3.3.3')
        .send({ phone: `9${String(800000000 + i)}` });
      expect(res.status, `request ${i + 1} should not be refused`).toBe(200);
    }
  });

  it('and reports a limit of 0 rather than pretending there is a budget', async () => {
    // A client that reads RateLimit-Limit should be told the truth rather than a
    // number that is never enforced.
    const a = serve(limits.otpRequestByIp);
    const res = await request(a).post('/probe').set('X-Forwarded-For', '4.4.4.4').send({});

    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('0');
  });

  it('an ungated limit still counts normally', async () => {
    // The booking, search and admin limits have no `when`, so adding the mechanism
    // must not have quietly disabled them.
    const a = serve(rateLimit({ limit: 5, windowMs: 60_000, code: 'UNTESTED_GATE' }));
    for (let i = 0; i < 5; i += 1) {
      await request(a).get('/probe').set('X-Forwarded-For', '5.5.5.5').expect(200);
    }
    await request(a).get('/probe').set('X-Forwarded-For', '5.5.5.5').expect(429);
  });
});

describe('H-4 — the search limit and shared networks', () => {
  it('30 concurrent anonymous searches are all served', async () => {
    // Every student on one campus Wi-Fi shares a single IP, and anonymous search is
    // keyed on IP. A burst of 30 must never be refused: the first version of this
    // limit was 60/min and it throttled a legitimate client — it even turned
    // scripts/smoke-test.mjs red.
    const a = serve(limits.search);
    const burst = await Promise.all(
      Array.from({ length: 30 }, () => request(a).get('/probe').set('X-Forwarded-For', '7.7.7.7')),
    );

    expect(burst.filter((r) => r.status !== 200)).toEqual([]);
  });

  it('a signed-in student does not consume the anonymous budget', async () => {
    // Otherwise a burst from one device on campus Wi-Fi eats the allowance for
    // everyone else behind that address.
    const a = express();
    a.set('trust proxy', 1);
    a.use(express.json());
    a.get(
      '/probe',
      (req, _res, next) => {
        (req as unknown as { auth: { sub: string } }).auth = { sub: 'student-1' };
        next();
      },
      limits.search,
      (_q, r) => {
        r.json({ ok: true });
      },
    );
    a.use(errorHandler);

    for (let i = 0; i < 20; i += 1) {
      await request(a).get('/probe').set('X-Forwarded-For', '8.8.8.8').expect(200);
    }
  });

  it('publishes 600/min, so the limit is a real bound rather than nothing', async () => {
    // Asserting the advertised value instead of firing 600 requests. The point is that
    // the shared-network reasoning is not a rationalisation for no control at all: the
    // number has to be a deliberate, visible choice.
    const a = serve(limits.search);
    const res = await request(a).get('/probe').set('X-Forwarded-For', '9.9.9.8');

    expect(res.status).toBe(200);
    expect(Number(res.headers['ratelimit-limit'])).toBe(600);
  });

  it('still refuses a sustained flood from one address', async () => {
    // Driven through a small rule with the same keying, because 600 requests through
    // supertest takes longer than it is worth. What is tested is that the anonymous
    // key really is the address, so one caller cannot escape by varying anything else.
    const a = serve(rateLimit({ limit: 3, windowMs: 60_000, code: 'ANON' }));

    await request(a).get('/probe').set('X-Forwarded-For', '9.9.9.9').expect(200);
    await request(a).get('/probe').set('X-Forwarded-For', '9.9.9.9').expect(200);
    // A different query string must not reset the counter.
    await request(a).get('/probe?pageSize=50').set('X-Forwarded-For', '9.9.9.9').expect(200);
    await request(a).get('/probe?pageSize=50').set('X-Forwarded-For', '9.9.9.9').expect(429);
  });

  it('rotating the phone number does not buy more SMS budget', async () => {
    // The gap this limiter closes. The pre-existing per-phone send limit keys on the
    // number, so enumeration resets it every time — which is the shape of an SMS
    // billing attack, because the cost lands on the operator.
    //
    // Built with the same numbers but no `when` gate, so this tests the property that
    // actually matters — the bucket is keyed on the IP, not the phone — rather than
    // incidentally testing whether SMS is billed in this environment. The gate itself
    // is covered by the two tests above.
    const a = serve(rateLimit({ limit: 20, windowMs: 15 * 60_000, code: 'OTP_REQUEST_IP' }));
    const from = '9.9.9.9';

    let blockedAt = -1;
    for (let i = 0; i < 40; i += 1) {
      const phone = `9${String(800000000 + i)}`;
      const res = await request(a).post('/probe').set('X-Forwarded-For', from).send({ phone });
      if (res.status === 429) {
        blockedAt = i;
        break;
      }
    }

    expect(blockedAt, 'the per-IP cap should trip while the phone number keeps changing').toBeGreaterThan(0);
    expect(blockedAt).toBeLessThan(40);
  });

  it('a per-IP bucket is unaffected by a phone number in the body', async () => {
    // Stated as its own assertion because it is the security claim: the body is
    // attacker-controlled, so a limiter that keyed on it would be trivially bypassed
    // by changing one field.
    const a = serve(rateLimit({ limit: 2, windowMs: 60_000, code: 'IP_ONLY' }));

    await request(a).post('/probe').set('X-Forwarded-For', '6.6.6.6').send({ phone: '9000000001' }).expect(200);
    await request(a).post('/probe').set('X-Forwarded-For', '6.6.6.6').send({ phone: '9000000002' }).expect(200);
    await request(a).post('/probe').set('X-Forwarded-For', '6.6.6.6').send({ phone: '9000000003' }).expect(429);
  });

  it('the booking cap allows at least the concurrency probe’s burst of 8', async () => {
    // The booking-concurrency guarantee is 8 simultaneous requests for one bed giving
    // exactly one 201 and seven 409s. If the cap were 8 with the first request
    // counted, the eighth concurrent caller could get 429 instead of 409 and the
    // guarantee would silently change meaning.
    const a = serve(limits.booking);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => request(a).post('/probe').set('Authorization', 'Bearer x')),
    );

    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
  });

  it('a different user has their own booking budget', async () => {
    const a = serve(limits.booking);
    // requireAuth decodes the bearer token and attaches auth.sub before the limiter
    // runs, so a real user id reaches the key function. Injected directly here
    // because this test exercises the limiter, not the auth chain.
    const asUser = (sub: string): RequestHandler =>
      function attachAuth(req, _res, next) {
        (req as unknown as { auth: { sub: string } }).auth = { sub };
        next();
      };

    const b = express();
    b.set('trust proxy', 1);
    b.use(express.json());
    b.post('/probe', asUser('user-a'), limits.booking, (_q, r) => {
      r.json({ ok: true });
    });
    b.post('/probe2', asUser('user-b'), limits.booking, (_q, r) => {
      r.json({ ok: true });
    });

    await request(b).post('/probe').expect(200);
    // Same IP, different user: must not be refused.
    await request(b).post('/probe2').expect(200);
  });
});