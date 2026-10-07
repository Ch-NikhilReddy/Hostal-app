import { useCallback, useState } from 'react';
import { View, FlatList, RefreshControl, Pressable } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { listBookings } from '@/api/endpoints';
import { formatDistance, formatRupees } from '@/api/client';
import type { Booking, BookingStatus } from '@/api/types';
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  StatusBadge,
  Txt,
  sharedStyles,
} from '@/components/ui';
import { colors, spacing, radius, fontSize } from '@/theme/tokens';

type Filter = 'upcoming' | 'past' | 'all';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'past', label: 'Past' },
  { key: 'all', label: 'All' },
];

export default function BookingsScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('upcoming');
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (mode === 'refresh') setRefreshing(true);
      setError(null);

      try {
        const res = await listBookings(filter === 'all' ? {} : {});
        const now = Date.now();
        const all = res.bookings;

        // Filtering happens client-side: the API returns every booking for the
        // account, and an MVP does not need a round trip to hide completed trips.
        const filtered =
          filter === 'upcoming'
            ? all.filter((b) => new Date(b.checkOut).getTime() >= now)
            : filter === 'past'
              ? all.filter((b) => new Date(b.checkOut).getTime() < now)
              : all;

        setBookings(filtered);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load your bookings.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [filter],
  );

  useFocusEffect(
    useCallback(() => {
      void load('initial');
    }, [load]),
  );

  if (loading && bookings.length === 0) {
    return <LoadingState label="Loading your bookings…" />;
  }

  if (error && bookings.length === 0) {
    return <ErrorState message={error} onRetry={() => void load('initial')} />;
  }

  return (
    <FlatList
      data={bookings}
      keyExtractor={(item) => item.bookingRef}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh')} tintColor={colors.primary} />
      }
      ListHeaderComponent={
        <View style={[sharedStyles.row, { marginBottom: spacing.lg, gap: spacing.sm }]}>
          {FILTERS.map((f) => (
            <Pressable
              key={f.key}
              onPress={() => setFilter(f.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: filter === f.key }}
              style={{
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.sm,
                borderRadius: radius.pill,
                backgroundColor: filter === f.key ? colors.primary : colors.surface,
                borderWidth: 1,
                borderColor: filter === f.key ? colors.primary : colors.border,
              }}
            >
              <Txt
                style={{ fontSize: fontSize.sm, fontWeight: '600', color: filter === f.key ? colors.textInverse : colors.textMuted }}
              >
                {f.label}
              </Txt>
            </Pressable>
          ))}
        </View>
      }
      renderItem={({ item }) => <BookingRow booking={item} onPress={() => router.push(`/booking/${item.bookingRef}`)} />}
      ListEmptyComponent={
        filter === 'upcoming' ? (
          <EmptyState
            title="No upcoming stays"
            message="When you book a hostel, it will show up here with your bed details and payment receipt."
          />
        ) : (
          <EmptyState title="Nothing here yet" message="Bookings you complete will be listed here." />
        )
      }
    />
  );
}

function BookingRow({ booking, onPress }: { booking: Booking; onPress: () => void }) {
  const status = booking.status as BookingStatus;
  const isActive = status === 'CONFIRMED' || status === 'CHECKED_IN' || status === 'PENDING_OWNER';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${booking.hostel.name}, ${booking.status}`}
      style={({ pressed }) => ({
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderWidth: 1,
        // A live booking gets a coloured edge so it is distinguishable at a glance
        // in a long list.
        borderColor: isActive ? colors.primaryLight : colors.border,
        padding: spacing.lg,
        marginBottom: spacing.md,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <View style={sharedStyles.rowBetween}>
        <View style={{ flex: 1, marginRight: spacing.md }}>
          <Txt variant="body" weight="700" numberOfLines={1}>
            {booking.hostel.name}
          </Txt>
          <Txt variant="caption" color={colors.textMuted}>
            {booking.hostel.area} · {booking.bed.label}
          </Txt>
        </View>
        <StatusBadge status={status} />
      </View>

      <View style={[sharedStyles.row, { marginTop: spacing.md, flexWrap: 'wrap', gap: spacing.xs }]}>
        <Badge
          label={
            booking.stayType === 'MONTHLY'
              ? `${booking.months} month${booking.months === 1 ? '' : 's'}`
              : booking.stayType === 'DAY_STAY'
                ? 'Day stay'
                : `${booking.days} day${booking.days === 1 ? '' : 's'}`
          }
          tone="neutral"
        />
        <Badge label={formatRupees(booking.totalAmount)} tone="brand" />
      </View>

      <View style={[sharedStyles.rowBetween, { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border }]}>
        <View>
          <Txt variant="caption" color={colors.textFaint}>
            Check-in
          </Txt>
          <Txt variant="body" weight="600">
            {new Date(booking.checkIn).toLocaleDateString('en-IN', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              timeZone: 'UTC',
            })}
          </Txt>
        </View>
        <Txt variant="caption" color={colors.textMuted} weight="600">
          {booking.bookingRef} →
        </Txt>
      </View>
    </Pressable>
  );
}