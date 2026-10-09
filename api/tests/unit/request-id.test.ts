import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requestId, resolveInboundId } from '../../src/lib/requestId.js';
import { errorHandler } from '../../src/lib/errors.js';

/**
 * Phase 10: request correlation.
 *
 * The interesting part is not that an id is generated — it is what happens when a
 * client supplies one. An inbound id is attacker-controlled, so it is validated
 * against a narrow pattern and anything else is discarded. Without that, an id is a
 * log-injection vector: a caller can put a newline and a fabricated log line into
 * every line the process writes.
 *
 * Control characters are built with String.fromCharCode rather than written literally,
 * so this file stays plain text and a reader can see what is being tested.
 */

const ESC = String.fromCharCode(0x1b); // terminal escape
const NUL = String.fromCharCode(0x00);
const LS = String.fromCharCode(0x2028); // unicode line separator

function app() {
  const a = express();
  a.use(requestId);
  a.get('/ok', (_req, res) => {
    res.json({ ok: true });
  });
  a.get('/boom', () => {
    throw new Error('deliberate');
  });
  a.use(errorHandler);
  return a;
}

describe('Phase 10 — every request gets an id', () => {
  it('returns an X-Request-Id header', async () => {
    const res = await request(app()).get('/ok');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('generates a different id per request', async () => {
    const a = app();
    const first = await request(a).get('/ok');
    const second = await request(a).get('/ok');
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });
});

describe('Phase 10 — a supplied id is preserved', () => {
  // A reverse proxy or upstream service may already have set one. Replacing it would
  // break the correlation that id exists to provide.
  it('keeps a well-formed inbound id', async () => {
    const res = await request(app())
      .get('/ok')
      .set('X-Request-Id', 'upstream-trace-abc123');

    expect(res.headers['x-request-id']).toBe('upstream-trace-abc123');
  });

  it('is case-insensitive about the header name', async () => {
    const res = await request(app())
      .get('/ok')
      .set('x-request-id', 'lowercase-header-1234');

    expect(res.headers['x-request-id']).toBe('lowercase-header-1234');
  });
});

describe('Phase 10 — a hostile id is discarded', () => {
  // This is the part that matters. The id is written into logs, and logs are read by
  // humans and by grep. An unvalidated value is a way to forge log lines.
  //
  // Tested by calling the resolver directly rather than over HTTP, because Node's own
  // client refuses to SEND a header containing a newline or a control character —
  // supertest throws before the request leaves. That refusal is good, but it means an
  // HTTP-only test would mark these as untestable and quietly prove nothing about the
  // guard. The guard still matters: a reverse proxy can be more permissive than Node's
  // client, and any future code path that reads an id from elsewhere does not go
  // through that transport.
  const hostile = [
    { label: 'a newline and a forged log line', value: `abc123def456\r\n[info] admin logged in as root` },
    { label: 'a bare newline', value: 'abc123def456\nGET /admin' },
    { label: 'terminal escape sequences', value: `abc123def456${ESC}[2J${ESC}[1;31mRED` },
    { label: 'a bare carriage return', value: 'abc123def456\rmore' },
    { label: 'a tab', value: 'abc123def456\tvalue' },
    { label: 'a null byte', value: `abc123def456${NUL}evil` },
    { label: 'spaces and punctuation', value: 'my trace id with spaces' },
    { label: 'angle brackets', value: '<script>alert(1)</script>' },
    { label: 'quotes and semicolons', value: "abc'; DROP TABLE users; --" },
    { label: 'a unicode line separator', value: `abc123def456${LS}next` },
    { label: 'too short to be a real id', value: 'ab' },
    { label: 'far too long', value: 'a'.repeat(500) },
  ];

  for (const { label, value } of hostile) {
    it(`rejects ${label}`, () => {
      const result = resolveInboundId({ headers: { 'x-request-id': value } } as never);

      expect(result).not.toBe(value);
      expect(result).not.toContain('\n');
      expect(result).not.toContain('\r');
      expect(result).not.toContain('\t');
      expect(result).not.toContain(NUL);
      expect(result).not.toContain(ESC);
      expect(result.length).toBeLessThanOrEqual(64);
      expect(result).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    });
  }

  it('handles an array-valued header', () => {
    // Node allows repeated headers, which arrive as an array. Interpolating the whole
    // array would stringify to something containing commas and brackets.
    const result = resolveInboundId({
      headers: { 'x-request-id': ['good-id-123', 'evil'] },
    } as never);

    expect(result).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('handles a non-string header value', () => {
    const result = resolveInboundId({ headers: { 'x-request-id': 12345 } } as never);
    expect(result).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('handles a missing header', () => {
    const result = resolveInboundId({ headers: {} } as never);
    expect(result).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('never reflects the supplied value into the response body on an error', async () => {
    const res = await request(app())
      .get('/boom')
      .set('X-Request-Id', "evil'; DROP TABLE users; --");

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('DROP TABLE');
  });
});

describe('Phase 10 — the id reaches the error body', () => {
  it('a 500 carries the id so a user report is actionable', async () => {
    // "It failed at 14:32" is not a bug report. An id is.
    const res = await request(app())
      .get('/boom')
      .set('X-Request-Id', 'trace-me-now-123');

    expect(res.status).toBe(500);
    expect(res.body.error.requestId).toBe('trace-me-now-123');
  });
});