import { config } from '../config.js';
import { prisma } from '../db.js';

/**
 * SMS delivery.
 *
 * In India, transactional SMS to a DND-registered number is only legal from a
 * sender ID registered on a DLT platform, and the template must be pre-approved.
 * That setup is a one-off procurement item, not code — see docs/launch-checklist.md.
 * Until it exists, `OTP_PROVIDER=console` keeps the login flow fully usable in
 * development without spending money or registering anything.
 *
 * OTP messages are deliberately excluded from DND restrictions: an OTP is
 * transactional traffic and is permitted on any registered sender id.
 */

export type SmsResult = { delivered: boolean; provider: 'msg91' | 'console'; detail: string };

function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  // Indian numbers are stored as 10 digits. Anything else is a data error and is
  // better caught here than by the gateway rejecting it at 2am.
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  throw new Error(`Cannot normalise phone number: ${phone}`);
}

export async function sendOtp(phone: string, code: string): Promise<SmsResult> {
  const message = `${code} is your HostelMitra verification code. It expires in 10 minutes. Do not share it with anyone.`;

  if (config.OTP_PROVIDER === 'console') {
    console.log(`[sms:console] -> +91${phone.slice(-10)}`);
    console.log(`[sms:console] ${message}`);
    return { delivered: false, provider: 'console', detail: 'Logged to console (dev mode).' };
  }

  if (!config.MSG91_AUTH_KEY) {
    // config.ts already refuses to boot production in this state, so reaching
    // here means the operator explicitly opted in.
    console.log(`[sms:console-forced] -> +91${phone.slice(-10)}: ${message}`);
    return { delivered: false, provider: 'console', detail: 'Logged to console (forced).' };
  }

  try {
    const res = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: { authkey: config.MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: config.MSG91_SENDER_ID,
        short_url: '0',
        recipients: [{ mobiles: normalisePhone(phone), message }],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[sms] MSG91 rejected the message', res.status, text);
      return { delivered: false, provider: 'msg91', detail: `Provider rejected: ${res.status}` };
    }

    return { delivered: true, provider: 'msg91', detail: 'Sent.' };
  } catch (err) {
    console.error('[sms] MSG91 request failed:', (err as Error).message);
    return { delivered: false, provider: 'msg91', detail: 'Provider unreachable.' };
  }
}

/** Count of OTPs issued for a phone in the last hour. Used by ops dashboards. */
export async function recentOtpCount(phone: string, hours = 1): Promise<number> {
  const since = new Date(Date.now() - hours * 3_600_000);
  return prisma.otpCode.count({ where: { phone, createdAt: { gte: since } } });
}