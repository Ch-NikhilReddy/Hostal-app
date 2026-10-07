import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, ScrollView, Pressable, RefreshControl, FlatList } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  getHostel,
  listColleges,
  searchHostels,
  type SearchParams,
} from '@/api/endpoints';
import type { College, HostelSearchResult } from '@/api/types';
import { HostelCard, HostelCarousel } from '@/components/hostel-card';
import {
  Badge,
  Button,
  Chip,
  ChipRow,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Txt,
  sharedStyles,
} from '@/components/ui';
import { colors, spacing, radius, fontSize } from '@/theme/tokens';

type SortKey = NonNullable<SearchParams['sort']>;

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'distance', label: 'Nearest' },
  { key: 'price_asc', label: 'Cheapest' },
  { key: 'price_desc', label: 'Costliest' },
  { key: 'rating', label: 'Top rated' },
];

export default function ExploreScreen() {
  const router = useRouter();

  const [colleges, setColleges] = useState<College[]>([]);
  const [college, setCollege] = useState<College | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('distance');
  const [gender, setGender] = useState<string | undefined>(undefined);
  const [maxRent, setMaxRent] = useState<string>('');
  const [foodIncluded, setFoodIncluded] = useState(false);

  const [featured, setFeatured] = useState<HostelSearchResult[]>([]);
  const [results, setResults] = useState<HostelSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [origin, setOrigin] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const hasFilters = Boolean(gender || maxRent || foodIncluded || sort !== 'distance');

  useEffect(() => {
    void listColleges()
      .then((res) => {
        setColleges(res.colleges);
        // Default to Osmania University: the largest student catchment in the city
        // and the most common entry point, so a fresh install shows results
        // immediately instead of an empty screen.
        const ou = res.colleges.find((c) => c.slug === 'osmania-university');
        if (ou) setCollege(ou);
      })
      .catch(() => undefined);
  }, []);

  const searchParams = useMemo<SearchParams>(
    () => ({
      collegeId: college?.id,
      radiusKm: 10,
      ...(query.trim() ? { search: query.trim() } : {}),
      ...(gender ? { gender } : {}),
      ...(foodIncluded ? { foodIncluded: true } : {}),
      ...(maxRent && Number(maxRent) > 0 ? { maxRent: Number(maxRent) } : {}),
      sort,
      pageSize: 30,
    }),
    [college, query, gender, foodIncluded, maxRent, sort],
  );

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (mode === 'refresh') setRefreshing(true);
      setError(null);

      try {
        const res = await searchHostels(searchParams);
        setResults(res.results);
        setTotal(res.total);
        setOrigin(res.origin?.name ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load hostels.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [searchParams],
  );

  // Featured strip: newest listings near the chosen campus, loaded once per campus
  // rather than on every filter change, so it does not flicker while filtering.
  useEffect(() => {
    if (!college) return;
    let cancelled = false;

    void searchHostels({ collegeId: college.id, radiusKm: 10, sort: 'newest', pageSize: 8 })
      .then((res) => {
        if (!cancelled) setFeatured(res.results);
      })
      .catch(() => {
        if (!cancelled) setFeatured([]);
      });

    return () => {
      cancelled = true;
    };
  }, [college]);

  useEffect(() => {
    void load('initial');
  }, [load]);

  // Re-run when the tab regains focus, so a listing booked elsewhere in the app is
  // reflected without a manual pull-to-refresh.
  useFocusEffect(
    useCallback(() => {
      void load('refresh');
    }, [load]),
  );

  function openHostel(hostel: HostelSearchResult) {
    router.push({
      pathname: '/hostel/[slug]',
      params: { slug: hostel.slug },
    });
  }

  async function previewHostel() {
    // Preview the first result, so tapping a campus chip on the home screen does
    // something useful without needing an extra screen.
    const first = results[0] ?? featured[0];
    if (first) openHostel(first);
  }

  if (loading && results.length === 0) {
    return <LoadingState label="Finding hostels near you…" />;
  }

  if (error && results.length === 0) {
    return <ErrorState message={error} onRetry={() => void load('initial')} />;
  }

  return (
    <FlatList
      data={results}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <HostelCard hostel={item} onPress={() => openHostel(item)} />}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh')} tintColor={colors.primary} />
      }
      ListHeaderComponent={
        <View>
          {/* Search */}
          <View style={{ marginBottom: spacing.lg }}>
            <Input
              value={query}
              onChangeText={setQuery}
              placeholder="Search area, hostel or landmark"
              testID="search-input"
            />
          </View>

          {/* Campus selector — the primary axis for a student */}
          <Txt variant="label" weight="600" color={colors.textMuted} style={{ marginBottom: spacing.sm }}>
            NEAR YOUR COLLEGE
          </Txt>
          <View style={{ marginHorizontal: -spacing.lg, marginBottom: spacing.md }}>
            <ChipRow>
              {colleges.map((c) => (
                <Chip
                  key={c.id}
                  label={shortCollegeName(c.name)}
                  selected={college?.id === c.id}
                  onPress={() => setCollege(c)}
                  testID={`college-${c.slug}`}
                />
              ))}
            </ChipRow>
          </View>

          {/* Sort */}
          <View style={{ marginHorizontal: -spacing.lg, marginBottom: spacing.sm }}>
            <ChipRow>
              {SORTS.map((s) => (
                <Chip key={s.key} label={s.label} selected={sort === s.key} onPress={() => setSort(s.key)} />
              ))}
            </ChipRow>
          </View>

          {/* Filters */}
          <View style={[sharedStyles.rowBetween, { marginBottom: spacing.md }]}>
            <Pressable
              onPress={() => setFiltersOpen((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ expanded: filtersOpen }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.sm,
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: hasFilters ? colors.primary : colors.border,
                backgroundColor: hasFilters ? colors.primaryFaint : colors.surface,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <Txt
                variant="body"
                weight="600"
                fontSize={fontSize.sm}
                color={hasFilters ? colors.primaryDark : colors.textMuted}
              >
                ⚙ Filters{hasFilters ? ' •' : ''}
              </Txt>
            </Pressable>

            <Txt variant="caption" color={colors.textMuted}>
              {total} {total === 1 ? 'stay' : 'stays'}
              {origin ? ` near ${origin}` : ''}
            </Txt>
          </View>

          {filtersOpen ? (
            <View style={{ marginBottom: spacing.lg, padding: spacing.lg, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border }}>
              <Txt variant="label" weight="600" color={colors.textMuted} style={{ marginBottom: spacing.sm }}>
                WHO IS IT FOR?
              </Txt>
              <View style={[sharedStyles.row, { gap: spacing.sm, flexWrap: 'wrap', marginBottom: spacing.lg }]}>
                {[
                  { key: undefined, label: 'Anyone' },
                  { key: 'MALE', label: 'Boys' },
                  { key: 'FEMALE', label: 'Girls' },
                ].map((opt) => (
                  <Chip
                    key={opt.key ?? 'any'}
                    label={opt.label}
                    selected={gender === opt.key}
                    onPress={() => setGender(opt.key)}
                  />
                ))}
              </View>

              <Txt variant="label" weight="600" color={colors.textMuted} style={{ marginBottom: spacing.sm }}>
                MAXIMUM MONTHLY RENT
              </Txt>
              <View style={[sharedStyles.row, { gap: spacing.sm, flexWrap: 'wrap' }]}>
                {[6000, 8000, 10000, 15000].map((amount) => (
                  <Chip
                    key={amount}
                    label={`Under ₹${(amount / 1000).toFixed(0)}k`}
                    selected={maxRent === String(amount)}
                    onPress={() => setMaxRent(maxRent === String(amount) ? '' : String(amount))}
                  />
                ))}
              </View>

              <View style={[sharedStyles.rowBetween, { marginTop: spacing.lg }]}>
                <Chip
                  label={foodIncluded ? '✓ Meals included' : 'Meals included only'}
                  selected={foodIncluded}
                  onPress={() => setFoodIncluded((v) => !v)}
                />
                {hasFilters ? (
                  <Pressable onPress={() => { setGender(undefined); setMaxRent(''); setFoodIncluded(false); setSort('distance'); }} accessibilityRole="button">
                    <Txt variant="body" color={colors.primary} weight="600">
                      Clear all
                    </Txt>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : null}

          {/* Featured, only when no explicit search is running */}
          {!query && !hasFilters && featured.length > 0 ? (
            <HostelCarousel
              hostels={featured}
              onSelect={openHostel}
              title="Newly listed near you"
            />
          ) : null}
        </View>
      }
      ListEmptyComponent={
        <EmptyState
          title="No hostels match"
          message={
            query
              ? `Nothing found for "${query}". Try a nearby area, or clear your filters.`
              : 'No hostels have been listed near this college yet. Try a wider radius or another campus.'
          }
          action={
            hasFilters ? (
              <Button
                label="Clear filters"
                variant="outline"
                onPress={() => {
                  setGender(undefined);
                  setMaxRent('');
                  setFoodIncluded(false);
                  setSort('distance');
                }}
              />
            ) : (
              <Button label="Browse other colleges" variant="outline" onPress={() => void previewHostel()} />
            )
          }
        />
      }
    />
  );
}

/**
 * Colleges have long formal names ("Chaitanya Bharathi Institute of Technology").
 * Chips have limited width, so the recognizable short form is what a student
 * actually searches by.
 */
function shortCollegeName(name: string): string {
  const known: Record<string, string> = {
    'osmania-university': 'OU',
    'jntuh-kukatpally': 'JNTUH',
    'cbit-gachibowli': 'CBIT',
    'vit-hyderabad': 'VIT',
    'woxsen-university': 'Woxsen',
    'mgu-nalgonda': 'MGU',
    'mahindra-university': 'Mahindra',
    'manu-hyderabad': 'MANU',
    'angrau-hyderabad': 'ANGRAU',
    'anurag-university': 'Anurag',
    'iit-hyderabad': 'IIT-H',
    'university-of-hyderabad': 'UH',
    'malla-reddy-university': 'MRU',
    'telangana-university': 'TU',
    'st-josephs-hyderabad': 'St Josephs',
  };

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (known[slug]) return known[slug];

  // Fall back to the first two words, which is usually enough to disambiguate.
  return name.split(' ').slice(0, 2).join(' ');
}