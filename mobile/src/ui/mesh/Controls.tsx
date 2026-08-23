import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  type StyleProp,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../ThemeProvider';
import { type Palette, TAP_TARGET } from '../theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

/**
 * The tappable primitives, in one place because they are one concern.
 *
 * Two things arrive from context rather than from the stylesheet: the palette,
 * and the *accent* — the hue the current tab owns. Filling a button with the
 * tab's colour is what makes the five sections read as five places instead of
 * one app with five lists, so the accent is deliberately not baked into the
 * sheet; it is the one colour that has to change without the sheet changing.
 *
 * Feedback is opacity plus a 2% inset, driven by the style callback rather than
 * `Animated`: it is instantaneous and it costs no frames on the phones this has
 * to run on. Android additionally gets its platform ripple.
 */

export type ButtonVariant = 'primary' | 'ghost' | 'danger';

export function Button({
  label,
  icon,
  onPress,
  variant = 'primary',
  busy = false,
  disabled = false,
  compact = false,
  style,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  variant?: ButtonVariant;
  /** Work is in flight. Implies disabled — a second tap cannot help. */
  busy?: boolean;
  disabled?: boolean;
  /** Sits inline inside a row rather than spanning it. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { styles, theme, accent } = useTheme();
  const off = disabled || busy;

  const fill =
    variant === 'primary'
      ? { backgroundColor: accent }
      : { borderColor: variant === 'danger' ? theme.danger : theme.border };
  const inkColour =
    variant === 'primary' ? theme.onAccent : variant === 'danger' ? theme.danger : theme.dim;

  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      accessibilityLabel={label}
      // A compact button is 36pt so it can sit on a row without dominating it;
      // slop takes the actual target back to the platform floor.
      hitSlop={compact ? slopTo(36) : undefined}
      android_ripple={off ? undefined : { color: ripple(variant, theme), borderless: false }}
      style={({ pressed }) => [
        styles.button,
        variant !== 'primary' && styles.buttonGhost,
        fill,
        compact && styles.buttonCompact,
        off && styles.buttonDisabled,
        pressed && !off && PRESSED,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={inkColour} size="small" />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={16} color={inkColour} /> : null}
          <Text style={[styles.buttonText, { color: inkColour }]} numberOfLines={1}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/**
 * A chip is a setting, not a command — it reports which value is current and
 * changes it in one tap. `on` is therefore a state to be read, not a highlight,
 * and it is drawn as a tinted edge in the tab's own hue rather than as a fill:
 * a row of solid accent chips would out-shout the content they configure.
 *
 * It stays visually small because a row of them is a scale the eye reads across,
 * but `hitSlop` takes the real target up to the platform floor so a 36pt chip
 * is still a 44pt tap.
 */
export function Chip({
  label,
  onPress,
  on = false,
  cut = false,
  disabled = false,
  children,
}: {
  label?: string;
  onPress: () => void;
  /** This value is the one in force. */
  on?: boolean;
  /** This link is severed — a destructive state, not a selected one. */
  cut?: boolean;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const { styles, theme, accent } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: on, disabled }}
      accessibilityLabel={label}
      hitSlop={slopTo(36)}
      android_ripple={disabled ? undefined : { color: tint(accent), borderless: false }}
      style={({ pressed }) => [
        styles.chip,
        on && { borderColor: accent, backgroundColor: tint(accent) },
        cut && styles.chipCut,
        disabled && styles.buttonDisabled,
        pressed && !disabled && PRESSED,
      ]}
    >
      {children ?? (
        // The selected label is primary text, NOT the accent — on the light
        // paper an accent label over a tint of that same accent lands at
        // 3.6–4.5:1, because tinting the ground with the ink's own hue is
        // exactly how you destroy contrast. The border and the tint carry the
        // "selected" signal; the label only has to stay readable.
        <Text
          style={[styles.chipText, on && { color: theme.text }, cut && { color: theme.danger }]}
          numberOfLines={1}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * An empty state with something to look at.
 *
 * Every one of these used to be the same centred grey paragraph, which made
 * "nothing has happened yet" and "nothing can happen yet" indistinguishable.
 */
export function Empty({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  const { styles, accent } = useTheme();
  return (
    <View style={styles.emptyWrap}>
      <Ionicons name={icon} size={22} color={accent} />
      <Text style={[styles.empty, { paddingVertical: 0 }]}>{children}</Text>
    </View>
  );
}

const PRESSED = { opacity: 0.7, transform: [{ scale: 0.98 }] } as const;

/** The slop a control of `height` needs to reach the platform's tap floor. */
function slopTo(height: number) {
  const pad = Math.max(0, Math.round((TAP_TARGET - height) / 2));
  return { top: pad, bottom: pad };
}

/**
 * A wash of the accent, for selected chips and ripples.
 *
 * Alpha rather than a second authored colour: the tab hue is not known until
 * runtime, so there is nothing to author against, and 22/255 lands in the same
 * place on both papers.
 */
function tint(accent: string): string {
  return `${accent}22`;
}

/**
 * The Android ripple, derived from whatever ink the button already uses rather
 * than from a pair of hardcoded black/white washes — on a filled button the
 * ripple should be the label's colour spreading, which is true on both papers
 * without a scheme test.
 */
function ripple(variant: ButtonVariant, theme: Palette): string {
  return variant === 'primary' ? `${theme.onAccent}33` : `${theme.faint}2e`;
}
