import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  getAvailability,
  listColleges,
  quoteStay,
  type StayInput,
} from '@/api/endpoints';
import { formatRupees } from '@/api/client';
import type { College, HostelDetail, QuoteResponse, StayType } from '@/api/types';
import {
  Badge,
  Button,
  Card,
  Chip,
  ChipRow,
  Divider,
  ErrorState,
  HostelPhoto,
  LoadingState,
  Txt,
  amenityLabel,
  genderLabel,
  sharedStyles,
  sharingLabel,
} from '@/components/ui';
import { colors, radius, spacing } from '@/theme/tokens';
import { ScrollView, View, Pressable } from 'react-native';

type Props = {
  hostel: HostelDetail;
  /** Passed through from search so the availability counts already fetched are reused. */
  initialCheckIn?: string;
  initialCheckOut?: string;
};

const STAY_OPTIONS: { key: StayType; label: string; hint: string }[] = [
  { key: 'MONTHLY', label: 'Monthly', hint: 'Best value' },
  { key: 'SHORT_STAY', label: 'Short stay', hint: '1–29 days' },
  { key: 'DAY_STAY', label: 'Day stay', hint: 'Just today' },
];

function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** Tonight: a day stay is almost always wanted for today. */
function today(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function BookingPanel({ hostel, initialCheckIn, initialCheckOut }: Props) {
  const router = useRouter();

  const [stayType, setStayType] = useState<StayType>('MONTHLY');
  const [months, setMonths] = useState(3);
  const [days, setDays] = useState(7);
  const [checkIn, setCheckIn] = useState(initialCheckIn ?? isoDate(14));
  const [college, setCollege] = useState<College | null>(null);
  const [colleges, setColleges] = useState<College[]>([]);
  const [rooms, setRooms] = useState(hostel.hostel.roomTypes);
  const [roomTypeId, setRoomTypeId] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [bedId, setBedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which room types even offer the selected stay type. Offering a day stay the
  // hostel does not sell would produce a confusing error at quote time instead of
  // an honest filter here.
  const availableRooms = useMemo(
    () =>
      rooms.filter((rt) => {
        if (stayType === 'MONTHLY') return true;
        if (stayType === 'SHORT_STAY') return rt.shortStayDailyRent !== null;
        return rt.dayStayDailyRent !== null;
      }),
    [rooms, stayType],
  );

  useEffect(() => {
    void listColleges()
      .then((res) => {
        setColleges(res.colleges);
        // Default the campus to this hostel's own college when it has one: that is
        // what nearly every student is searching from.
        const own = hostel.hostel.college;
        if (own) {
          const match = res.colleges.find((c) => c.id === own.id || c.slug === own.slug);
          setCollege(match ?? null);
        }
      })
      .catch(() => undefined);
  }, [hostel.hostel.college]);

  useEffect(() => {
    if (stayType === 'DAY_STAY') setCheckIn(today());
  }, [stayType]);

  // Keep a valid selection whenever the filtered list changes, otherwise the
  // quote request can fire with a roomTypeId that no longer exists.
  useEffect(() => {
    if (availableRooms.length === 0) {
      setRoomTypeId(null);
      setQuote(null);
      return;
    }
    if (!roomTypeId || !availableRooms.some((rt) => rt.id === roomTypeId)) {
      setRoomTypeId(availableRooms[0]?.id ?? null);
    }
  }, [availableRooms, roomTypeId]);

  const selectedRoom = availableRooms.find((rt) => rt.id === roomTypeId);

  async function runQuote() {
    if (!roomTypeId) return;

    setLoading(true);
    setError(null);
    setBedId(null);

    try {
      const input: StayInput =
        stayType === 'MONTHLY'
          ? { roomTypeId, stayType, checkIn, months }
          : stayType === 'DAY_STAY'
            ? { roomTypeId, stayType, checkIn, days: 1 }
            : { roomTypeId, stayType, checkIn, days };

      const res = await quoteStay(input);
      setQuote(res);
      setBedId(res.availableBeds[0]?.id ?? null);

      // Refresh which beds are free for exactly this window.
      if (res.availableBeds.length > 0) {
        const avail = await getAvailability(hostel.hostel.slug, {
          roomTypeId,
          checkIn: res.quote.checkIn,
          checkOut: res.quote.checkOut,
        });
        setBedId(avail.beds[0]?.id ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load prices.');
      setQuote(null);
    } finally {
      setLoading(false);
    }
  }

  // Re-quote whenever anything that affects the price changes.
  useEffect(() => {
    if (!roomTypeId) return;
    void runQuote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomTypeId, stayType, checkIn, months, days]);

  function proceed() {
    if (!roomTypeId || !bedId || !quote) return;

    router.push({
      pathname: '/booking/payment',
      params: {
        hostelSlug: hostel.hostel.slug,
        hostelName: hostel.hostel.name,
        roomTypeId,
        roomTypeName: selectedRoom?.name ?? '',
        bedId,
        stayType,
        checkIn: quote.quote.checkIn,
        checkOut: quote.quote.checkOut,
        ...(stayType === 'MONTHLY' ? { months: String(months) } : { days: String(stayType === 'DAY_STAY' ? 1 : days) }),
        totalAmount: String(quote.quote.amounts.totalAmount),
        rentSubtotal: String(quote.quote.amounts.rentSubtotal),
        depositAmount: String(quote.quote.amounts.depositAmount),
      },
    });
  }

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
      {/* Stay type */}
      <Txt variant="label" weight="600" color={colors.textMuted}>
        HOW LONG DO YOU NEED?
      </Txt>
      <View style={{ marginTop: spacing.sm, marginHorizontal: -spacing.lg }}>
        <ChipRow>
          {STAY_OPTIONS.map((opt) => (
            <Chip
              key={opt.key}
              label={`${opt.label} · ${opt.hint}`}
              selected={stayType === opt.key}
              onPress={() => setStayType(opt.key)}
              testID={`stay-${opt.key}`}
            />
          ))}
        </ChipRow>
      </View>

      {/* Dates */}
      <Card style={{ marginTop: spacing.md }}>
        <Txt variant="label" weight="600" color={colors.textMuted}>
          {stayType === 'DAY_STAY' ? 'DATE' : 'CHECK-IN'}
        </Txt>
        <Txt variant="subtitle" weight="700" style={{ marginTop: spacing.xs }}>
          {new Date(`${checkIn}T00:00:00Z`).toLocaleDateString('en-IN', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC',
          })}
        </Txt>
        {quote ? (
          <Txt variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
            {stayType === 'MONTHLY'
              ? `${quote.quote.months} month${quote.quote.months === 1 ? '' : 's'} · until ${new Date(`${quote.quote.checkOut}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`
              : `until ${new Date(`${quote.quote.checkOut}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`}
          </Txt>
        ) : null}

        {/* Quick date jumps: a student booking a monthly stay is usually choosing
            from a handful of realistic start dates, not entering one. */}
        {stayType !== 'DAY_STAY' ? (
          <View style={[sharedStyles.row, { marginTop: spacing.md, flexWrap: 'wrap', gap: spacing.sm }]}>
            {[
              { label: 'Tomorrow', offset: 1 },
              { label: 'In a week', offset: 7 },
              { label: 'In 2 weeks', offset: 14 },
              { label: 'In a month', offset: 30 },
            ].map((opt) => (
              <Chip
                key={opt.offset}
                label={opt.label}
                selected={checkIn === isoDate(opt.offset)}
                onPress={() => setCheckIn(isoDate(opt.offset))}
              />
            ))}
          </View>
        ) : null}
      </Card>

      {/* Duration */}
      {stayType === 'MONTHLY' ? (
        <Card style={{ marginTop: spacing.md }}>
          <Txt variant="label" weight="600" color={colors.textMuted}>
            DURATION
          </Txt>
          <View style={[sharedStyles.row, { marginTop: spacing.md, flexWrap: 'wrap', gap: spacing.sm }]}>
            {[1, 2, 3, 6, 12].map((m) => (
              <Chip
                key={m}
                label={m === 12 ? '1 year' : `${m} month${m === 1 ? '' : 's'}`}
                selected={months === m}
                onPress={() => setMonths(m)}
                testID={`months-${m}`}
              />
            ))}
          </View>
        </Card>
      ) : stayType === 'SHORT_STAY' ? (
        <Card style={{ marginTop: spacing.md }}>
          <Txt variant="label" weight="600" color={colors.textMuted}>
            HOW MANY DAYS?
          </Txt>
          <View style={[sharedStyles.row, { marginTop: spacing.md, flexWrap: 'wrap', gap: spacing.sm }]}>
            {[1, 3, 7, 15, 29].map((dcount) => (
              <Chip
                key={dcount}
                label={dcount === 1 ? '1 day' : `${dcount} days`}
                selected={days === dcount}
                onPress={() => setDays(dcount)}
              />
            ))}
          </View>
          <Txt variant="caption" color={colors.textFaint} style={{ marginTop: spacing.md }}>
            For 30 days or longer, choose Monthly — it works out cheaper for both you and the hostel.
          </Txt>
        </Card>
      ) : null}

      {/* Room type */}
      <Txt variant="label" weight="600" color={colors.textMuted} style={{ marginTop: spacing.xl }}>
        ROOM TYPE
      </Txt>
      {availableRooms.length === 0 ? (
        <Card style={{ marginTop: spacing.sm }}>
          <Txt variant="body" color={colors.textMuted}>
            This hostel does not offer {stayType === 'DAY_STAY' ? 'day stays' : 'short stays'}. Try a monthly booking.
          </Txt>
        </Card>
      ) : (
        <View style={{ marginTop: spacing.sm, gap: spacing.sm }}>
          {availableRooms.map((rt) => {
            const selected = rt.id === roomTypeId;
            const price =
              stayType === 'MONTHLY'
                ? `${formatRupees(rt.monthlyRent)}/mo`
                : stayType === 'SHORT_STAY'
                  ? `${formatRupees(rt.shortStayDailyRent)}/day`
                  : `${formatRupees(rt.dayStayDailyRent)}/day`;

            return (
              <Pressable
                key={rt.id}
                onPress={() => setRoomTypeId(rt.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                testID={`room-${rt.id}`}
                style={{
                  borderRadius: radius.md,
                  borderWidth: 2,
                  borderColor: selected ? colors.primary : colors.border,
                  backgroundColor: selected ? colors.primaryFaint : colors.surface,
                  padding: spacing.md,
                }}
              >
                <View style={sharedStyles.rowBetween}>
                  <View style={{ flex: 1 }}>
                    <Txt variant="body" weight="700">
                      {rt.name}
                    </Txt>
                    <View style={[sharedStyles.row, { marginTop: 4, gap: spacing.xs, flexWrap: 'wrap' }]}>
                      <Badge label={sharingLabel(rt.sharingType)} tone="neutral" />
                      {rt.availableBeds !== null && rt.availableBeds !== undefined ? (
                        <Badge
                          label={`${rt.availableBeds} free`}
                          tone={rt.availableBeds > 0 ? 'success' : 'danger'}
                        />
                      ) : null}
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Txt variant="body" weight="700" color={colors.primary}>
                      {price}
                    </Txt>
                    {rt.depositAmount ? (
                      <Txt variant="caption" color={colors.textMuted}>
                        +{formatRupees(rt.depositAmount)} deposit
                      </Txt>
                    ) : null}
                  </View>
                </View>
              </Pressable>
            );
          })}
        </View>
      )}

      {/* Price breakdown */}
      {loading && !quote ? (
        <LoadingState label="Working out the price…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void runQuote()} />
      ) : quote ? (
        <Card style={{ marginTop: spacing.xl }}>
          <Txt variant="subtitle" weight="700" style={{ marginBottom: spacing.md }}>
            Price breakdown
          </Txt>

          <PriceRow
            label={
              stayType === 'MONTHLY'
                ? `Rent · ${quote.quote.months} month${quote.quote.months === 1 ? '' : 's'}`
                : stayType === 'DAY_STAY'
                  ? 'Day stay'
                  : `Rent · ${quote.quote.days} day${quote.quote.days === 1 ? '' : 's'}`
            }
            value={quote.quote.amounts.baseRent}
          />
          {quote.quote.amounts.foodCharges > 0 ? (
            <PriceRow label="Food" value={quote.quote.amounts.foodCharges} />
          ) : null}
          {quote.quote.amounts.depositAmount > 0 ? (
            <PriceRow
              label="Security deposit"
              value={quote.quote.amounts.depositAmount}
              hint="Refundable on checkout"
            />
          ) : null}

          <Divider style={{ marginVertical: spacing.md }} />

          <View style={sharedStyles.rowBetween}>
            <Txt variant="subtitle" weight="700">
              Total payable
            </Txt>
            <Txt variant="title" weight="700" color={colors.primary}>
              {formatRupees(quote.quote.amounts.totalAmount)}
            </Txt>
          </View>

          <Txt variant="caption" color={colors.textMuted} style={{ marginTop: spacing.xs }}>
            {formatRupees(quote.quote.amounts.rentSubtotal)} for your stay
            {quote.quote.amounts.depositAmount > 0
              ? ` + ${formatRupees(quote.quote.amounts.depositAmount)} refundable deposit`
              : ''}
          </Txt>

          <View style={[sharedStyles.row, { marginTop: spacing.lg, gap: spacing.sm }]}>
            <Txt variant="body" color={quote.availableBedCount > 0 ? colors.success : colors.danger} weight="600">
              {quote.availableBedCount > 0
                ? `${quote.availableBedCount} bed${quote.availableBedCount === 1 ? '' : 's'} available`
                : 'No beds for these dates'}
            </Txt>
          </View>
        </Card>
      ) : null}

      <Button
        label={
          quote && quote.availableBedCount > 0
            ? `Book for ${formatRupees(quote.quote.amounts.totalAmount)}`
            : 'Continue'
        }
        onPress={proceed}
        size="lg"
        fullWidth
        disabled={!quote || quote.availableBedCount === 0 || !bedId}
        loading={loading}
        testID="proceed-to-payment"
        style={{ marginTop: spacing.xl, marginBottom: spacing.xl }}
      />
    </ScrollView>
  );
}

function PriceRow({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <View style={{ marginBottom: spacing.sm }}>
      <View style={sharedStyles.rowBetween}>
        <Txt variant="body" color={colors.textMuted}>
          {label}
        </Txt>
        <Txt variant="body" weight="600">
          {formatRupees(value)}
        </Txt>
      </View>
      {hint ? (
        <Txt variant="caption" color={colors.textFaint}>
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}