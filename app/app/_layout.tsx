import { Stack, useRootNavigationState } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { useRouter, useSegments } from 'expo-router';
import { colors } from '@/theme/tokens';
import { APP_BUILD } from '@/build-info';
import { useAuth } from '@/store/auth';
import { LoadingState } from '@/components/ui';

// Start the root navigator on the auth group. Without this, the URL `/` resolves
// to the tabs' index route, so a signed-out launch briefly mounts the Explore
// screen (and fires its search request) before being redirected to sign-in.
export const unstable_settings = {
  initialRouteName: '(auth)',
};

/**
 * Root layout.
 *
 * Auth is bootstrapped here, once, rather than per-screen: the splash gate needs
 * to know whether a persisted session exists before it decides which stack to
 * render, and doing it in each screen produces a visible flash on every cold
 * start.
 */
export default function RootLayout() {
  const { user, isBootstrapping, bootstrap } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const navigationState = useRootNavigationState();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (isBootstrapping || !navigationState?.key) return;
    const inAuth = segments[0] === '(auth)';
    if (!user && !inAuth) {
      router.replace('/(auth)/login');
    } else if (user && inAuth) {
      router.replace('/(tabs)');
    }
  }, [user, isBootstrapping, segments, router, navigationState?.key]);

  if (isBootstrapping) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: 'center' }}>
          <LoadingState label={`Welcome to HostelMitra · ${APP_BUILD}`} />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.primary },
          headerTintColor: colors.textInverse,
          headerTitleStyle: { fontWeight: '700' },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="hostel/[slug]" options={{ title: 'Hostel details' }} />
        <Stack.Screen name="booking/payment" options={{ title: 'Confirm and pay' }} />
        <Stack.Screen name="booking/success" options={{ title: 'Booking confirmed', headerShown: false }} />
        <Stack.Screen name="booking/[ref]" options={{ title: 'Booking' }} />
        <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
        <Stack.Screen name="owner/index" options={{ title: 'Owner dashboard' }} />
      </Stack>
    </SafeAreaProvider>
  );
}