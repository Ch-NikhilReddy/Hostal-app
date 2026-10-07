import { describe, expect, it } from 'vitest';
import {
  buildCorsPolicy,
  corsOptionsFor,
  isOriginAllowed,
  normaliseOrigin,
} from '../../src/lib/cors.js';

/**
 * Regression tests for C-1: CORS must not reflect arbitrary origins while
 * allowing credentials.
 *
 * The pre-fix code passed `origin: true` outside production, which made the cors
 * package echo whatever Origin header it received. Every test below fails against
 * that implementation.
 */

describe('normaliseOrigin', () => {
  it('lowercases the host', () => {
    expect(normaliseOrigin('https://App.Example.COM')).toBe('https://app.example.com');
  });

  it('strips a trailing slash so the same origin is not listed twice', () => {
    expect(normaliseOrigin('https://app.example.com/')).toBe('https://app.example.com');
  });

  it('drops the default port', () => {
    expect(normaliseOrigin('https://app.example.com:443')).toBe('https://app.example.com');
    expect(normaliseOrigin('http://localhost:80')).toBe('http://localhost');
  });

  it('keeps a non-default port, which is what distinguishes dev instances', () => {
    expect(normaliseOrigin('http://localhost:5173')).toBe('http://localhost:5173');
  });

  it('rejects a non-http protocol', () => {
    // A file:// or javascript: "origin" in an allowlist is a config error that
    // must not become a trusted entry.
    expect(normaliseOrigin('file:///etc/passwd')).toBeNull();
    expect(normaliseOrigin('javascript:alert(1)')).toBeNull();
  });

  it('rejects an origin carrying credentials', () => {
    expect(normaliseOrigin('https://user:pw@app.example.com')).toBeNull();
  });

  it('rejects an origin with a path', () => {
    // A bare origin has no path. Allowing one would make the comparison
    // meaningless, since browsers never send a path in Origin.
    expect(normaliseOrigin('https://app.example.com/admin')).toBeNull();
  });

  it('rejects unparseable and empty input', () => {
    expect(normaliseOrigin('')).toBeNull();
    expect(normaliseOrigin('   ')).toBeNull();
    expect(normaliseOrigin('not a url')).toBeNull();
  });

  it('rejects the wildcard outright', () => {
    // "*" must never survive normalisation into a usable origin.
    expect(normaliseOrigin('*')).toBeNull();
  });
});

describe('buildCorsPolicy — production', () => {
  it('throws when CORS_ORIGINS is missing', () => {
    // The core of C-1: a misconfigured production deploy must refuse to start,
    // not open itself to every origin.
    expect(() => buildCorsPolicy(undefined, true)).toThrow(/CORS_ORIGINS is required/);
    expect(() => buildCorsPolicy('', true)).toThrow(/CORS_ORIGINS is required/);
  });

  it('throws when CORS_ORIGINS is only whitespace or junk', () => {
    expect(() => buildCorsPolicy('   ,  ,  ', true)).toThrow(/CORS_ORIGINS is required/);
    expect(() => buildCorsPolicy('not-a-url', true)).toThrow(/CORS_ORIGINS is required/);
  });

  it('refuses a wildcard', () => {
    expect(() => buildCorsPolicy('*', true)).toThrow(/must not be "\*"/);
    expect(() => buildCorsPolicy('https://ok.example.com, *', true)).toThrow(/must not be "\*"/);
  });

  it('parses multiple origins and tolerates whitespace', () => {
    const policy = buildCorsPolicy(
      ' https://app.hostelmitra.com , https://admin.hostelmitra.com ',
      true,
    );
    expect(policy.allowedOrigins).toEqual([
      'https://app.hostelmitra.com',
      'https://admin.hostelmitra.com',
    ]);
  });

  it('never permits loopback in production', () => {
    const policy = buildCorsPolicy('https://app.hostelmitra.com', true);
    expect(policy.allowLoopback).toBe(false);
    expect(isOriginAllowed('http://localhost:5173', policy)).toBe(false);
  });
});

describe('buildCorsPolicy — development and staging', () => {
  it('allows an explicitly listed origin', () => {
    const policy = buildCorsPolicy('http://localhost:5173', false);
    expect(isOriginAllowed('http://localhost:5173', policy)).toBe(true);
  });

  it('allows loopback on any port for a developer machine', () => {
    const policy = buildCorsPolicy(undefined, false);
    expect(isOriginAllowed('http://localhost:5173', policy)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:3000', policy)).toBe(true);
    expect(isOriginAllowed('http://[::1]:8080', policy)).toBe(true);
  });

  it('still refuses an arbitrary remote origin in development', () => {
    // This is the exact regression: pre-fix, development reflected this origin.
    const policy = buildCorsPolicy(undefined, false);
    expect(isOriginAllowed('https://evil-attacker.example', policy)).toBe(false);
  });

  it('treats staging as production when asked to', () => {
    // There is no NODE_ENV=staging branch in this codebase, so a staging host
    // configured as development is the realistic failure. isProduction must be
    // the only switch that matters, and it must not soften for staging.
    expect(() => buildCorsPolicy(undefined, true)).toThrow();
  });
});

describe('isOriginAllowed', () => {
  const prod = buildCorsPolicy('https://app.hostelmitra.com', true);

  it('allows an exact match', () => {
    expect(isOriginAllowed('https://app.hostelmitra.com', prod)).toBe(true);
  });

  it('is case-insensitive, matching browser behaviour', () => {
    expect(isOriginAllowed('https://APP.HostelMitra.com', prod)).toBe(true);
  });

  it('rejects a sibling subdomain that was not listed', () => {
    // Exact-match only. A prefix or suffix match would let an attacker register
    // "evil-app.hostelmitra.com" and inherit trust.
    expect(isOriginAllowed('https://evil-app.hostelmitra.com', prod)).toBe(false);
    expect(isOriginAllowed('https://app.hostelmitra.com.evil.example', prod)).toBe(false);
  });

  it('rejects a scheme change', () => {
    // http and https are different origins to a browser.
    expect(isOriginAllowed('http://app.hostelmitra.com', prod)).toBe(false);
  });

  it('rejects a port change', () => {
    expect(isOriginAllowed('https://app.hostelmitra.com:8443', prod)).toBe(false);
  });

  it('returns false when there is no Origin header', () => {
    // A native mobile client sends none, so CORS correctly does not apply.
    expect(isOriginAllowed(undefined, prod)).toBe(false);
    expect(isOriginAllowed('', prod)).toBe(false);
  });

  it('rejects a malformed Origin', () => {
    expect(isOriginAllowed('not a url', prod)).toBe(false);
  });

  it('rejects the literal wildcard from a client', () => {
    expect(isOriginAllowed('*', prod)).toBe(false);
  });
});

describe('corsOptionsFor', () => {
  function decide(options: ReturnType<typeof corsOptionsFor>, origin: string | undefined) {
    return new Promise<boolean>((resolve, reject) => {
      options.origin!(origin, (err, allow) => {
        if (err) reject(err);
        else resolve(Boolean(allow));
      });
    });
  }

  it('invokes the callback with an error for a disallowed origin', async () => {
    // Express `cors` treats a truthy error as "do not add CORS headers", which is
    // the refusal we want — the browser then blocks the response.
    const options = corsOptionsFor(buildCorsPolicy('https://app.hostelmitra.com', true));
    await expect(decide(options, 'https://evil-attacker.example')).rejects.toThrow(
      /not permitted/i,
    );
  });

  it('allows an allowlisted origin without error', async () => {
    const options = corsOptionsFor(buildCorsPolicy('https://app.hostelmitra.com', true));
    await expect(decide(options, 'https://app.hostelmitra.com')).resolves.toBe(true);
  });

  it('never uses a boolean or wildcard origin', () => {
    // A regression guard on the shape itself: `origin: true` is what caused C-1,
    // so assert the option is a function, not a boolean.
    const options = corsOptionsFor(buildCorsPolicy('https://x.example.com', true));
    expect(typeof options.origin).toBe('function');
    expect(options.origin).not.toBe(true);
  });

  it('keeps credentials enabled but scoped to the allowlist', () => {
    const options = corsOptionsFor(buildCorsPolicy('https://x.example.com', true));
    // Safe only because origin is not reflective. See the note in lib/cors.ts.
    expect(options.credentials).toBe(true);
  });
});