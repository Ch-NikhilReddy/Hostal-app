import { useEffect, useRef, useState } from 'react';
import { View, KeyboardAvoidingView, Platform, ScrollView, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, Divider, Input, Txt, sharedStyles } from '@/components/ui';
import { colors, spacing, fontSize, radius } from '@/theme/tokens';
import { useAuth } from '@/store/auth';

/** Indian mobiles are 10 digits starting 6–9. */
function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(-10);
  return digits;
}

export default function LoginScreen() {
  const router = useRouter();
  const { startLogin, completeLogin, devOtp, clearDevOtp, error, clearError, isAuthenticating } = useAuth();

  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const codeInputRef = useRef<View>(null);

  const digits = normalisePhone(phone);
  const phoneValid = /^[6-9]\d{9}$/.test(digits);

  // Clear the code whenever a new one is issued, so a stale six-digit value cannot
  // be submitted against a fresh OTP.
  useEffect(() => {
    if (step === 'otp') setCode('');
  }, [step]);

  async function onSendCode() {
    setLocalError(null);
    clearError();
    if (!phoneValid) {
      setLocalError('Enter a valid 10-digit mobile number.');
      return;
    }
    const ok = await startLogin(digits);
    if (ok) setStep('otp');
  }

  async function onVerify() {
    setLocalError(null);
    clearError();
    if (code.length !== 6) {
      setLocalError('Enter the 6-digit code.');
      return;
    }
    await completeLogin({ phone: digits, code, name: name || undefined });
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.primary }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
        {/* Brand header */}
        <View style={{ paddingHorizontal: spacing.xl, paddingTop: 72, paddingBottom: spacing.xxl }}>
          <Txt variant="display" weight="700" color={colors.textInverse}>
            HostelMitra
          </Txt>
          <Txt variant="body" color="#CCFBF1" style={{ marginTop: spacing.sm }}>
            Hostels and PGs near your college, booked in under a minute.
          </Txt>
        </View>

        {/* Card */}
        <View style={{ flex: 1, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, backgroundColor: colors.background, paddingHorizontal: spacing.xl, paddingTop: spacing.xl }}>
          {step === 'phone' ? (
            <>
              <Txt variant="title" weight="700">
                Sign in
              </Txt>
              <Txt variant="body" color={colors.textMuted} style={{ marginTop: spacing.xs, marginBottom: spacing.xl }}>
                We will send a one-time code to your mobile. No password needed.
              </Txt>

              <Input
                label="Mobile number"
                value={phone}
                onChangeText={(v) => setPhone(v)}
                placeholder="98765 43210"
                keyboardType="phone-pad"
                maxLength={14}
                autoFocus
                testID="phone-input"
                error={localError ?? error}
              />

              <Button
                label="Send code"
                onPress={() => void onSendCode()}
                size="lg"
                fullWidth
                loading={isAuthenticating}
                disabled={!phoneValid}
                testID="send-code"
              />

              <Pressable
                onPress={() => router.push('/(auth)/register')}
                accessibilityRole="button"
                style={{ marginTop: spacing.xl, alignItems: 'center', paddingVertical: spacing.md }}
              >
                <Txt variant="body" color={colors.primary} weight="600">
                  Are you a hostel owner? List your property →
                </Txt>
              </Pressable>
            </>
          ) : (
            <>
              <Txt variant="title" weight="700">
                Enter the code
              </Txt>
              <Txt variant="body" color={colors.textMuted} style={{ marginTop: spacing.xs, marginBottom: spacing.xl }}>
                Sent to +91 {digits}
              </Txt>

              {/* In development the API echoes the OTP so the flow works with no SMS
                  provider configured. It is never present in a production build. */}
              {devOtp ? (
                <Card style={{ marginBottom: spacing.lg, backgroundColor: colors.warningFaint, borderColor: colors.warning }}>
                  <Txt variant="label" weight="700" color={colors.warning}>
                    DEVELOPMENT MODE
                  </Txt>
                  <Txt variant="title" weight="700" color={colors.warning} style={{ marginTop: spacing.xs }}>
                    {devOtp}
                  </Txt>
                  <Txt variant="caption" color={colors.warning} style={{ marginTop: spacing.xs }}>
                    No SMS provider is configured, so the code is shown here.
                  </Txt>
                  <Button
                    label="Fill it in"
                    variant="outline"
                    size="sm"
                    onPress={() => setCode(devOtp)}
                    style={{ marginTop: spacing.md }}
                  />
                </Card>
              ) : null}

              <Input
                label="6-digit code"
                value={code}
                onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
                placeholder="••••••"
                keyboardType="numeric"
                maxLength={6}
                autoFocus
                testID="otp-input"
                error={localError ?? error}
              />

              <Input
                label="Your name (first time only)"
                value={name}
                onChangeText={setName}
                placeholder="Ayesha Khan"
                testID="name-input"
                hint="Optional now — you can add it later from your profile."
              />

              <Button
                label="Verify and continue"
                onPress={() => void onVerify()}
                size="lg"
                fullWidth
                loading={isAuthenticating}
                disabled={code.length !== 6}
                testID="verify-code"
              />

              <Divider style={{ marginVertical: spacing.xl }} />

              <View style={sharedStyles.rowBetween}>
                <Pressable
                  onPress={() => {
                    clearDevOtp();
                    setStep('phone');
                  }}
                  accessibilityRole="button"
                >
                  <Txt variant="body" color={colors.textMuted} weight="600">
                    Change number
                  </Txt>
                </Pressable>
                <Pressable onPress={() => void onSendCode()} accessibilityRole="button">
                  <Txt variant="body" color={colors.primary} weight="600">
                    Resend code
                  </Txt>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}