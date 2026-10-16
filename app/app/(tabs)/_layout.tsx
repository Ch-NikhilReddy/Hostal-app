import { View, Text, Pressable } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { Tabs } from 'expo-router';
import { useAuth } from '@/store/auth';
import { colors, spacing } from '@/theme/tokens';

/** Simple emoji tab icon. Keeps the bundle free of an icon font for an MVP. */
function TabIcon({ emoji, focused }: { emoji: string; focused: boolean }) {
  return (
    <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{emoji}</Text>
  );
}

export default function TabsLayout() {
  const { user } = useAuth();
  const router = useRouter();
  const isOwner = user?.role === 'OWNER';

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: colors.textInverse,
        headerTitleStyle: { fontWeight: '700' },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { borderTopColor: colors.border, height: 62, paddingBottom: 8, paddingTop: 6 },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Explore',
          tabBarIcon: ({ focused }) => <TabIcon emoji="🔍" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="bookings"
        options={{
          title: 'My bookings',
          tabBarIcon: ({ focused }) => <TabIcon emoji="📋" focused={focused} />,
        }}
      />
      {/* The owner tab only appears for owner accounts: a student must never be
          able to reach owner tooling by tapping a tab. `href: null` hides the
          tab (children must all be <Tabs.Screen/>, so we can't conditionally
          omit it without tripping expo-router's layout warning). */}
      <Tabs.Screen
        name="owner"
        options={{
          title: 'Owner',
          href: isOwner ? undefined : null,
          tabBarIcon: ({ focused }) => <TabIcon emoji="🏢" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ focused }) => <TabIcon emoji="👤" focused={focused} />,
        }}
      />
    </Tabs>
  );
}