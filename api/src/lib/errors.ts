import type { NextFunction, Request, Response } from 'express';

/**
 * A failure that is safe to show a user.
 *
 * `code` is the stable machine-readable identifier clients branch on. `message`
 * is written for a student or a PG owner reading it on a phone, not for a log
 * file — so it never contains SQL, stack frames, gateway payloads or a phone
 * number that is not theirs.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(code: string, message: string, details?: unknown): AppError {
    return new AppError(400, code, message, details);
  }

  static unauthorized(message = 'Please sign in to continue.', code = 'UNAUTHENTICATED'): AppError {
    return new AppError(401, code, message);
  }

  static forbidden(message = 'You do not have access to this.', code = 'FORBIDDEN'): AppError {
    return new AppError(403, code, message);
  }

  static notFound(code: string, message: string): AppError {
    return new AppError(404, code, message);
  }

  static conflict(code: string, message: string, details?: unknown): AppError {
    return new AppError(409, code, message, details);
  }

  static unprocessable(code: string, message: string, details?: unknown): AppError {
    return new AppError(422, code, message, details);
  }

  static tooManyRequests(message = 'Too many attempts. Please try again later.'): AppError {
    return new AppError(429, 'RATE_LIMITED', message);
  }

  static internal(message = 'Something went wrong. Please try again.'): AppError {
    return new AppError(500, 'INTERNAL_ERROR', message);
  }
}

/** Wrap an async route handler so a rejected promise reaches the error handler. */
export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}

/**
 * Terminal error handler. An AppError is shown verbatim; anything else is
 * replaced with a generic message and logged in full, so an unexpected failure
 * never leaks internals to a student on a phone.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? undefined },
    });
    return;
  }

  // Prisma's unique-constraint violation is a race the caller can retry.
  const maybePrisma = err as { code?: string; meta?: { target?: unknown } };
  if (maybePrisma?.code === 'P2002') {
    res.status(409).json({
      error: {
        code: 'DUPLICATE',
        message: 'That record already exists.',
      },
    });
    return;
  }

  console.error('[unhandled]', req.method, req.originalUrl, err);
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` },
  });
}