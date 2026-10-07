import { Pressable, ScrollView, View } from 'react-native';
import { formatDistance, formatRupees, formatRupeesCompact } from '@/api/client';
import type { HostelSearchResult } from '@/api/types';
import {
  AmenityStrip,
  Badge,
  HostelPhoto,
  Txt,
  genderLabel,
  sharedStyles,
  sharingLabel,
} from '@/components/ui';
import { colors, radius, spacing, fontSize } from '@/theme/tokens';

/**
 * Hostel card for search results and lists.
 *
 * Shows the three facts a student actually decides on — rent, distance, and
 * whether a bed is free — with everything else secondary. Bed count is
 * prominent because an empty result set for the chosen dates is the most common
 * reason a search leads nowhere.
 */
export function HostelCard({
  hostel,
  onPress,
  showDistance = true,
}: {
  hostel: HostelSearchResult;
  onPress: () => void;
  showDistance?: boolean;
}) {
  const cheapestRoom = [...hostel.roomTypes].sort((a, b) => a.monthlyRent - b.monthlyRent)[0];
  const freeBeds = hostel.roomTypes.reduce((sum, rt) => sum + (rt.availableBeds ?? 0), 0);
  const totalBeds = hostel.roomTypes.reduce((sum, rt) => sum + (rt.totalBeds ?? 0), 0);
  const hasAvailabilityWindow = cheapestRoom?.totalBeds !== null && cheapestRoom?.totalBeds !== undefined;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${hostel.name}, ${genderLabel(hostel.gender)}, from ${formatRupees(hostel.minMonthlyRent)} per month`}
      style={({ pressed }) => ({
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        overflow: 'hidden',
        marginBottom: spacing.lg,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <HostelPhoto uri={hostel.photos[0]} height={160} />

      <View style={{ padding: spacing.lg }}>
        <View style={sharedStyles.rowBetween}>
          <View style={{ flex: 1, marginRight: spacing.md }}>
            <Txt variant="subtitle" weight="700" numberOfLines={1}>
              {hostel.name}
            </Txt>
            <View style={[sharedStyles.row, { marginTop: 2, flexWrap: 'wrap' }]}>
              <Txt variant="caption" color={colors.textMuted}>
                {hostel.area}, {hostel.city}
              </Txt>
              {showDistance && hostel.distanceKm !== null ? (
                <>
                  <Txt variant="caption" color={colors.textFaint}>
                    {'  ·  '}
                  </Txt>
                  <Txt variant="caption" color={colors.primary} weight="600">
                    {formatDistance(hostel.distanceKm)}
                    {hostel.travelMinutes ? ` · ${hostel.travelMinutes} min` : ''}
                  </Txt>
                </>
              ) : null}
            </View>
          </View>

          {hostel.ratingAverage ? (
            <Badge label={`★ ${Number(hostel.ratingAverage).toFixed(1)}`} tone="warning" />
          ) : null}
        </View>

        <View style={[sharedStyles.row, { marginTop: spacing.md, flexWrap: 'wrap', gap: spacing.xs }]}>
          <Badge label={genderLabel(hostel.gender)} tone="brand" />
          {cheapestRoom ? <Badge label={sharingLabel(cheapestRoom.sharingType)} tone="neutral" /> : null}
          {hostel.foodIncluded ? <Badge label="Meals included" tone="success" /> : null}
          {hasAvailabilityWindow ? (
            freeBeds > 0 ? (
              <Badge
                label={freeBeds <= 3 ? `Only ${freeBeds} bed${freeBeds === 1 ? '' : 's'} left` : `${freeBeds} beds free`}
                tone={freeBeds <= 3 ? 'warning' : 'success'}
              />
            ) : (
              <Badge label="No beds for these dates" tone="danger" />
            )
          ) : null}
        </View>

        {hostel.amenities.length > 0 ? (
          <View style={{ marginTop: spacing.md }}>
            <AmenityStrip amenities={hostel.amenities} max={4} />
          </View>
        ) : null}

        <View style={[sharedStyles.rowBetween, { marginTop: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border }]}>
          <View>
            <Txt variant="caption" color={colors.textMuted}>
              Starts at
            </Txt>
            <View style={sharedStyles.row}>
              <Txt variant="title" weight="700" color={colors.primary}>
                {formatRupees(hostel.minMonthlyRent)}
              </Txt>
              <Txt variant="caption" color={colors.textMuted} style={{ marginLeft: 4, marginBottom: 4 }}>
                /month
              </Txt>
            </View>
          </View>

          {hostel.depositAmount > 0 ? (
            <View style={{ alignItems: 'flex-end' }}>
              <Txt variant="caption" color={colors.textMuted}>
                Deposit
              </Txt>
              <Txt variant="subtitle" weight="600">
                {formatRupeesCompact(hostel.depositAmount)}
              </Txt>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/** Minimal row used in pickers and search suggestions. */
export function HostelRow({ hostel, onPress }: { hostel: HostelSearchResult; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        backgroundColor: colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <HostelPhoto uri={hostel.photos[0]} height={56} width={56} />
      <View style={{ flex: 1, marginLeft: spacing.md }}>
        <Txt variant="body" weight="600" numberOfLines={1}>
          {hostel.name}
        </Txt>
        <Txt variant="caption" color={colors.textMuted} numberOfLines={1}>
          {hostel.area}
          {hostel.distanceKm !== null ? ` · ${formatDistance(hostel.distanceKm)}` : ''}
        </Txt>
      </View>
      <Txt variant="body" weight="700" color={colors.primary}>
        {formatRupeesCompact(hostel.minMonthlyRent)}
      </Txt>
    </Pressable>
  );
}

/** Horizontal list, used on the home screen. */
export function HostelCarousel({
  hostels,
  onSelect,
  title,
}: {
  hostels: HostelSearchResult[];
  onSelect: (hostel: HostelSearchResult) => void;
  title: string;
}) {
  if (hostels.length === 0) return null;

  return (
    <View style={{ marginTop: spacing.xl }}>
      <View style={[sharedStyles.section, { marginTop: 0 }]}>
        <Txt variant="subtitle" weight="700">
          {title}
        </Txt>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.md }}
      >
        {hostels.map((h) => (
          <Pressable
            key={h.id}
            onPress={() => onSelect(h)}
            accessibilityRole="button"
            accessibilityLabel={h.name}
            style={({ pressed }) => ({
              width: 260,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface,
              overflow: 'hidden',
              opacity: pressed ? 0.9 : 1,
            })}
          >
            <HostelPhoto uri={h.photos[0]} height={110} />
            <View style={{ padding: spacing.md }}>
              <Txt variant="body" weight="600" numberOfLines={1}>
                {h.name}
              </Txt>
              <Txt variant="caption" color={colors.textMuted} numberOfLines={1}>
                {h.area}
                {h.distanceKm !== null ? ` · ${formatDistance(h.distanceKm)}` : ''}
              </Txt>
              <View style={[sharedStyles.row, { marginTop: spacing.sm }]}>
                <Txt variant="subtitle" weight="700" color={colors.primary}>
                  {formatRupees(h.minMonthlyRent)}
                </Txt>
                <Txt variant="caption" color={colors.textMuted}>
                  {' '}
                  /mo
                </Txt>
              </View>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}