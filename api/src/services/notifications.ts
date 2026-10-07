import { NotificationChannel, Prisma, type PrismaClient } from '@prisma/client';
import { config } from '../config.js';

/**
 * Notification delivery.
 *
 * Free-tier strategy, and the reason this is an interface rather than a scattering
 * of Firebase calls:
 *   - IN_APP is always written. It is the only channel guaranteed to work, because
 *     it needs no third party. If push fails, the student still sees the
 *     notification when they open the app, so a booking confirmation is never
 *     lost because FCM was having a bad day.
 *   - PUSH goes through FCM, whose free tier is unlimited for this volume.
 *   - SMS is for the events where the student must know even with the app closed
 *     (payment captured, booking confirmed, owner is waiting).
 *
 * A failure to deliver on any channel is recorded, never thrown: a booking that
 * is confirmed must not roll back because a notification could not be sent.
 */

export type NotifyInput = {
  userId: string;
  title: string;
  body: string;
  /** Deep-link payload, e.g. { type: 'BOOKING_CONFIRMED', bookingRef } */
  data?: Prisma.InputJsonObject;
  channels?: NotificationChannel[];
};

/**
 * FCM HTTP v1 push.
 *
 * Only attempted when FCM_SERVER_KEY is set. Returns false when push could not be
 * delivered, which flags the row for a retry rather than failing the caller.
 */
async function sendPush(
  tokens: string[],
  title: string,
  body: string,
  data: Prisma.InputJsonObject,
): Promise<boolean> {
  if (!config.FCM_SERVER_KEY || tokens.length === 0) return false;

  try {
    const res = await fetch(
      `https://fcm.googleapis.com/fcm/send?key=${encodeURIComponent(config.FCM_SERVER_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          registration_ids: tokens,
          notification: { title, body },
          // data values must all be strings in the legacy HTTP API.
          data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
        }),
      },
    );
    return res.ok;
  } catch (err) {
    console.warn('[notify] push delivery failed:', (err as Error).message);
    return false;
  }
}

export async function notify(
  client: PrismaClient,
  input: NotifyInput,
): Promise<{ id: string; pushDelivered: boolean }> {
  const channels = input.channels ?? [NotificationChannel.IN_APP];

  // Where push may have gone: device tokens live on the User row in production.
  // Kept behind a lookup that degrades to an empty list so local development
  // never needs a token table.
  let tokens: string[] = [];
  if (channels.includes(NotificationChannel.PUSH)) {
    const user = await client.user.findUnique({
      where: { id: input.userId },
      select: { pushTokens: { select: { token: true } } },
    });
    tokens = user?.pushTokens.map((t) => t.token) ?? [];
  }

  const row = await client.notification.create({
    data: {
      userId: input.userId,
      title: input.title,
      body: input.body,
      data: input.data ?? undefined,
      channels,
    },
    select: { id: true },
  });

  let pushDelivered = false;
  if (channels.includes(NotificationChannel.PUSH) && tokens.length > 0) {
    pushDelivered = await sendPush(tokens, input.title, input.body, input.data ?? {});
    if (!pushDelivered) {
      await client.notification.update({
        where: { id: row.id },
        data: { pushFailedAt: new Date() },
      });
    }
  }

  if (channels.includes(NotificationChannel.SMS)) {
    // SMS needs a verified DLT sender id in India. Until MSG91 is configured the
    // body is logged rather than sent, so the rest of the flow is unaffected.
    if (config.OTP_PROVIDER === 'msg91' && config.MSG91_AUTH_KEY) {
      await sendSmsToUser(client, input.userId, input.body);
    } else {
      console.log(`[notify:sms-stub] to=${input.userId} "${input.body}"`);
    }
  }

  return { id: row.id, pushDelivered };
}

async function sendSmsToUser(client: PrismaClient, userId: string, body: string): Promise<void> {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { phone: true },
  });
  if (!user) return;

  try {
    await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: {
        authkey: config.MSG91_AUTH_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: config.MSG91_SENDER_ID,
        short_url: '0',
        recipients: [{ mobiles: `91${user.phone.replace(/\D/g, '').slice(-10)}`, message: body }],
      }),
    });
  } catch (err) {
    console.warn('[notify] SMS delivery failed:', (err as Error).message);
  }
}

/** Register a device for push. Called by the app on first launch. */
export async function registerPushToken(
  client: PrismaClient,
  userId: string,
  token: string,
  platform: 'android' | 'ios' | 'web',
): Promise<void> {
  await client.pushToken.upsert({
    where: { token },
    create: { userId, token, platform },
    update: { userId, platform, lastSeenAt: new Date() },
  });
}