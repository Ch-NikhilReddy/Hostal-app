import { afterAll, describe, expect, it } from 'vitest';

/**
 * HTTP-level regression for C-1.
 *
 * The unit tests prove the allowlist logic; this proves the header behaviour an
 * attacker actually depends on. Both suites import the real cors middleware
 * rather than reimplementing header logic, so a future refactor of lib/cors.ts
 * cannot make these pass while the headers stay wrong.
 *
 * No database is involved: the app boots with the schema untouched, and only
 * /health and /v1/colleges are called.
 */

const BOOT_TIMEOUT_MS = 90_000;

type Origin = string;

async function bootApi(corsOrigins: string) {
  process.env.CORS_ORIGINS = corsOrigins;

  const [{ createServer }, appModule] = await Promise.all([
    import('node:http'),
    // Dynamic imports are relative to this file, so they need the same ../../
    // prefix as the static import at the top.
    import('../../src/app.js'),
  ]);

  // createApp() wires the real guard, so this exercises production code paths
  // rather than a re-implementation of them.
  const app = appModule.createApp();

  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind a port');
  const base = `http://127.0.0.1:${address.port}`;

  return { server, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('CORS over HTTP (C-1 regression)', () => {
  const closed: (() => Promise<void>)[] = [];

  afterAll(async () => {
    for (const c of closed) await c();
    delete process.env.CORS_ORIGINS;
  });

  async function get(base: string, path: string, origin?: Origin) {
    const res = await fetch(`${base}${path}`, {
      headers: origin ? { Origin: origin } : {},
    });
    return {
      status: res.status,
      acao: res.headers.get('access-control-allow-origin'),
      acac: res.headers.get('access-control-allow-credentials'),
      vary: res.headers.get('vary'),
    };
  }

  async function preflight(base: string, path: string, origin: Origin) {
    const res = await fetch(`${base}${path}`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    return {
      status: res.status,
      acao: res.headers.get('access-control-allow-origin'),
      acac: res.headers.get('access-control-allow-credentials'),
    };
  }

  it('does NOT reflect an attacker origin (the C-1 regression test)', async () => {
    const { base, close } = await bootApi('http://localhost:5173');
    closed.push(close);

    const res = await get(base, '/health', 'https://evil-attacker.example');

    // The pre-fix build answered with:
    //   Access-Control-Allow-Origin: https://evil-attacker.example
    //   Access-Control-Allow-Credentials: true
    expect(res.acao).toBeNull();
    expect(res.acac).toBeNull();
  });

  it('rejects the preflight for an attacker origin', async () => {
    const { base, close } = await bootApi('http://localhost:5173');
    closed.push(close);

    const res = await preflight(base, '/health', 'https://evil-attacker.example');

    // Express `cors` turns the callback error into a 500. The important
    // assertion is that no CORS headers are emitted, so the browser blocks it.
    expect(res.acao).toBeNull();
    expect(res.acac).toBeNull();
  });

  it('allows an explicitly allowlisted origin, with credentials', async () => {
    const { base, close } = await bootApi('http://localhost:5173');
    closed.push(close);

    const res = await get(base, '/health', 'http://localhost:5173');

    expect(res.acao).toBe('http://localhost:5173');
    expect(res.acac).toBe('true');
  });

  it('allows several allowlisted origins independently', async () => {
    const { base, close } = await bootApi(
      'http://localhost:5173, https://app.hostelmitra.com, https://admin.hostelmitra.com',
    );
    closed.push(close);

    for (const origin of [
      'http://localhost:5173',
      'https://app.hostelmitra.com',
      'https://admin.hostelmitra.com',
    ]) {
      const res = await get(base, '/health', origin);
      expect(res.acao, `origin ${origin}`).toBe(origin);
      expect(res.acac, `origin ${origin}`).toBe('true');
    }
  });

  it('answers a no-Origin request without CORS headers, as a native client needs', async () => {
    const { base, close } = await bootApi('http://localhost:5173');
    closed.push(close);

    const res = await get(base, '/health');

    expect(res.status).toBe(200);
    expect(res.acao).toBeNull();
  });

  it('varies on Origin so a shared cache cannot cross-serve origins', async () => {
    const { base, close } = await bootApi('http://localhost:5173, https://app.hostelmitra.com');
    closed.push(close);

    const res = await get(base, '/health', 'http://localhost:5173');
    expect(res.vary?.toLowerCase()).toContain('origin');
  });
}, BOOT_TIMEOUT_MS);