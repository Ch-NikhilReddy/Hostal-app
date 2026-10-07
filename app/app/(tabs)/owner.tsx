import { useCallback, useState } from 'react';
import { View, ScrollView, RefreshControl, Pressable } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { formatRupees } from '@/api/client';
import {
  getOwnerDashboard,
  getOwnerVerification,
  listBookings,
  type StayInput,
} from '@/api/endpoints';
import type { Booking, OwnerDashboard } from '@/api/types';
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  LoadingState,
  StatusBadge,
  Txt,
  sharedStyles,
} from '@/components/ui';
import { colors, spacing, radius, fontSize } from '@/theme/tokens';

export default function OwnerDashboardScreen() {
  const router = useRouter();

  const [dashboard, setDashboard] = useState<OwnerDashboard | null>(null);
  const [pending, setPending] = useState<Booking[]>([]);
  const [verification, setVerification] = useState<Awaited<ReturnType<typeof getOwnerVerification>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
    if (mode === 'refresh') setRefreshing(true);
    setError(null);
    try {
      const [dash, bookings, verify] = await Promise.all([
        getOwnerDashboard(),
        listBookings({ status: 'PENDING_OWNER' }),
        getOwnerVerification(),
      ]);
      setDashboard(dash);
      setPending(bookings.bookings);
      setVerification(verify);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your dashboard.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (loading && !dashboard) return <LoadingState label="Loading your dashboard…" />;
  if (error && !dashboard) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!dashboard) return null;

  const occupancyPercent =
    dashboard.beds.total > 0
      ? Math.round(((dashboard.beds.occupied / dashboard.beds.total) * 100) * 10) / 10
      : 0;

  return (
    <ScrollView
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh')} tintColor={colors.primary} />
      }
    >
      {/* Verification banner — the single most important thing for a new owner */}
      {dashboard.verificationStatus !== 'APPROVED' ? (
        <Card style={{ backgroundColor: colors.warningFaint, borderColor: colors.warning }}>
          <Txt variant="label" weight="700" color={colors.warning}>
            {dashboard.verificationStatus === 'REJECTED' ? 'VERIFICATION REJECTED' : 'VERIFICATION PENDING'}
          </Txt>
          <Txt variant="body" color={colors.warning} style={{ marginTop: spacing.xs }}>
            {dashboard.verificationStatus === 'REJECTED'
              ? (verification?.rejectionReason ?? 'Your documents were not accepted.')
              : 'Upload your PAN and bank proof to start receiving bookings.'}
          </Txt>
          {verification ? (
            <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
              {verification.checklist.map((item) => (
                <View key={item.type} style={sharedStyles.row}>
                  <Txt variant="body" color={item.done ? colors.success : colors.warning} weight="700">
                    {item.done ? '✓' : '○'}
                  </Txt>
                  <Txt
                    variant="body"
                    color={item.done ? colors.success : colors.warning}
                    style={{ marginLeft: spacing.sm, textTransform: 'capitalize' }}
                  >
                    {item.type.replace(/_/g, ' ').toLowerCase()} {item.done ? 'verified' : item.uploaded ? 'uploaded, under review' : 'not uploaded'}
                  </Txt>
                </View>
              ))}
            </View>
          ) : null}
        </Card>
      ) : null}

      {/* Key numbers */}
      <View style={[sharedStyles.row, { marginTop: spacing.lg, gap: spacing.md }]}>
        <StatTile label="Awaiting you" value={String(dashboard.pendingApprovals)} tone={dashboard.pendingApprovals > 0 ? 'warning' : 'neutral'} />
        <StatTile label="Checked in" value={String(dashboard.currentlyCheckedIn)} tone="info" />
      </View>

      <View style={[sharedStyles.row, { marginTop: spacing.md, gap: spacing.md }]}>
        <StatTile label="Beds free" value={`${dashboard.beds.available}/${dashboard.beds.total}`} tone="success" />
        <StatTile label="Occupancy" value={`${occupancyPercent}%`} tone="brand" />
      </View>

      {/* Earnings */}
      <Card style={{ marginTop: spacing.xl }}>
        <Txt variant="subtitle" weight="700" style={{ marginBottom: spacing.md }}>
          Earnings
        </Txt>
        <EarningsRow label="Gross rent booked" value={dashboard.earnings.grossPaise} />
        <EarningsRow
          label={`Platform commission (${(dashboard.commissionRateBps / 100).toFixed(1)}%)`}
          value={-dashboard.earnings.commissionPaise}
          muted
        />
        <Divider style={{ marginVertical: spacing.md }} />
        <EarningsRow label="You receive" value={dashboard.earnings.payoutPaise} bold />
        <Txt variant="caption" color={colors.textFaint} style={{ marginTop: spacing.sm }}>
          Across {dashboard.earnings.bookingCount} booking{dashboard.earnings.bookingCount === 1 ? '' : 's'}.
          {dashboard.earnings.depositHeldPaise > 0
            ? ` ${formatRupees(dashboard.earnings.depositHeldPaise)} in student deposits is held separately and is not your revenue.`
            : ''}
        </Txt>
      </Card>

      {/* Properties */}
      <Card style={{ marginTop: spacing.lg }}>
        <Txt variant="subtitle" weight="700" style={{ marginBottom: spacing.md }}>
          Your properties
        </Txt>
        {dashboard.hostels.length === 0 ? (
          <Txt variant="body" color={colors.textMuted}>
            No properties yet. Add one from the owner web dashboard.
          </Txt>
        ) : (
          dashboard.hostels.map((h, i) => (
            <View key={h.id}>
              {i > 0 ? <Divider style={{ marginVertical: spacing.md }} /> : null}
              <View style={sharedStyles.rowBetween}>
                <View style={{ flex: 1 }}>
                  <Txt variant="body" weight="600">
                    {h.name}
                  </Txt>
                  <View style={[sharedStyles.row, { marginTop: spacing.xs, gap: spacing.xs }]}>
                    <Badge
                      label={h.verificationStatus === 'APPROVED' ? 'Approved' : h.verificationStatus}
                      tone={h.verificationStatus === 'APPROVED' ? 'success' : 'warning'}
                    />
                    <Badge label={h.published ? 'Live' : 'Not listed'} tone={h.published ? 'brand' : 'neutral'} />
                  </View>
                </View>
              </View>
            </View>
          ))
        )}
      </Card>

      {/* Pending approvals */}
      <View style={[sharedStyles.rowBetween, { marginTop: spacing.xl, marginBottom: spacing.md }]}>
        <Txt variant="subtitle" weight="700">
          Needs your response
        </Txt>
        {pending.length > 0 ? <Badge label={String(pending.length)} tone="warning" /> : null}
      </View>

      {pending.length === 0 ? (
        <EmptyState title="Nothing pending" message="New booking requests will appear here for you to accept or decline." />
      ) : (
        pending.map((booking) => (
          <Pressable
            key={booking.bookingRef}
            onPress={() => router.push(`/booking/${booking.bookingRef}`)}
            accessibilityRole="button"
            style={({ pressed }) => ({
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: colors.border,
              padding: spacing.lg,
              marginBottom: spacing.md,
              opacity: pressed ? 0.9 : 1,
            })}
          >
            <View style={sharedStyles.rowBetween}>
              <View style={{ flex: 1 }}>
                <Txt variant="body" weight="700">
                  {booking.hostel.name}
                </Txt>
                <Txt variant="caption" color={colors.textMuted}>
                  {booking.roomType.name} · bed {booking.bed.label}
                </Txt>
              </View>
              <Txt variant="body" weight="700" color={colors.primary}>
                {formatRupees(booking.totalAmount)}
              </Txt>
            </View>
            <View style={[sharedStyles.row, { marginTop: spacing.md, gap: spacing.xs }]}>
              <StatusBadge status={booking.status} />
              <Txt variant="caption" color={colors.textFaint}>
                {new Date(booking.checkIn).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })}
                {' → '}
                {new Date(booking.checkOut).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })}
              </Txt>
            </View>
            <Txt variant="caption" color={colors.primary} weight="600" style={{ marginTop: spacing.sm }}>
              Tap to accept or decline →
            </Txt>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string; tone: string }) {
  const tones: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: colors.surface, fg: colors.text },
    warning: { bg: colors.warningFaint, fg: colors.warning },
    info: { bg: colors.infoFaint, fg: colors.info },
    success: { bg: colors.successFaint, fg: colors.success },
    brand: { bg: colors.primaryFaint, fg: colors.primaryDark },
  };
  const t = tones[tone] ?? tones.neutral!;

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: t.bg,
        borderRadius: radius.lg,
        padding: spacing.lg,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <Txt variant="display" weight="700" color={t.fg}>
        {value}
      </Txt>
      <Txt variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
        {label}
      </Txt>
    </View>
  );
}

function EarningsRow({ label, value, bold, muted }: { label: string; value: number; bold?: boolean; muted?: boolean }) {
  return (
    <View style={[sharedStyles.rowBetween, { marginBottom: spacing.sm }]}>
      <Txt variant="body" color={muted ? colors.textMuted : colors.text}>
        {label}
      </Txt>
      <Txt
        variant={bold ? 'subtitle' : 'body'}
        weight={bold ? '700' : '600'}
        color={bold ? colors.primary : value < 0 ? colors.danger : colors.text}
      >
        {value < 0 ? '−' : ''}
        {formatRupees(Math.abs(value))}
      </Txt>
    </View>
  );
}