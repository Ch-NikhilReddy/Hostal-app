import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { ReactNode } from 'react';
import { colors, radius, spacing, fontSize, statusStyle, AMENITY_LABELS, GENDER_LABELS, SHARING_LABELS } from '@/theme/tokens';

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

type TextProps = {
  children: ReactNode;
  variant?: 'display' | 'title' | 'subtitle' | 'body' | 'label' | 'caption';
  color?: string;
  weight?: '400' | '500' | '600' | '700';
  style?: object;
  numberOfLines?: number;
  /** Plain fontSize in px. Escapes the variant scale for one-off sizing. */
  fontSize?: number;
  onPress?: () => void;
  accessibilityRole?: 'text' | 'button' | 'link' | 'header';
  accessibilityLabel?: string;
};

export function Txt({
  children,
  variant = 'body',
  color = colors.text,
  weight = '400',
  style,
  numberOfLines,
  fontSize: fontSizeOverride,
  onPress,
  accessibilityRole,
  accessibilityLabel,
}: TextProps) {
  const scale: Record<string, number> = {
    display: fontSize.xxxl,
    title: fontSize.xl,
    subtitle: fontSize.lg,
    body: fontSize.md,
    label: fontSize.sm,
    caption: fontSize.xs,
  };
  const resolved = fontSizeOverride ?? scale[variant] ?? fontSize.md;

  return (
    <Text
      numberOfLines={numberOfLines}
      onPress={onPress}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      style={[
        {
          fontSize: resolved,
          color,
          fontWeight: weight,
          // Android defaults to a slightly taller line box than iOS; normalising
          // here keeps vertical rhythm identical on both.
          lineHeight: resolved * 1.4,
        },
        { ...style },
      ]}
    >
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  testID?: string;
  /** Margin and flex pass through untouched, so callers can lay buttons out inline. */
  style?: object;
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled,
  loading,
  fullWidth,
  testID,
  style,
}: ButtonProps) {
  const isDisabled = disabled || loading;

  const variants: Record<string, { bg: string; fg: string; border?: string }> = {
    primary: { bg: colors.primary, fg: colors.textInverse },
    secondary: { bg: colors.primaryFaint, fg: colors.primaryDark },
    outline: { bg: 'transparent', fg: colors.primary, border: colors.primary },
    danger: { bg: colors.danger, fg: colors.textInverse },
    ghost: { bg: 'transparent', fg: colors.textMuted },
  };
  const v = variants[variant] ?? variants.primary!;
  const heights = { sm: 36, md: 46, lg: 54 };

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(isDisabled), busy: Boolean(loading) }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        {
          height: heights[size],
          paddingHorizontal: spacing.lg,
          borderRadius: radius.md,
          backgroundColor: v.bg,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
          borderWidth: v.border ? 1 : 0,
          borderColor: v.border,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
        },
        // Spread last so a caller's margin or flex wins over the defaults above.
        { ...style },
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={v.fg} />
      ) : (
        <Text style={{ color: v.fg, fontWeight: '600', fontSize: size === 'sm' ? fontSize.sm : fontSize.md }}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

type InputProps = {
  label?: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'phone-pad' | 'decimal-pad';
  secureTextEntry?: boolean;
  maxLength?: number;
  error?: string | null;
  hint?: string;
  autoFocus?: boolean;
  testID?: string;
  multiline?: boolean;
};

export function Input({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = 'default',
  secureTextEntry,
  maxLength,
  error,
  hint,
  autoFocus,
  testID,
  multiline,
}: InputProps) {
  return (
    <View style={{ marginBottom: spacing.lg }}>
      {label ? (
        <Txt variant="label" weight="600" color={colors.textMuted} style={{ marginBottom: spacing.xs }}>
          {label}
        </Txt>
      ) : null}
      <TextInputCompat
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        maxLength={maxLength}
        autoFocus={autoFocus}
        testID={testID}
        multiline={multiline}
        hasError={Boolean(error)}
      />
      {error ? (
        <Txt variant="caption" color={colors.danger} style={{ marginTop: spacing.xs }}>
          {error}
        </Txt>
      ) : hint ? (
        <Txt variant="caption" color={colors.textFaint} style={{ marginTop: spacing.xs }}>
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

function TextInputCompat(props: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'phone-pad' | 'decimal-pad';
  secureTextEntry?: boolean;
  maxLength?: number;
  autoFocus?: boolean;
  testID?: string;
  multiline?: boolean;
  hasError?: boolean;
}) {
  return (
    <TextInput
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColor={colors.textFaint}
      keyboardType={props.keyboardType}
      secureTextEntry={props.secureTextEntry}
      maxLength={props.maxLength}
      autoFocus={props.autoFocus}
      testID={props.testID}
      multiline={props.multiline}
      accessibilityLabel={props.placeholder}
      style={{
        height: props.multiline ? 100 : 48,
        borderWidth: 1,
        borderColor: props.hasError ? colors.danger : colors.border,
        borderRadius: radius.md,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        fontSize: fontSize.md,
        color: colors.text,
        backgroundColor: colors.surface,
        textAlignVertical: props.multiline ? 'top' : 'center',
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Card, Badge, Divider
// ---------------------------------------------------------------------------

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  return (
    <View
      style={[
        {
          backgroundColor: colors.surface,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: colors.border,
          padding: spacing.lg,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand' }) {
  const tones: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: '#F1F5F9', fg: colors.textMuted },
    success: { bg: colors.successFaint, fg: colors.success },
    warning: { bg: colors.warningFaint, fg: colors.warning },
    danger: { bg: colors.dangerFaint, fg: colors.danger },
    info: { bg: colors.infoFaint, fg: colors.info },
    brand: { bg: colors.primaryFaint, fg: colors.primaryDark },
  };
  const t = tones[tone] ?? tones.neutral!;
  return (
    <View style={{ backgroundColor: t.bg, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 4 }}>
      <Text style={{ color: t.fg, fontSize: fontSize.xs, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

/** Booking status chip. Colours come from the shared status map. */
export function StatusBadge({ status }: { status: string }) {
  const s = statusStyle[status] ?? { label: status, color: colors.textMuted, background: '#F1F5F9' };
  return (
    <View style={{ backgroundColor: s.background, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 5 }}>
      <Text style={{ color: s.color, fontSize: fontSize.xs, fontWeight: '700' }}>{s.label}</Text>
    </View>
  );
}

export function Divider({ style }: { style?: object }) {
  return <View style={[{ height: 1, backgroundColor: colors.border }, style]} />;
}

// ---------------------------------------------------------------------------
// Chips (filter selection)
// ---------------------------------------------------------------------------

export function Chip({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={({ pressed }) => ({
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: radius.pill,
        backgroundColor: selected ? colors.primary : colors.surface,
        borderWidth: 1,
        borderColor: selected ? colors.primary : colors.border,
        opacity: pressed ? 0.8 : 1,
        marginRight: spacing.sm,
      })}
    >
      <Text
        style={{
          color: selected ? colors.textInverse : colors.textMuted,
          fontSize: fontSize.sm,
          fontWeight: selected ? '600' : '400',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ChipRow({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm }}
    >
      {children}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl }}>
      <ActivityIndicator size="large" color={colors.primary} />
      <Txt variant="body" color={colors.textMuted} style={{ marginTop: spacing.lg }}>
        {label}
      </Txt>
    </View>
  );
}

export function EmptyState({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return (
    <View style={{ alignItems: 'center', padding: spacing.xxl }}>
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: colors.primaryFaint,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: spacing.lg,
        }}
      >
        <Text style={{ fontSize: 30 }}>🏠</Text>
      </View>
      <Txt variant="subtitle" weight="700" style={{ textAlign: 'center' }}>
        {title}
      </Txt>
      <Txt variant="body" color={colors.textMuted} style={{ textAlign: 'center', marginTop: spacing.sm }}>
        {message}
      </Txt>
      {action ? <View style={{ marginTop: spacing.lg }}>{action}</View> : null}
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={{ alignItems: 'center', padding: spacing.xxl }}>
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: colors.dangerFaint,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: spacing.lg,
        }}
      >
        <Text style={{ fontSize: 30 }}>⚠️</Text>
      </View>
      <Txt variant="subtitle" weight="700" style={{ textAlign: 'center' }}>
        Something went wrong
      </Txt>
      <Txt variant="body" color={colors.textMuted} style={{ textAlign: 'center', marginTop: spacing.sm }}>
        {message}
      </Txt>
      {onRetry ? <Button label="Try again" onPress={onRetry} variant="outline" style={{ marginTop: spacing.lg }} /> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Amenity and label helpers
// ---------------------------------------------------------------------------

export function amenityLabel(key: string): string {
  return AMENITY_LABELS[key] ?? key.replace(/_/g, ' ');
}

export function sharingLabel(key: string): string {
  return SHARING_LABELS[key] ?? key;
}

export function genderLabel(key: string): string {
  return GENDER_LABELS[key] ?? key;
}

/** Horizontal amenity list. Capped so a card never grows unbounded. */
export function AmenityStrip({ amenities, max = 5 }: { amenities: string[]; max?: number }) {
  const shown = amenities.slice(0, max);
  const extra = amenities.length - shown.length;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
      {shown.map((a) => (
        <Badge key={a} label={amenityLabel(a)} tone="neutral" />
      ))}
      {extra > 0 ? <Badge label={`+${extra} more`} tone="neutral" /> : null}
    </View>
  );
}

/** Placeholder used when a listing has no photos, so the grid stays even. */
export function PhotoPlaceholder({ height = 160 }: { height?: number }) {
  return (
    <View
      style={{
        height,
        backgroundColor: colors.primaryFaint,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: 36 }}>🏠</Text>
      <Txt variant="caption" color={colors.primaryDark} style={{ marginTop: spacing.xs }}>
        No photos yet
      </Txt>
    </View>
  );
}

export function HostelPhoto({ uri, height = 160, width }: { uri?: string; height?: number; width?: number | string }) {
  if (!uri) return <PhotoPlaceholder height={height} />;
  return (
    <Image
      source={{ uri }}
      style={{ height, width: (width as number) ?? '100%', backgroundColor: colors.border }}
      resizeMode="cover"
      accessible
      accessibilityIgnoresInvertColors
    />
  );
}

export const sharedStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  section: { paddingHorizontal: spacing.lg, marginTop: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stack: { flexDirection: 'column' },
  flex1: { flex: 1 },
});