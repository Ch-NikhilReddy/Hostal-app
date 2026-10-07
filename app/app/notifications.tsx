import { useCallback, useState } from 'react';
import { View, FlatList, RefreshControl, Pressable } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { listNotifications, markNotificationsRead } from '@/api/endpoints';
import type { Notification } from '@/api/types';
import { EmptyState, ErrorState, LoadingState, Txt } from '@/components/ui';
import { colors, spacing, radius } from '@/theme/tokens';

export default function NotificationsScreen() {
  const router = useRouter();
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
    if (mode === 'refresh') setRefreshing(true);
    setError(null);
    try {
      const res = await listNotifications();
      setItems(res.notifications);

      // Opening the screen is the read receipt. Only unread rows are touched, and
      // the API scopes the update to the caller's own notifications, so this
      // cannot mark anyone else's as read.
      if (res.unreadCount > 0) {
        await markNotificationsRead();
        setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load notifications.');
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

  function open(notification: Notification) {
    const data = notification.data as { bookingRef?: string } | null;
    if (data?.bookingRef) {
      router.push(`/booking/${data.bookingRef}`);
    }
  }

  if (loading && items.length === 0) return <LoadingState label="Loading notifications…" />;
  if (error && items.length === 0) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh')} tintColor={colors.primary} />
      }
      renderItem={({ item }) => {
        const unread = !item.readAt;
        const data = item.data as { bookingRef?: string } | null;

        return (
          <Pressable
            onPress={() => open(item)}
            disabled={!data?.bookingRef}
            accessibilityRole={data?.bookingRef ? 'button' : 'text'}
            style={({ pressed }) => ({
              backgroundColor: unread ? colors.primaryFaint : colors.surface,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: unread ? colors.primaryLight : colors.border,
              padding: spacing.lg,
              marginBottom: spacing.md,
              opacity: pressed ? 0.9 : 1,
            })}
          >
            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
              {unread ? (
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: colors.primary,
                    marginTop: 6,
                    marginRight: spacing.md,
                  }}
                />
              ) : null}
              <View style={{ flex: 1 }}>
                <Txt variant="body" weight={unread ? '700' : '600'}>
                  {item.title}
                </Txt>
                <Txt variant="body" color={colors.textMuted} style={{ marginTop: 2 }}>
                  {item.body}
                </Txt>
                <Txt variant="caption" color={colors.textFaint} style={{ marginTop: spacing.xs }}>
                  {new Date(item.createdAt).toLocaleString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                  {data?.bookingRef ? ` · ${data.bookingRef}` : ''}
                </Txt>
              </View>
            </View>
          </Pressable>
        );
      }}
      ListEmptyComponent={
        <EmptyState
          title="No notifications"
          message="Booking confirmations, payment receipts and hostel responses will appear here."
        />
      }
    />
  );
}