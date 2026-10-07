import { useEffect, useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { createBooking } from '@/api/endpoints';
import { formatRupees } from '@/api/client';
import type { StayType } from '@/api/types';
import {
  Badge,
  Button,
  Card,
  Divider,
  Txt,
  sharedStyles,
} from '@/components/ui';
import { colors, spacing, radius, fontSize } from '@/theme/tokens';

/**
 * Payment screen.
 *
 * Deliberately NOT wired to a real gateway yet. With no Razorpay keys configured
 * the API uses its internal mock, so pressing Pay creates a real booking that holds
 * a real bed and can be driven through the lifecycle — which makes the whole flow
 * testable before a merchant account exists.
 *
 * When real keys arrive, `payment.provider` becomes 'razorpay' and `payment.keyId`
 * is populated. The Razorpay checkout sheet is then opened here, and its returned
 * `razorpay_payment_id` + signature are posted to `confirmPayment`. See
 * docs/payments.md.
 */
export default function PaymentScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    hostelSlug: string;
    hostelName: string;
    roomTypeId: string;
    roomTypeName: string;
    bedId: string;
    stayType: StayType;
    checkIn: string;
    checkOut: string;
    months?: string;
    days?: string;
    totalAmount: string;
    rentSubtotal: string;
    depositAmount: string;
  }>();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!params.roomTypeId || !params.bedId || !params.checkIn) {
    return (
      <View style={{ flex: 1, padding: spacing.xl, justifyContent: 'center' }}>
        <Txt variant="subtitle" weight="700" style={{ textAlign: 'center' }}>
          Something went wrong
        </Txt>
        <Txt variant="body" color={colors.textMuted} style={{ textAlign: 'center', marginTop: spacing.sm }}>
          The booking details were lost. Go back and choose your dates again.
        </Txt>
      </View>
    );
  }

  const total = Number(params.totalAmount);
  const rent = Number(params.rentSubtotal);
  const deposit = Number(params.depositAmount);

  const stayLabel =
    params.stayType === 'MONTHLY'
      ? `${params.months} month${params.months === '1' ? '' : 's'}`
      : params.stayType === 'DAY_STAY'
        ? 'Day stay'
        : `${params.days} day${params.days === '1' ? '' : 's'}`;

  async function pay() {
    setSubmitting(true);
    setError(null);

    try {
      const res = await createBooking({
        roomTypeId: params.roomTypeId!,
        bedId: params.bedId!,
        stayType: params.stayType!,
        checkIn: params.checkIn!,
        ...(params.stayType === 'MONTHLY' ? { months: Number(params.months) } : { days: Number(params.days ?? 1) }),
      });

      // The bed is held for 15 minutes. In a real build this screen would open the
      // gateway checkout now; with the mock we continue straight to the owner
      // handoff, which is the next real state.
      router.replace({
        pathname: '/booking/success',
        params: {
          bookingRef: res.bookingRef,
          hostelName: params.hostelName ?? '',
          totalAmount: String(res.amount),
          heldUntil: res.heldUntil,
          provider: res.payment.provider,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment could not be started.');
      setSubmitting(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
      <Card>
        <Txt variant="caption" color={colors.textMuted}>
          BOOKING AT
        </Txt>
        <Txt variant="subtitle" weight="700" style={{ marginTop: 2 }}>
          {params.hostelName}
        </Txt>

        <View style={[sharedStyles.row, { marginTop: spacing.md, flexWrap: 'wrap', gap: spacing.xs }]}>
          <Badge label={params.roomTypeName ?? ''} tone="brand" />
          <Badge label={stayLabel} tone="neutral" />
        </View>

        <Divider style={{ marginVertical: spacing.lg }} />

        <View style={[sharedStyles.rowBetween, { marginBottom: spacing.sm }]}>
          <Txt variant="body" color={colors.textMuted}>
            Check-in
          </Txt>
          <Txt variant="body" weight="600">
            {new Date(`${params.checkIn}T00:00:00Z`).toLocaleDateString('en-IN', {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              timeZone: 'UTC',
            })}
          </Txt>
        </View>
        <View style={[sharedStyles.rowBetween, { marginBottom: spacing.sm }]}>
          <Txt variant="body" color={colors.textMuted}>
            Check-out
          </Txt>
          <Txt variant="body" weight="600">
            {new Date(`${params.checkOut}T00:00:00Z`).toLocaleDateString('en-IN', {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              timeZone: 'UTC',
            })}
          </Txt>
        </View>

        <Divider style={{ marginVertical: spacing.lg }} />

        <Txt variant="label" weight="600" color={colors.textMuted} style={{ marginBottom: spacing.md }}>
          PAYMENT SUMMARY
        </Txt>

        <SummaryRow label={`Stay · ${stayLabel}`} value={rent} />
        {deposit > 0 ? <SummaryRow label="Refundable deposit" value={deposit} /> : null}

        <Divider style={{ marginVertical: spacing.md }} />

        <View style={sharedStyles.rowBetween}>
          <Txt variant="subtitle" weight="700">
            Payable now
          </Txt>
          <Txt variant="title" weight="700" color={colors.primary}>
            {formatRupees(total)}
          </Txt>
        </View>
      </Card>

      {/* Gateway notice */}
      <Card style={{ marginTop: spacing.lg, backgroundColor: colors.infoFaint, borderColor: colors.info }}>
        <Txt variant="label" weight="700" color={colors.info}>
          PAYMENT METHOD
        </Txt>
        <Txt variant="caption" color={colors.info} style={{ marginTop: spacing.xs }}>
          No payment gateway is configured, so this build runs on the built-in test gateway. No real money moves and your card details are never requested. Everything else — bed hold, booking record, notification, hostel confirmation — works exactly as it will in production.
        </Txt>
      </Card>

      <Card style={{ marginTop: spacing.lg }}>
        <Txt variant="label" weight="600" color={colors.textMuted} style={{ marginBottom: spacing.sm }}>
          WHAT HAPPENS NEXT
        </Txt>
        <StepRow n={1} text="Your bed is held for 15 minutes while payment completes." />
        <StepRow n={2} text="The hostel confirms your booking, usually within a few hours." />
        <StepRow n={3} text="You get a notification and can see the booking under My bookings." />
      </Card>

      {error ? (
        <Txt variant="body" color={colors.danger} style={{ marginTop: spacing.lg, textAlign: 'center' }}>
          {error}
        </Txt>
      ) : null}

      <Button
        label={`Pay ${formatRupees(total)}`}
        onPress={() => void pay()}
        size="lg"
        fullWidth
        loading={submitting}
        testID="pay-now"
        style={{ marginTop: spacing.xl }}
      />

      <Button
        label="Cancel"
        variant="ghost"
        onPress={() => router.back()}
        fullWidth
        style={{ marginTop: spacing.sm }}
      />
    </ScrollView>
  );
}

function SummaryRow({ label, value }: { label: string; value: number }) {
  return (
    <View style={[sharedStyles.rowBetween, { marginBottom: spacing.sm }]}>
      <Txt variant="body" color={colors.textMuted}>
        {label}
      </Txt>
      <Txt variant="body" weight="600">
        {formatRupees(value)}
      </Txt>
    </View>
  );
}

function StepRow({ n, text }: { n: number; text: string }) {
  return (
    <View style={[sharedStyles.row, { marginBottom: spacing.md, alignItems: 'flex-start' }]}>
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          backgroundColor: colors.primaryFaint,
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: spacing.md,
          marginTop: 1,
        }}
      >
        <Txt style={{ fontSize: fontSize.xs, fontWeight: '700', color: colors.primaryDark }}>{n}</Txt>
      </View>
      <Txt variant="body" color={colors.textMuted} style={{ flex: 1 }}>
        {text}
      </Txt>
    </View>
  );
}