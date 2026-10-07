import { View, ScrollView, Pressable, RefreshControl } from 'react-native';
import { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { formatRupees } from '@/api/client';
import { getMe, getOwnerDashboard, updateMe } from '@/api/endpoints';
import type { College } from '@/api/types';
import { listColleges } from '@/api/endpoints';
import {
  Badge,
  Button,
  Card,
  Divider,
  ErrorState,
  Input,
  LoadingState,
  Txt,
  sharedStyles,
} from '@/components/ui';
import { colors, spacing, radius, fontSize } from '@/theme/tokens';
import { useAuth } from '@/store/auth';

export default function ProfileScreen() {
  const router = useRouter();
  const { user, refreshUser, signOut } = useAuth();

  const [colleges, setColleges] = useState<College[]>([]);
  const [name, setName] = useState(user?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dashboard, setDashboard] = useState<{ pendingApprovals: number } | null>(null);

  const isOwner = user?.role === 'OWNER' || user?.role === 'ADMIN';

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      await listColleges().then((res) => setColleges(res.colleges));
      await refreshUser();
      if (isOwner) {
        const res = await getOwnerDashboard();
        setDashboard({ pendingApprovals: res.pendingApprovals });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your profile.');
    } finally {
      setRefreshing(false);
    }
  }, [isOwner, refreshUser]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await updateMe({ name: name || undefined });
      await refreshUser();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  if (!user) return <LoadingState />;

  const ownCollege = colleges.find((c) => c.id === user.collegeId);

  return (
    <ScrollView
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load()} tintColor={colors.primary} />}
    >
      {/* Identity */}
      <Card>
        <View style={[sharedStyles.row, { marginBottom: spacing.lg }]}>
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: colors.primaryFaint,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Txt variant="title" weight="700" color={colors.primaryDark}>
              {user.name.charAt(0).toUpperCase()}
            </Txt>
          </View>
          <View style={{ marginLeft: spacing.md, flex: 1 }}>
            <Txt variant="subtitle" weight="700">
              {user.name}
            </Txt>
            <Txt variant="caption" color={colors.textMuted}>
              +91 {user.phone}
            </Txt>
            <View style={[sharedStyles.row, { marginTop: spacing.xs, gap: spacing.xs }]}>
              <Badge label={user.role === 'STUDENT' ? 'Student' : user.role === 'OWNER' ? 'Hostel owner' : 'Admin'} tone="brand" />
              {user.verified ? <Badge label="Verified" tone="success" /> : <Badge label="Unverified" tone="warning" />}
            </View>
          </View>
        </View>

        <Input label="Name" value={name} onChangeText={setName} placeholder="Your name" testID="profile-name" />

        <Txt variant="label" weight="600" color={colors.textMuted}>
          COLLEGE
        </Txt>
        <View style={[sharedStyles.row, { flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm, marginBottom: spacing.lg }]}>
          {colleges.slice(0, 8).map((c) => (
            <Pressable
              key={c.id}
              onPress={async () => {
                await updateMe({ collegeId: c.id });
                await refreshUser();
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: user.collegeId === c.id }}
              style={{
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.sm,
                borderRadius: radius.pill,
                backgroundColor: user.collegeId === c.id ? colors.primary : colors.surface,
                borderWidth: 1,
                borderColor: user.collegeId === c.id ? colors.primary : colors.border,
              }}
            >
              <Txt
                style={{
                  fontSize: fontSize.xs,
                  fontWeight: '600',
                  color: user.collegeId === c.id ? colors.textInverse : colors.textMuted,
                }}
              >
                {c.name.split(' ').slice(0, 2).join(' ')}
              </Txt>
            </Pressable>
          ))}
        </View>
        {ownCollege ? (
          <Txt variant="caption" color={colors.textMuted} style={{ marginBottom: spacing.md }}>
            Explore now defaults to hostels near {ownCollege.name}.
          </Txt>
        ) : null}

        <Button label={saved ? 'Saved' : 'Save changes'} onPress={() => void save()} loading={saving} disabled={saved} />
        {error ? <Txt variant="caption" color={colors.danger}>{error}</Txt> : null}
      </Card>

      {/* Owner shortcut */}
      {isOwner ? (
        <Card style={{ marginTop: spacing.lg }}>
          <View style={sharedStyles.rowBetween}>
            <View style={{ flex: 1 }}>
              <Txt variant="body" weight="700">
                Owner dashboard
              </Txt>
              <Txt variant="caption" color={colors.textMuted}>
                Manage your properties, beds and bookings.
              </Txt>
            </View>
            {dashboard && dashboard.pendingApprovals > 0 ? (
              <Badge label={`${dashboard.pendingApprovals} new`} tone="warning" />
            ) : null}
          </View>
          <Button
            label="Open owner dashboard"
            variant="secondary"
            fullWidth
            onPress={() => router.push('/owner')}
            style={{ marginTop: spacing.md }}
          />
        </Card>
      ) : null}

      {/* Notifications */}
      <Card style={{ marginTop: spacing.lg }}>
        <Txt variant="body" weight="700">
          Notifications
        </Txt>
        <Txt variant="caption" color={colors.textMuted} style={{ marginBottom: spacing.md }}>
          Booking confirmations and payment receipts.
        </Txt>
        <Button label="View notifications" variant="outline" fullWidth onPress={() => router.push('/notifications')} />
      </Card>

      {/* Account */}
      <Card style={{ marginTop: spacing.lg }}>
        <Txt variant="body" weight="700" style={{ marginBottom: spacing.md }}>
          Account
        </Txt>
        <Divider style={{ marginBottom: spacing.md }} />
        <View style={sharedStyles.rowBetween}>
          <View>
            <Txt variant="body" weight="600">
              Sign out
            </Txt>
            <Txt variant="caption" color={colors.textMuted}>
              You will need a new code to sign back in.
            </Txt>
          </View>
          <Button label="Sign out" variant="danger" onPress={() => void signOut()} />
        </View>
      </Card>

      <Txt variant="caption" color={colors.textFaint} style={{ textAlign: 'center', marginTop: spacing.xl }}>
        HostelMitra · MVP{'\n'}Hostels and PGs across Hyderabad
      </Txt>
    </ScrollView>
  );
}