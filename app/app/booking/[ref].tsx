import { useCallback, useState } from 'react';
import { View, ScrollView, RefreshControl, Pressable, Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { cancelBooking, getBooking, respondToBooking, setBookingLifecycle } from '@/api/endpoints';
import { formatRupees } from '@/api/client';
import type { Booking } from '@/api/types';
import {
  Badge,
  Button,
  Card,
  Divider,
  ErrorState,
  LoadingState,
  StatusBadge,
  Txt,
  sharedStyles,
} from '@/components/ui';
import { colors, spacing, radius, fontSize } from '@/theme/tokens';
import { useAuth } from '@/store/auth';

const TIMELINE_LABELS: Record<string, string> = {
  PENDING_PAYMENT: 'Bed held, awaiting payment',
  PENDING_OWNER: 'Payment received, awaiting hostel',
  CONFIRMED: 'Confirmed by the hostel',
  CHECKED_IN: 'You checked in',
  CHECKED_OUT: 'You checked out',
  CANCELLED_BY_STUDENT: 'Cancelled by you',
  CANCELLED_BY_OWNER: 'Cancelled by the hostel',
  REJECTED: 'Declined by the hostel',
  REFUNDED: 'Refunded',
  EXPIRED: 'Payment window expired',
};

export default function BookingDetailScreen() {
  const { ref } = useLocalSearchParams<{ ref: string }>();
  const router = useRouter();
  const { user } = useAuth();

  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const isOwnerView = user?.role === 'OWNER' || user?.role === 'ADMIN';

  const load = useCallback(async () => {
    if (!ref) return;
    setError(null);
    try {
      const res = await getBooking(ref);
      setBooking(res.booking);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this booking.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [ref]);

  useCallback(() => void load(), [load])();

  async function act(label: string, fn: () => Promise<unknown>) {
    setWorking(true);
    try {
      await fn();
      await load();
    } catch (err) {
      Alert.alert('Could not complete that', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setWorking(false);
    }
  }

  if (loading) return <LoadingState label="Loading booking…" />;
  if (error || !booking) {
    return <ErrorState message={error ?? 'Booking not found.'} onRetry={() => void load()} />;
  }

  const canCancel = booking.status === 'CONFIRMED' || booking.status === 'PENDING_OWNER';
  const canCheckIn = booking.status === 'CONFIRMED';
  const canCheckOut = booking.status === 'CHECKED_IN';
  const canRespond = booking.status === 'PENDING_OWNER';

  return (
    <ScrollView
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.primary} />
      }
    >
      {/* Header */}
      <View style={sharedStyles.rowBetween}>
        <View style={{ flex: 1 }}>
          <Txt variant="caption" color={colors.textMuted}>
            BOOKING
          </Txt>
          <Txt variant="title" weight="700">
            {booking.bookingRef}
          </Txt>
        </View>
        <StatusBadge status={booking.status} />
      </View>

      {/* Hostel */}
      <Card style={{ marginTop: spacing.lg }}>
        <Txt variant="subtitle" weight="700">
          {booking.hostel.name}
        </Txt>
        <Txt variant="caption" color={colors.textMuted}>
          {booking.hostel.addressLine}, {booking.hostel.area}
        </Txt>

        {booking.hostel.contactPhone ? (
          <Pressable
            onPress={() => Alert.alert('Hostel contact', `+91 ${booking.hostel.contactPhone}`)}
            accessibilityRole="button"
            style={{ marginTop: spacing.md }}
          >
            <Txt variant="body" color={colors.primary} weight="600">
              📞 +91 {booking.hostel.contactPhone}
            </Txt>
          </Pressable>
        ) : null}
      </Card>

      {/* Stay details */}
      <Card style={{ marginTop: spacing.lg }}>
        <Txt variant="label" weight="600" color={colors.textMuted} style={{ marginBottom: spacing.md }}>
          STAY DETAILS
        </Txt>
        <Row label="Room" value={booking.roomType.name} />
        <Row label="Bed" value={booking.bed.label} />
        <Row
          label="Duration"
          value={
            booking.stayType === 'MONTHLY'
              ? `${booking.months} month${booking.months === 1 ? '' : 's'}`
              : booking.stayType === 'DAY_STAY'
                ? 'Day stay'
                : `${booking.days} day${booking.days === 1 ? '' : 's'}`
          }
        />
        <Row label="Check-in" value={formatDate(booking.checkIn)} />
        <Row label="Check-out" value={formatDate(booking.checkOut)} last />
      </Card>

      {/* Payment */}
      <Card style={{ marginTop: spacing.lg }}>
        <Txt variant="label" weight="600" color={colors.textMuted} style={{ marginBottom: spacing.md }}>
          PAYMENT
        </Txt>
        <Row label="Rent and charges" value={formatRupees(booking.baseRent + booking.foodCharges)} />
        {booking.depositAmount > 0 ? <Row label="Security deposit" value={formatRupees(booking.depositAmount)} /> : null}
        <Divider style={{ marginVertical: spacing.md }} />
        <Row label="Total" value={formatRupees(booking.totalAmount)} bold last />
        {booking.payment ? (
          <>
            <Divider style={{ marginVertical: spacing.md }} />
            <Row label="Payment status" value={booking.payment.status.replace(/_/g, ' ')} />
            {booking.payment.method ? <Row label="Method" value={booking.payment.method.toUpperCase()} /> : null}
            {booking.payment.capturedAt ? <Row label="Paid on" value={formatDate(booking.payment.capturedAt)} last /> : null}
          </>
        ) : null}
      </Card>

      {/* Owner actions */}
      {isOwnerView && (canRespond || canCheckIn || canCheckOut) ? (
        <Card style={{ marginTop: spacing.lg, backgroundColor: colors.warningFaint, borderColor: colors.warning }}>
          <Txt variant="label" weight="700" color={colors.warning} style={{ marginBottom: spacing.md }}>
            OWNER ACTIONS
          </Txt>

          {canRespond ? (
            <View style={{ flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md }}>
              <Button
                label="Accept"
                onPress={() =>
                  void act('accept', () => respondToBooking(booking.bookingRef, 'accept'))
                }
                loading={working}
                testID="accept-booking"
                style={{ flex: 1 }}
              />
              <Button
                label="Decline"
                variant="danger"
                onPress={() =>
                  Alert.alert('Decline booking?', 'The student will be notified and their deposit returned.', [
                    { text: 'Keep it', style: 'cancel' },
                    {
                      text: 'Decline',
                      style: 'destructive',
                      onPress: () => {
                        void act('decline', () =>
                          respondToBooking(booking.bookingRef, 'decline', 'Not available for those dates'),
                        );
                      },
                    },
                  ])
                }
                style={{ flex: 1 }}
              />
            </View>
          ) : null}

          {canCheckIn ? (
            <Button
              label="Mark checked in"
              fullWidth
              onPress={() => void act('check-in', () => setBookingLifecycle(booking.bookingRef, 'check-in'))}
              loading={working}
              style={{ marginBottom: canRespond ? spacing.md : 0 }}
            />
          ) : null}

          {canCheckOut ? (
            <Button
              label="Mark checked out"
              variant="secondary"
              fullWidth
              onPress={() => void act('check-out', () => setBookingLifecycle(booking.bookingRef, 'check-out'))}
              loading={working}
            />
          ) : null}
        </Card>
      ) : null}

      {/* Timeline */}
      {booking.statusHistory && booking.statusHistory.length > 0 ? (
        <Card style={{ marginTop: spacing.lg }}>
          <Txt variant="label" weight="600" color={colors.textMuted} style={{ marginBottom: spacing.md }}>
            HISTORY
          </Txt>
          {booking.statusHistory.map((event, i) => (
            <View key={`${event.toStatus}-${i}`} style={[sharedStyles.row, { marginBottom: spacing.md, alignItems: 'flex-start' }]}>
              <View style={{ alignItems: 'center', marginRight: spacing.md }}>
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: i === booking.statusHistory!.length - 1 ? colors.primary : colors.border,
                    marginTop: 4,
                  }}
                />
                {i < booking.statusHistory!.length - 1 ? (
                  <View style={{ width: 1, height: 26, backgroundColor: colors.border, marginTop: 2 }} />
                ) : null}
              </View>
              <View style={{ flex: 1 }}>
                <Txt variant="body" weight="600">
                  {TIMELINE_LABELS[event.toStatus] ?? event.toStatus}
                </Txt>
                <Txt variant="caption" color={colors.textFaint}>
                  {formatDateTime(event.createdAt)}
                  {event.reason ? ` · ${event.reason}` : ''}
                </Txt>
              </View>
            </View>
          ))}
        </Card>
      ) : null}

      {/* Student actions */}
      {!isOwnerView && canCancel ? (
        <Button
          label="Cancel this booking"
          variant="outline"
          fullWidth
          onPress={() =>
            Alert.alert(
              'Cancel booking?',
              booking.payment?.status === 'PAID'
                ? 'Your deposit will be refunded under the hostel notice policy.'
                : 'No payment has been taken.',
              [
                { text: 'Keep booking', style: 'cancel' },
                {
                  text: 'Cancel booking',
                  style: 'destructive',
                  onPress: () =>
                    void act('cancel', () => cancelBooking(booking.bookingRef, 'Cancelled by student from the app')).then(
                      () => router.back(),
                    ),
                },
              ],
            )
          }
          style={{ marginTop: spacing.xl }}
        />
      ) : null}
    </ScrollView>
  );
}

function Row({ label, value, bold, last }: { label: string; value: string; bold?: boolean; last?: boolean }) {
  return (
    <View style={[sharedStyles.rowBetween, { marginBottom: last ? 0 : spacing.sm }]}>
      <Txt variant="body" color={colors.textMuted}>
        {label}
      </Txt>
      <Txt variant="body" weight={bold ? '700' : '600'} style={bold ? { color: colors.primary } : undefined}>
        {value}
      </Txt>
    </View>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}