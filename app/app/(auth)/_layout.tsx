import { useEffect } from 'react';
import { Redirect, Stack } from 'expo-router';
import { View } from 'react-native';
import { useAuth } from '@/store/auth';
import { APP_BUILD } from '@/build-info';
import { LoadingState } from '@/components/ui';

/**
 * Auth gate.
 *
 * Holds the splash while the persisted session is read from SecureStore, then
 * routes to the tabs or the login flow. `isBootstrapping` exists precisely so this
 * can wait — without it the app would flash the login screen for signed-in users.
 */
export default function AuthLayout() {
  const { user, isBootstrapping, bootstrap } = useAuth();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (isBootstrapping) {
    return (
      <View style={{ flex: 1, backgroundColor: '#F8FAFC', justifyContent: 'center' }}>
        <LoadingState label={`Welcome to HostelMitra · ${APP_BUILD}`} />
      </View>
    );
  }

  // Signed in: leave the auth group for the app tabs.
  if (user) {
    return <Redirect href="/(tabs)" />;
  }

  // Signed out: render the sign-in flow. This MUST render the nested Stack —
  // redirecting back to `/(auth)/login` from the group that owns `login` makes
  // expo-router redirect to itself on every render and the app never settles.
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
    </Stack>
  );
}
