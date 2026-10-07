import { existsSync, mkdirSync } from 'node:fs';
import express, { type Express } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config.js';
import { buildCorsPolicy, corsGuard } from './lib/cors.js';
import { prisma } from './db.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { authRouter } from './modules/auth.routes.js';
import { catalogRouter } from './modules/catalog.routes.js';
import { bookingsRouter, webhookRouter } from './modules/bookings.routes.js';
import { ownerRouter } from './modules/owner.routes.js';
import { adminRouter } from './modules/admin.routes.js';
import { notificationsRouter } from './modules/notifications.routes.js';

export function createApp(): Express {
  const app = express();

  // Behind a reverse proxy (nginx, Cloudflare, a Fly/Railway router) this is what
  // makes req.ip and rate limiting see the real client address.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // Images are served cross-origin to the Expo app and the dashboard, so the
      // default same-origin image policy would blank every hostel photo.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );

  // ---- CORS ----------------------------------------------------------------
  // Fail-closed. An origin is trusted only when CORS_ORIGINS names it; a missing
  // or malformed value refuses startup in production rather than falling back to
  // "allow everything". See lib/cors.ts for the full rationale.
  //
  // buildCorsPolicy throws for an empty or wildcard production list, so a
  // misconfigured deploy stops here rather than becoming publicly readable.
  const corsPolicy = buildCorsPolicy(process.env.CORS_ORIGINS, config.isProduction);

  app.use(corsGuard(corsPolicy));
  app.set('corsPolicy', corsPolicy);

  // Vary is required even though the same headers are set for every origin: a
  // shared cache must not reuse one origin's response for another. Only set it
  // when an Origin was actually sent, so a native client gets no CORS headers at
  // all.
  app.use((req, res, next) => {
    if (req.headers.origin) res.vary('Origin');
    next();
  });

  if (!config.isTest) {
    app.use(morgan(config.isProduction ? 'combined' : 'dev'));
  }

  // ---- Webhook route first, with the RAW body ---------------------------
  // The Razorpay signature is computed over the exact bytes received. Mounting
  // express.json() first would re-serialise the payload and the HMAC would never
  // match, so every webhook would be rejected as untrusted.
  app.use(
    '/v1/webhooks',
    express.raw({ type: 'application/json', limit: '1mb' }),
    webhookRouter,
  );

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ---- Local photo storage ----------------------------------------------
  // Free tier: no S3, no CDN, no egress bill. Files land on disk and are served
  // by the API. Fine to a few thousand photos; past that, switch STORAGE_DRIVER to
  // s3 — nothing else in the codebase changes.
  if (config.storageDriver === 'local') {
    if (!existsSync(config.uploadsDir)) {
      mkdirSync(config.uploadsDir, { recursive: true });
    }
    app.use('/uploads', express.static(config.uploadsDir, { maxAge: '7d' }));
  }

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        ok: true,
        database: 'up',
        paymentProvider: config.paymentProvider,
        env: config.NODE_ENV,
        uptimeSeconds: Math.round(process.uptime()),
      });
    } catch (err) {
      res.status(503).json({
        ok: false,
        database: 'down',
        // The cause is logged server-side; the response stays generic.
        error: 'Service temporarily unavailable.',
        detail: config.isProduction ? undefined : (err as Error).message,
      });
    }
  });

  app.use('/v1/auth', authRouter);
  app.use('/v1', catalogRouter);
  app.use('/v1/bookings', bookingsRouter);
  app.use('/v1/owner', ownerRouter);
  app.use('/v1/admin', adminRouter);
  app.use('/v1/notifications', notificationsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}