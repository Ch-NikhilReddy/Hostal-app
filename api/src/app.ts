import { existsSync, mkdirSync } from 'node:fs';
import express, { type Express } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config.js';
import { buildCorsPolicy, corsGuard } from './lib/cors.js';
import { prisma } from './db.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { requestId } from './lib/requestId.js';
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

      // M-9. The API serves JSON, not HTML, so a CSP here is not the main prize — it
      // stops the API origin being framed and restricts what a stray HTML response
      // could do. The DASHBOARD's own CSP is a separate problem and is NOT solved
      // here: the API does not serve the dashboard, so it cannot set a policy for
      // that origin. See docs/deployment.md and web/nginx.conf for where that has to
      // be applied.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'base-uri': ["'none'"],
          'form-action': ["'none'"],
          'frame-ancestors': ["'none'"],
          'object-src': ["'none'"],
          // The only thing this origin is ever allowed to load.
          'connect-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
        },
      },

      // The API is called by the dashboard and the Expo app from other origins, and
      // the app sends a Bearer token rather than cookies, so credentials are not part
      // of the request. Keeping this explicit stops it being turned on by accident:
      // once credentials are allowed, CORS needs re-examining, because a wildcard
      // origin with credentials is the C-1 vulnerability in a different hat.
      crossOriginEmbedderPolicy: false,
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

  // Assigned before morgan, so every log line carries the id. Must come before the
  // logger and before any route, including /health.
  app.use(requestId);

  if (!config.isTest) {
    // The id is in every line, including morgan's own errors, so a single grep finds
    // the whole story of one request.
    app.use(
      morgan(config.isProduction ? 'combined' : 'dev', {
        stream: { write: (line: string) => process.stdout.write(line) },
      }),
    );
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

  /**
   * Liveness and readiness.
   *
   * Deliberately says almost nothing. It previously returned `env` and
   * `paymentProvider`, which is a free reconnaissance gift: NODE_ENV confirms whether
   * a development-only affordance like the OTP echo is live, and paymentProvider
   * reveals whether the deployment is taking real money — i.e. how attractive it is.
   * Neither is needed to decide whether to route traffic here, which is the only
   * question this endpoint answers.
   *
   * `db: true|false` is kept because it is genuinely operational: a load balancer has
   * to send traffic away from an instance whose database is unreachable.
   */
  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        ok: true,
        db: true,
        uptimeSeconds: Math.round(process.uptime()),
      });
    } catch (err) {
      // Logged in full server-side, because the operator needs the real cause. The
      // response stays generic for the same reason as above: a health endpoint is
      // polled by anyone who can reach it, and `detail` used to hand out the driver
      // error — connection strings and all — to whoever asked.
      console.error('[health] database check failed:', err);
      res.status(503).json({
        ok: false,
        db: false,
        error: 'Service temporarily unavailable.',
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