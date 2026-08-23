import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';

import { makeStyles, type Styles } from './mesh/styles';
import {
    type Palette,
    type Scheme,
    type SchemePreference,
    type TabId,
    palettes,
    seedAccent,
    tabAccent,
} from './theme';

/**
 * Which palette is in force, and which hue the current tab owns.
 *
 * Both sheets are built once here rather than per render. `StyleSheet.create`
 * has a real cost and there are only ever two possible answers, so paying it
 * twice at startup is strictly cheaper than paying it on every scheme read.
 */
const SHEETS: Record<Scheme, Styles> = {
    light: makeStyles(palettes.light),
    dark: makeStyles(palettes.dark),
};

interface ThemeValue {
    theme: Palette;
    styles: Styles;
    /** The current tab's hue. Everything that fills or highlights uses this. */
    accent: string;
    /** What the user chose; `null` means "follow the system". */
    preference: SchemePreference;
    setPreference: (next: SchemePreference) => void;
    setTab: (tab: TabId) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({
    children,
    preference,
    onPreferenceChange,
}: {
    children: React.ReactNode;
    /**
     * The stored choice, once storage is readable. It arrives late — the mesh
     * database opens after the first paint — so it is a prop rather than
     * something this provider loads, and a change to it re-syncs the state.
     */
    preference: SchemePreference;
    onPreferenceChange: (next: SchemePreference) => void;
}) {
    const system = useColorScheme();
    const [tab, setTab] = useState<TabId>('ask');
    const [local, setLocal] = useState<SchemePreference>(preference);

    // The stored preference wins over whatever this session started with, but
    // only when it actually arrives — a null from storage means "never chose",
    // which is the same as the default and must not clobber a live choice.
    useEffect(() => {
        if (preference) setLocal(preference);
    }, [preference]);

    const value = useMemo<ThemeValue>(() => {
        const scheme: Scheme = local ?? (system === 'light' ? 'light' : 'dark');
        return {
            theme: palettes[scheme],
            styles: SHEETS[scheme],
            accent: tabAccent[tab]?.[scheme] ?? seedAccent[scheme],
            preference: local,
            setPreference: (next) => {
                setLocal(next);
                onPreferenceChange(next);
            },
            setTab,
        };
    }, [local, system, tab, onPreferenceChange]);

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
    const value = useContext(ThemeContext);
    if (!value) throw new Error('useTheme must be used inside a ThemeProvider');
    return value;
}
