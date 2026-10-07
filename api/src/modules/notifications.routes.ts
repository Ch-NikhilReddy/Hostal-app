import { Router, type Request } from 'express';
import { z } from 'zod';
import { NotificationChannel } from '@prisma/client';
import { prisma } from '../db.js';
import { asyncHandler } from '../lib/errors.js';
import { validate } from '../http/validate.js';
import { requireAuth, type AuthedRequest } from '../http/auth.js';

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get(
  '/',
  validate(
    z.object({
      query: z.object({
        unreadOnly: z.enum(['true', 'false']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(20),
      }),
    }),
  ),
  asyncHandler(async (req: Request, res) => {
    const auth = (req as AuthedRequest).auth;
    const q = req.query as unknown as { unreadOnly?: string; page: number; pageSize: number };

    const where = {
      userId: auth.sub,
      ...(q.unreadOnly === 'true' ? { readAt: null } : {}),
    };

    const [notifications, unreadCount, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.notification.count({ where: { userId: auth.sub, readAt: null } }),
      prisma.notification.count({ where }),
    ]);

    res.json({ notifications, unreadCount, total, page: q.page, pageSize: q.pageSize });
  }),
);

const markBody = z.object({ ids: z.array(z.string().min(1)).min(1).max(100).optional() });

notificationsRouter.post(
  '/read',
  validate(z.object({ body: markBody })),
  asyncHandler(async (req: Request, res) => {
    const auth = (req as AuthedRequest).auth;
    const { ids } = req.body as z.infer<typeof markBody>;

    // `userId: auth.sub` in the where clause is the authorisation check: a user
    // cannot mark someone else's notifications read by guessing their ids.
    const result = await prisma.notification.updateMany({
      where: {
        userId: auth.sub,
        readAt: null,
        ...(ids ? { id: { in: ids } } : {}),
      },
      data: { readAt: new Date() },
    });

    res.json({ ok: true, updated: result.count });
  }),
);

/**
 * Re-queue notifications whose push send failed.
 *
 * In-app delivery already succeeded, so this only matters when the student has the
 * app closed — which is exactly when a booking confirmation matters most.
 */
notificationsRouter.post(
  '/retry-push',
  asyncHandler(async (req: Request, res) => {
    const auth = (req as AuthedRequest).auth;

    const result = await prisma.notification.updateMany({
      where: { userId: auth.sub, pushFailedAt: { not: null } },
      data: { pushFailedAt: null },
    });

    res.json({ ok: true, requeued: result.count });
  }),
);

export { NotificationChannel };