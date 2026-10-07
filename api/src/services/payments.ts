import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PaymentProvider, PaymentStatus } from '@prisma/client';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { type Paise } from '../lib/money.js';

/**
 * Payment gateways behind one interface.
 *
 * The MOCK implementation is not a stub for later — it is how the whole booking
 * lifecycle stays testable in CI and during development with no gateway account,
 * no keys and no money. Every booking test in this repo exercises real order
 * creation, real capture, real webhook signature checks and real state
 * transitions. Only the network call is absent.
 */

export type CreateOrderInput = {
  amount: Paise;
  currency: string;
  /** Our booking reference, surfaced to the gateway for reconciliation. */
  receipt: string;
  notes?: Record<string, string>;
};

export type GatewayOrder = {
  orderId: string;
  amount: Paise;
  currency: string;
  status: 'created' | 'paid' | 'failed';
  /** Present only for the mock: the client passes this back to simulate capture. */
  mockPaymentId?: string;
};

export type PaymentGateway = {
  provider: PaymentProvider;
  createOrder(input: CreateOrderInput): Promise<GatewayOrder>;
  /** Verify a webhook signature. Returns the parsed event or null if untrusted. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): Promise<unknown | null>;
  verifyPaymentSignature(input: {
    orderId: string;
    paymentId: string;
    signature: string;
  }): boolean;
};

function basicAuth(key: string, secret: string): string {
  return `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;
}

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Razorpay
// ---------------------------------------------------------------------------

class RazorpayGateway implements PaymentGateway {
  readonly provider = PaymentProvider.RAZORPAY;

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
  ) {}

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: basicAuth(this.keyId, this.keySecret),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: input.amount,
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes ?? {},
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('[razorpay] createOrder failed', res.status, body);
      // Deliberately does not surface the gateway body: it can contain internal
      // account identifiers that a student should never see.
      throw new AppError(502, 'GATEWAY_ERROR', 'Could not start the payment. Please try again.');
    }

    const json = (await res.json()) as { id: string; amount: number; currency: string; status: string };
    return {
      orderId: json.id,
      amount: json.amount,
      currency: json.currency,
      status: 'created',
    };
  }

  async verifyWebhook(rawBody: Buffer, signature: string | undefined): Promise<unknown | null> {
    if (!this.webhookSecret || !signature) return null;
    const expected = hmacHex(this.webhookSecret, rawBody.toString('utf8'));
    if (!safeEqualHex(expected, signature)) {
      console.warn('[razorpay] webhook signature mismatch — rejected');
      return null;
    }
    try {
      return JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
  }

  verifyPaymentSignature(input: { orderId: string; paymentId: string; signature: string }): boolean {
    // Razorpay's checkout signature is HMAC(order_id + "|" + payment_id, key_secret).
    return safeEqualHex(
      hmacHex(this.keySecret, `${input.orderId}|${input.paymentId}`),
      input.signature,
    );
  }
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

/**
 * In-process gateway used when no Razorpay keys are configured.
 *
 * `createOrder` mints a real-shaped order. `authorize` is the bit a real gateway
 * would do after the customer completes checkout, and it is exposed on the API so
 * the booking flow can be driven end to end from curl or the app in development.
 */
class MockGateway implements PaymentGateway {
  readonly provider = PaymentProvider.MOCK;

  /** Orders minted in this process, so an authorize call can be validated. */
  private readonly orders = new Map<
    string,
    { amount: Paise; status: GatewayOrder['status']; receipt: string }
  >();

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const orderId = `order_mock_${randomBytes(9).toString('hex')}`;
    const mockPaymentId = `pay_mock_${randomBytes(9).toString('hex')}`;
    this.orders.set(orderId, { amount: input.amount, status: 'created', receipt: input.receipt });
    return {
      orderId,
      amount: input.amount,
      currency: input.currency,
      status: 'created',
      mockPaymentId,
    };
  }

  async verifyWebhook(): Promise<unknown | null> {
    // The mock has no webhook endpoint; nothing to verify.
    return null;
  }

  verifyPaymentSignature(): boolean {
    // No signature to check. `authorize` is the trust boundary instead.
    return true;
  }

  /** Simulate the student completing checkout. */
  authorize(orderId: string, outcome: 'paid' | 'failed' = 'paid'): { paymentId: string; status: PaymentStatus } {
    const order = this.orders.get(orderId);
    if (!order) {
      throw AppError.badRequest('UNKNOWN_ORDER', 'That payment order does not exist.');
    }
    order.status = outcome === 'paid' ? 'paid' : 'failed';
    return {
      paymentId: `pay_mock_${randomBytes(9).toString('hex')}`,
      status: outcome === 'paid' ? PaymentStatus.PAID : PaymentStatus.FAILED,
    };
  }

  has(orderId: string): boolean {
    return this.orders.has(orderId);
  }
}

const razorpay = new RazorpayGateway(
  config.RAZORPAY_KEY_ID,
  config.RAZORPAY_KEY_SECRET,
  config.RAZORPAY_WEBHOOK_SECRET,
);

export const mockGateway = new MockGateway();

export const paymentGateway: PaymentGateway =
  config.paymentProvider === 'razorpay' ? razorpay : mockGateway;

/** True when the mock gateway is the active one, so routes can expose dev helpers. */
export const usingMockGateway = config.paymentProvider === 'mock';