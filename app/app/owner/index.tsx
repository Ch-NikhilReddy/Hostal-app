import { useEffect, useState } from 'react';
import { View, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { createBooking, getHostel } from '@/api/endpoints';
import { formatRupees } from '@/api/client';
import type { HostelDetail } from '@/api/types';
import {
  Button,
  Card,
  Divider,
  ErrorState,
  HostelPhoto,
  LoadingState,
  Txt,
  genderLabel,
  sharedStyles,
} from '@/components/ui';
import { colors, spacing, radius } from '@/theme/tokens';

type Mode = 'date' | 'bed';

export default function CreateHostelScreen() {
  const router = useRouter();
  const { step, slug } = useLocalSearchParams<{ step?: string; slug?: string }>();

  const [hostel, setHostel] = useState<HostelDetail | null>(null);
  const [roomTypeId, setRoomTypeId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>((step as Mode) ?? 'date');

  useEffect(() => {
    if (slug) void getHostel(slug).then(setHostel).catch(() => undefined);
  }, [slug]);

  if (!hostel) return <LoadingState />;

  const rooms = hostel.hostel.roomTypes;

  return (
    <View style={{ flex: 1 }}>
      <Card>
        <Txt variant="caption" color={colors.textMuted}>
          ADDING A BED TO
        </Txt>
        <Txt variant="subtitle" weight="700">
          {hostel.hostel.name}
        </Txt>
      </Card>

      {mode === 'date' ? (
        <View style={{ padding: spacing.lg }}>
          <Txt variant="subtitle" weight="700" style={{ marginBottom: spacing.md }}>
            Which room type?
          </Txt>
          {rooms.map((rt) => (
            <Pressable
              key={rt.id}
              onPress={() => setRoomTypeId(rt.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected: roomTypeId === rt.id }}
              style={{
                borderRadius: radius.md,
                borderWidth: 2,
                borderColor: roomTypeId === rt.id ? colors.primary : colors.border,
                backgroundColor: roomTypeId === rt.id ? colors.primaryFaint : colors.surface,
                padding: spacing.md,
                marginBottom: spacing.sm,
              }}
            >
              <View style={sharedStyles.rowBetween}>
                <Txt variant="body" weight="700">
                  {rt.name}
                </Txt>
                <Txt variant="body" weight="600" color={colors.primary}>
                  {formatRupees(rt.monthlyRent)}
                </Txt>
              </View>
              <Txt variant="caption" color={colors.textMuted}>
                {genderLabel(rt.gender)}
                {rt.shortStayDailyRent ? ` · short stay ${formatRupees(rt.shortStayDailyRent)}/day` : ''}
              </Txt>
            </Pressable>
          ))}
        </View>
      ) : (
        <View style={{ padding: spacing.lg }}>
          <Txt variant="body" color={colors.textMuted}>
            Bed-level booking is available through the owner dashboard. Pick a room type first.
          </Txt>
        </View>
      )}
    </View>
  );
}