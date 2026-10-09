import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Request correlation.
 *
 * Every request gets an id, and it appears in three places: the `X-Request-Id`
 * response header, the morgan log line, and every error the API returns. Without it, a
 * user reporting "it failed at 14:32" gives you a timestamp and a symptom, and the
 * only way to find the request is to grep a log file for that second across every
 * line the process wrote that minute.
 *
 * The id is taken from an inbound `X-Request-Id` when present, so a correlation id set
 * by a reverse proxy or an upstream service is preserved rather than replaced.
 *
 * ON UNTRUSTED INPUT. An inbound id is accepted, which means an attacker can choose
 * it. That is deliberate and bounded:
 *   - it is only ever used in logs and responses, never in a query, a filename, a
 *     header echoed into a redirect, or a template
 *   - it is length-capped and stripped of anything that would corrupt a log line,
 *     because an unvalidated value written into logs is a log-injection vector
 *   - anything that does not match the pattern is discarded and a fresh id generated,
 *     rather than passed through
 *
 * The regex is deliberately narrow — hex and dashes only — so there is no way to put a
 * newline, a quote or a terminal escape sequence into the log stream through it.
 */

const INBOUND = /^x-request-id$/i;
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_ID = 64;

export type RequestWithId = Request & { requestId: string };

/**
 * Inbound id if it is safe, otherwise a fresh one. Never returns anything unsafe.
 *
 * Exported for testing. Not every hostile value can be exercised over HTTP — Node's
 * own client refuses to *send* a header containing a newline or a control character,
 * so supertest rejects the request before it leaves. That transport-level refusal is
 * good, but it means testing only through HTTP would leave this guard unverified. It
 * still matters: a reverse proxy can be more permissive than Node's client, and a
 * future change that reads an id from a query parameter or a log line would not go
 * through that transport at all.
 */
export function resolveInboundId(req: Request): string {
  const raw = req.headers['x-request-id'];
  const candidate = Array.isArray(raw) ? raw[0] : raw;

  if (typeof candidate !== 'string') return randomUUID();
  const trimmed = candidate.trim().slice(0, MAX_ID);
  if (!SAFE_ID.test(trimmed)) return randomUUID();
  return trimmed;
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = resolveInboundId(req);
  (req as RequestWithId).requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/** Pull the id out for morgan, which is configured with a custom token. */
export function morganToken(req: Request): string {
  return (req as RequestWithId).requestId ?? '-';
}