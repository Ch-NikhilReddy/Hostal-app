import { View, ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { formatRupees } from '@/api/client';
import { Button, Card, Txt, sharedStyles } from '@/components/ui';
import { colors, spacing, radius, fontSize } from '@/theme/tokens';

export default function SuccessScreen() {
  const router = useRouter();
  const { bookingRef, hostelName, totalAmount } = useLocalSearchParams<{
    bookingRef: string;
    hostelName: string;
    totalAmount: string;
  }>();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingTop: 80 }}>
        {/* Success mark */}
        <View style={{ alignItems: 'center' }}>
          <View
            style={{
              width: 88,
              height: 88,
              borderRadius: 44,
              backgroundColor: colors.successFaint,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: spacing.xl,
            }}
          >
            <Txt style={{ fontSize: 44 }}>✓</Txt>
          </View>

          <Txt variant="title" weight="700" style={{ textAlign: 'center' }}>
            Payment received
          </Txt>
          <Txt variant="body" color={colors.textMuted} style={{ textAlign: 'center', marginTop: spacing.sm }}>
            {hostelName} has your request and will confirm shortly. We will notify you as soon as they do.
          </Txt>
        </View>

        {/* Reference card */}
        <Card style={{ marginTop: spacing.xl }}>
          <View style={sharedStyles.rowBetween}>
            <View>
              <Txt variant="caption" color={colors.textMuted}>
                BOOKING REFERENCE
              </Txt>
              <Txt variant="title" weight="700" color={colors.primary} style={{ marginTop: 2 }}>
                {bookingRef}
              </Txt>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Txt variant="caption" color={colors.textMuted}>
                AMOUNT PAID
              </Txt>
              <Txt variant="subtitle" weight="700" style={{ marginTop: 2 }}>
                {formatRupees(Number(totalAmount))}
              </Txt>
            </View>
          </View>

          <Txt variant="caption" color={colors.textFaint} style={{ marginTop: spacing.md }}>
            Quote this reference if you contact the hostel. Keep it for your records.
          </Txt>
        </Card>

        {/* What next */}
        <Card style={{ marginTop: spacing.lg }}>
          <Txt variant="label" weight="600" color={colors.textMuted} style={{ marginBottom: spacing.md }}>
            NEXT STEPS
          </Txt>
          <NextStep text="The hostel reviews your request and confirms the bed." />
          <NextStep text="You receive a push notification the moment it is confirmed." />
          <NextStep text="Find the booking, your receipt and the hostel phone number under My bookings." last />
        </Card>

        <Button
          label="View my bookings"
          onPress={() => router.replace('/(tabs)/bookings')}
          size="lg"
          fullWidth
          style={{ marginTop: spacing.xl }}
          testID="view-bookings"
        />
        <Button
          label="Back to explore"
          variant="ghost"
          onPress={() => router.replace('/(tabs)')}
          fullWidth
          style={{ marginTop: spacing.sm }}
        />
      </ScrollView>
    </View>
  );
}

function NextStep({ text, last }: { text: string; last?: boolean }) {
  return (
    <View style={[sharedStyles.row, { marginBottom: last ? 0 : spacing.md, alignItems: 'flex-start' }]}>
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
      <Txt variant="body" color={colors.textMuted} style={{ flex: 1 }}>
        {text}
      </Txt>
    </View>
  );
}