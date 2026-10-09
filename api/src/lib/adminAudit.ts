import type { Request } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Role } from '@prisma/client';

/**
 * Admin audit trail (H-5).
 *
 * Every privileged action is recorded here with who did it, what they did, and the
 * request it happened in. Before this existed, an admin could suspend an owner, change a
 * commission rate, moderate a hostel or trigger a settlement, and nothing recorded that
 * it happened. In a dispute that is the difference between "here is what occurred" and
 * "we cannot tell you".
 *
 * THE APPEND-ONLY GUARANTEE LIVES IN THE DATABASE. The migration installs a BEFORE
 * UPDATE OR DELETE trigger that raises, so application code cannot quietly amend or
 * remove history — and neither can the retention sweeper, which deliberately does not
 * touch this table. This module therefore only ever INSERTs. There is no update
 * function and no delete function, and their absence is the design.
 *
 * FAILURES NEVER BLOCK THE ACTION. `recordAdminAction` swallows its own errors. That is
 * a deliberate trade-off and worth being explicit about: if the audit write fails and
 * the action is refused, a full disk or a database hiccup would freeze the admin
 * console, and the pressure to "fix" that by disabling auditing is exactly how audits
 * end up disabled. Instead the failure is logged loudly — including the action that
 * was not recorded — and the action proceeds. A gap in the trail is visible; an
 * outage of the business is not recoverable.
 */

/** Stable verbs. Kept as a union so a typo is a type error, not a mystery string. */
export type AdminAction =
  | 'OWNER_VERIFY'
  | 'COMMISSION_SET'
  | 'COMMISSION_OVERRIDE'
  | 'HOSTEL_MODERATE'
  | 'OWNER_SETTLEMENT'
  | 'USER_DEACTIVATE';

export type AdminActionInput = {
  req: Request;
  action: AdminAction;
  /** Who acted. Read from the verified token, never from the request body. */
  actor: { id: string; phone: string; role: Role };
  targetType?: string;
  targetId?: string;
  /** One line for a human reading the trail during an investigation. */
  summary: string;
  /**
   * Structured detail.
   *
   * NEVER put a credential, token, OTP, secret or full request body in here. This
   * table is designed to be read by anyone investigating an incident, which means it
   * must not become a place secrets are stored.
   */
  metadata?: Prisma.InputJsonValue;
};

export async function recordAdminAction(
  client: PrismaClient | Prisma.TransactionClient,
  input: AdminActionInput,
): Promise<void> {
  const req = input.req as Request & { requestId?: string };

  try {
    await client.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorPhone: input.actor.phone,
        actorRole: input.actor.role,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        summary: input.summary,
        metadata: input.metadata ?? undefined,
        requestId: req.requestId ?? null,
        ipAddress: req.ip ?? null,
      },
    });
  } catch (err) {
    // Logged, not thrown. See the note at the top of this file.
    console.error(
      `[audit] NOT RECORDED action=${input.action} target=${input.targetType ?? '-'}:${input.targetId ?? '-'} ` +
        `actor=${input.actor.phone} request=${req.requestId ?? '-'} — ${(err as Error).message}`,
    );
  }
}

/**
 * Resolve the actor from a request whose auth middleware has already run.
 *
 * The phone number is looked up rather than taken from the token because the token
 * carries only `sub` and `role`. Storing the phone denormalised is what lets the record
 * survive the account being deleted.
 */
export async function actorFrom(
  client: PrismaClient | Prisma.TransactionClient,
  auth: { sub: string; role: Role },
): Promise<{ id: string; phone: string; role: Role }> {
  const user = await client.user.findUnique({
    where: { id: auth.sub },
    select: { id: true, phone: true, role: true },
  });
  // A missing row still yields a usable actor record: the id and role come from the
  // verified token, and the phone becomes a marker rather than blocking the write.
  return { id: auth.sub, phone: user?.phone ?? 'unknown', role: auth.role };
}