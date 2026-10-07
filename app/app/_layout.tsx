import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { colors } from '@/theme/tokens';

/**
 * Root layout.
 *
 * Auth is bootstrapped here, once, rather than per-screen: the splash gate needs
 * to know whether a persisted session exists before it decides which stack to
 * render, and doing it in each screen produces a visible flash on every cold
 * start.
 */
export default function RootLayout() {
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