import { useEffect } from 'react';
import { Redirect, Stack } from 'expo-router';
import { View } from 'react-native';
import { useAuth } from '@/store/auth';
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
        <LoadingState label="Welcome to HostelMitra" />
      </View>
    );
  }

  if (!user) {
    return <Redirect href="/(auth)/login" />;
  }

  return <Redirect href="/(tabs)" />;
}

export function AuthStack() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="register" />
    </Stack>
  );
}