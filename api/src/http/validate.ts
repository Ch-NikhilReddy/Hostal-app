import type { Request, Response, NextFunction } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { AppError } from '../lib/errors.js';

/**
 * Validate and REPLACE a request section with the parsed value.
 *
 * Replacing rather than attaching is deliberate: handlers then read typed,
 * coerced, stripped data and cannot accidentally use the raw string. A
 * `req.query.search` reaching a SQL builder unparsed is how a filter becomes an
 * injection point.
 */
export function validate<B extends ZodTypeAny>(schema: B) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      Object.assign(req, parsed);
      next();
    } catch (err) {
      next(toAppError(err));
    }
  };
}

/** Turn a ZodError into a 400 whose message names the failing field. */
export function toAppError(err: unknown): AppError {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const field = first?.path.join('.') ?? 'request';
    return AppError.badRequest(
      'VALIDATION_FAILED',
      first ? `${field}: ${first.message}` : 'The request was not valid.',
      { issues: err.issues },
    );
  }
  return err instanceof AppError ? err : AppError.internal();
}

export type ValidateBody<T extends ZodTypeAny> = z.infer<T>;