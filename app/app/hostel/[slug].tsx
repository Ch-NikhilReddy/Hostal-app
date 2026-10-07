import { useEffect, useState } from 'react';
import { View, ScrollView, Pressable, Image, Dimensions } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { getHostel } from '@/api/endpoints';
import { formatDistance, formatRupees } from '@/api/client';
import type { HostelDetail } from '@/api/types';
import { BookingPanel } from '@/components/booking-panel';
import {
  Badge,
  Card,
  Divider,
  ErrorState,
  HostelPhoto,
  LoadingState,
  Txt,
  amenityLabel,
  genderLabel,
  sharedStyles,
} from '@/components/ui';
import { colors, spacing, radius, fontSize } from '@/theme/tokens';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

type Tab = 'about' | 'rooms' | 'location' | 'book';

export default function HostelScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();

  const [data, setData] = useState<HostelDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('about');
  const [photoIndex, setPhotoIndex] = useState(0);

  async function load() {
    if (!slug) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getHostel(slug);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this hostel.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  if (loading) return <LoadingState label="Loading hostel…" />;
  if (error || !data) {
    return <ErrorState message={error ?? 'Hostel not found.'} onRetry={() => void load()} />;
  }

  const { hostel } = data;
  const cheapest = [...hostel.roomTypes].sort((a, b) => a.monthlyRent - b.monthlyRent)[0];
  const totalFreeBeds = hostel.roomTypes.reduce((sum, rt) => sum + (rt.availableBeds ?? 0), 0);
  const photos = hostel.photos.length > 0 ? hostel.photos : [];

  const TABS: { key: Tab; label: string }[] = [
    { key: 'about', label: 'About' },
    { key: 'rooms', label: 'Rooms & rent' },
    { key: 'location', label: 'Location' },
    { key: 'book', label: 'Book now' },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 100 }}>
        {/* Photo gallery */}
        {photos.length > 0 ? (
          <View>
            <HostelPhoto uri={photos[photoIndex]} height={240} />
            {photos.length > 1 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ padding: spacing.sm, gap: spacing.sm }}
              >
                {photos.map((photo, i) => (
                  <Pressable key={photo} onPress={() => setPhotoIndex(i)} accessibilityRole="button">
                    <Image
                      source={{ uri: photo }}
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: radius.sm,
                        borderWidth: i === photoIndex ? 2 : 1,
                        borderColor: i === photoIndex ? colors.primary : colors.border,
                      }}
                    />
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
          </View>
        ) : (
          <HostelPhoto height={200} />
        )}

        <View style={{ padding: spacing.lg }}>
          {/* Header */}
          <Txt variant="title" weight="700">
            {hostel.name}
          </Txt>
          <Txt variant="body" color={colors.textMuted} style={{ marginTop: 2 }}>
            {hostel.addressLine}, {hostel.area}, {hostel.city}
            {hostel.pincode ? ` — ${hostel.pincode}` : ''}
          </Txt>

          <View style={[sharedStyles.row, { marginTop: spacing.md, flexWrap: 'wrap', gap: spacing.xs }]}>
            <Badge label={genderLabel(hostel.gender)} tone="brand" />
            <Badge label={hostel.type.replace(/_/g, ' ')} tone="neutral" />
            {hostel.foodIncluded ? <Badge label="Meals included" tone="success" /> : null}
            {hostel.ratingAverage ? (
              <Badge label={`★ ${Number(hostel.ratingAverage).toFixed(1)} (${hostel.ratingCount})`} tone="warning" />
            ) : null}
            {hostel.college ? <Badge label={`Near ${hostel.college.name.split(' ')[0]}`} tone="info" /> : null}
          </View>

          {/* Price teaser */}
          {cheapest ? (
            <Card style={{ marginTop: spacing.lg }}>
              <View style={sharedStyles.rowBetween}>
                <View>
                  <Txt variant="caption" color={colors.textMuted}>
                    Monthly rent from
                  </Txt>
                  <View style={sharedStyles.row}>
                    <Txt variant="title" weight="700" color={colors.primary}>
                      {formatRupees(cheapest.monthlyRent)}
                    </Txt>
                    <Txt variant="caption" color={colors.textMuted} style={{ marginLeft: 4, marginBottom: 4 }}>
                      /bed
                    </Txt>
                  </View>
                </View>
                {hostel.depositAmount > 0 ? (
                  <View style={{ alignItems: 'flex-end' }}>
                    <Txt variant="caption" color={colors.textMuted}>
                      Deposit
                    </Txt>
                    <Txt variant="subtitle" weight="600">
                      {formatRupees(hostel.depositAmount)}
                    </Txt>
                  </View>
                ) : null}
              </View>

              {cheapest.shortStayDailyRent ? (
                <Divider style={{ marginVertical: spacing.md }} />
              ) : null}
              {cheapest.shortStayDailyRent ? (
                <View style={sharedStyles.rowBetween}>
                  <Txt variant="caption" color={colors.textMuted}>
                    Short stay from
                  </Txt>
                  <Txt variant="body" weight="600">
                    {formatRupees(cheapest.shortStayDailyRent)}/day
                  </Txt>
                </View>
              ) : null}
              {cheapest.dayStayDailyRent ? (
                <View style={[sharedStyles.rowBetween, { marginTop: spacing.sm }]}>
                  <Txt variant="caption" color={colors.textMuted}>
                    Day stay from
                  </Txt>
                  <Txt variant="body" weight="600">
                    {formatRupees(cheapest.dayStayDailyRent)}/day
                  </Txt>
                </View>
              ) : null}
            </Card>
          ) : null}

          {/* Tabs */}
          <View style={[sharedStyles.row, { marginTop: spacing.xl, marginHorizontal: -spacing.lg, paddingHorizontal: spacing.lg, gap: spacing.sm }]}>
            {TABS.map((t) => (
              <Pressable
                key={t.key}
                onPress={() => setTab(t.key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === t.key }}
                testID={`tab-${t.key}`}
                style={{
                  flex: 1,
                  paddingVertical: spacing.sm,
                  borderRadius: radius.md,
                  backgroundColor: tab === t.key ? colors.primary : colors.surface,
                  borderWidth: 1,
                  borderColor: tab === t.key ? colors.primary : colors.border,
                  alignItems: 'center',
                }}
              >
                <Txt
                  numberOfLines={1}
                  style={{
                    fontSize: fontSize.xs,
                    fontWeight: '700',
                    color: tab === t.key ? colors.textInverse : colors.textMuted,
                  }}
                >
                  {t.label}
                </Txt>
              </Pressable>
            ))}
          </View>

          <View style={{ marginTop: spacing.lg }}>
            {tab === 'about' ? (
              <>
                {hostel.description ? (
                  <>
                    <Txt variant="subtitle" weight="700" style={{ marginBottom: spacing.sm }}>
                      About this place
                    </Txt>
                    <Txt variant="body" color={colors.textMuted}>
                      {hostel.description}
                    </Txt>
                  </>
                ) : null}

                <Txt variant="subtitle" weight="700" style={{ marginTop: spacing.xl, marginBottom: spacing.md }}>
                  Amenities
                </Txt>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
                  {hostel.amenities.length > 0 ? (
                    hostel.amenities.map((a) => <Badge key={a} label={amenityLabel(a)} tone="neutral" />)
                  ) : (
                    <Txt variant="body" color={colors.textMuted}>
                      Amenities have not been listed yet.
                    </Txt>
                  )}
                </View>

                <Txt variant="subtitle" weight="700" style={{ marginTop: spacing.xl, marginBottom: spacing.md }}>
                  House rules
                </Txt>
                <Card>
                  <DetailRow label="Cancellation notice" value={`${hostel.noticePeriodDays} days`} />
                  <DetailRow label="Security deposit" value={formatRupees(hostel.depositAmount)} />
                  <DetailRow label="Meals" value={hostel.foodIncluded ? 'Included in rent' : 'Not included'} />
                </Card>
              </>
            ) : null}

            {tab === 'rooms' ? (
              <>
                <Txt variant="subtitle" weight="700" style={{ marginBottom: spacing.md }}>
                  Room types and rent
                </Txt>
                {hostel.roomTypes.map((rt) => (
                  <Card key={rt.id} style={{ marginBottom: spacing.md }}>
                    <View style={sharedStyles.rowBetween}>
                      <View style={{ flex: 1 }}>
                        <Txt variant="body" weight="700">
                          {rt.name}
                        </Txt>
                        <View style={[sharedStyles.row, { marginTop: spacing.xs, gap: spacing.xs, flexWrap: 'wrap' }]}>
                          {rt.availableBeds !== null && rt.availableBeds !== undefined ? (
                            <Badge
                              label={rt.availableBeds > 0 ? `${rt.availableBeds} beds free` : 'Full'}
                              tone={rt.availableBeds > 0 ? 'success' : 'danger'}
                            />
                          ) : null}
                          <Badge label={genderLabel(rt.gender)} tone="neutral" />
                        </View>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Txt variant="body" weight="700" color={colors.primary}>
                          {formatRupees(rt.monthlyRent)}
                        </Txt>
                        <Txt variant="caption" color={colors.textMuted}>
                          per month
                        </Txt>
                      </View>
                    </View>

                    {rt.shortStayDailyRent || rt.dayStayDailyRent ? (
                      <>
                        <Divider style={{ marginVertical: spacing.md }} />
                        {rt.shortStayDailyRent ? (
                          <DetailRow label="Short stay" value={`${formatRupees(rt.shortStayDailyRent)} / day`} />
                        ) : null}
                        {rt.dayStayDailyRent ? (
                          <DetailRow label="Day stay" value={`${formatRupees(rt.dayStayDailyRent)} / day`} />
                        ) : null}
                      </>
                    ) : null}

                    {rt.foodCharges && rt.foodCharges > 0 ? (
                      <DetailRow label="Food" value={`${formatRupees(rt.foodCharges)} / month`} />
                    ) : null}
                  </Card>
                ))}
              </>
            ) : null}

            {tab === 'location' ? (
              <>
                <Txt variant="subtitle" weight="700" style={{ marginBottom: spacing.sm }}>
                  Where it is
                </Txt>
                <Card>
                  <DetailRow label="Address" value={`${hostel.addressLine}, ${hostel.area}`} />
                  <DetailRow label="City" value={`${hostel.city}${hostel.pincode ? ` — ${hostel.pincode}` : ''}`} />
                  {hostel.college ? (
                    <DetailRow label="Nearest campus" value={hostel.college.name} />
                  ) : null}
                  <DetailRow
                    label="Coordinates"
                    value={`${hostel.latitude.toFixed(4)}, ${hostel.longitude.toFixed(4)}`}
                  />
                  {hostel.contactPhone ? (
                    <DetailRow label="Front desk" value={`+91 ${hostel.contactPhone}`} />
                  ) : null}
                </Card>

                <Card style={{ marginTop: spacing.lg, alignItems: 'center', paddingVertical: spacing.xxl }}>
                  <Txt variant="body" color={colors.textMuted} style={{ textAlign: 'center' }}>
                    📍
                  </Txt>
                  <Txt variant="body" weight="600" style={{ marginTop: spacing.sm, textAlign: 'center' }}>
                    {hostel.area}, {hostel.city}
                  </Txt>
                  <Txt variant="caption" color={colors.textMuted} style={{ marginTop: spacing.xs, textAlign: 'center' }}>
                    A map view will be added once Google Maps billing is configured. Distance and travel time from your college are already shown on search results.
                  </Txt>
                </Card>
              </>
            ) : null}

            {tab === 'book' ? (
              <>
                {totalFreeBeds === 0 && hostel.roomTypes.some((rt) => rt.totalBeds !== null) ? (
                  <Card style={{ marginBottom: spacing.md, backgroundColor: colors.dangerFaint, borderColor: colors.danger }}>
                    <Txt variant="body" weight="700" color={colors.danger}>
                      No beds available right now
                    </Txt>
                    <Txt variant="caption" color={colors.danger} style={{ marginTop: spacing.xs }}>
                      This hostel is full. Check back later or try a nearby property.
                    </Txt>
                  </Card>
                ) : null}
                <BookingPanel hostel={data} />
              </>
            ) : null}
          </View>
        </View>
      </ScrollView>

      {/* Sticky CTA */}
      {tab !== 'book' ? (
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: colors.surface,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            padding: spacing.lg,
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.lg,
          }}
        >
          <View style={{ flex: 1 }}>
            <Txt variant="caption" color={colors.textMuted}>
              From
            </Txt>
            <Txt variant="subtitle" weight="700" color={colors.primary}>
              {formatRupees(cheapest?.monthlyRent ?? null)}
              <Txt variant="caption" color={colors.textMuted}>
                {' '}
                /month
              </Txt>
            </Txt>
          </View>
          <View
            style={{
              backgroundColor: colors.primary,
              borderRadius: radius.md,
              paddingHorizontal: spacing.xl,
              paddingVertical: 14,
            }}
          >
            <Txt
              weight="700"
              color={colors.textInverse}
              onPress={() => setTab('book')}
              accessibilityRole="button"
              accessibilityLabel="Book now"
            >
              Book now
            </Txt>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={[sharedStyles.rowBetween, { marginBottom: spacing.sm }]}>
      <Txt variant="body" color={colors.textMuted}>
        {label}
      </Txt>
      <Txt variant="body" weight="600" style={{ flex: 1, textAlign: 'right', marginLeft: spacing.md }}>
        {value}
      </Txt>
    </View>
  );
}