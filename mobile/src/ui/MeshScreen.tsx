import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Keyboard,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { useMesh } from './useMesh';
import { useTheme } from './ThemeProvider';
import { type TabId, tabAccent } from './theme';
import { Header } from './mesh/Header';
import { SearchTab } from './mesh/SearchTab';
import { MapTab } from './mesh/MapTab';
import { FilesTab } from './mesh/FilesTab';
import { Composer } from './mesh/Composer';
import { NodeTab } from './mesh/NodeTab';
import { LogTab } from './mesh/LogTab';

type Mesh = ReturnType<typeof useMesh>;

/**
 * Icons alongside the labels, for two reasons that are both about the hand
 * rather than the eye: it doubles the height of a target that was a 38pt strip
 * of 11px text, and it gives each tab a shape that can be found without
 * reading — which is the mode this app is actually used in.
 *
 * Each tab also owns a hue (see `tabAccent`). Colour is doing navigation work
 * here, not decoration: the active tab, its indicator and every control inside
 * it share one colour, so the section announces itself before a word is read.
 */
const TABS: { id: TabId; icon: React.ComponentProps<typeof Ionicons>['name'] }[] = [
  { id: 'ask', icon: 'search' },
  { id: 'map', icon: 'git-network' },
  { id: 'files', icon: 'document-text' },
  { id: 'node', icon: 'hardware-chip' },
  { id: 'log', icon: 'pulse' },
];

/** How wide the moving indicator is, as a share of one tab's width. */
const INDICATOR_SHARE = 0.42;

function renderTab(t: TabId, mesh: Mesh, onCompose: () => void) {
  switch (t) {
    case 'ask':
      return <SearchTab mesh={mesh} />;
    case 'map':
      return <MapTab mesh={mesh} />;
    case 'files':
      return <FilesTab mesh={mesh} onCompose={onCompose} />;
    case 'node':
      return <NodeTab mesh={mesh} />;
    case 'log':
      return <LogTab activity={mesh.activity} />;
  }
}

export function MeshScreen({ mesh }: { mesh: Mesh }) {
  const { styles, theme, accent, setTab } = useTheme();
  const [index, setIndex] = useState(0);
  const [width, setWidth] = useState(Dimensions.get('window').width);
  const scrollRef = useRef<ScrollView>(null);
  const scrollX = useRef(new Animated.Value(0)).current;
  const [keyboardUp, setKeyboardUp] = useState(false);
  /**
   * The composer lives here rather than inside the Files tab, because it is not
   * a thing on a page — it covers the pager, locks the swipe and takes the back
   * button. All three are this component's to give.
   */
  const [composing, setComposing] = useState(false);

  // `Did` rather than `Will`: the Will* events are iOS-only, and this is an
  // Android app — on Android they never fire and the bar would never hide.
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => setKeyboardUp(true));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboardUp(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  // The settled tab is what owns the hue, so the whole screen recolours on
  // arrival rather than mid-swipe — a palette that changed continuously under
  // the thumb would read as a fault, not as feedback.
  useEffect(() => {
    setTab(TABS[index].id);
  }, [index, setTab]);

  // Tab taps jump instantly, same as before swipe existed — an animated glide
  // across several pages would visibly pass over ones outside the mount
  // window (see below) and flash blank. Swiping itself is always one page at
  // a time, which the window always covers, so it stays fully smooth.
  const goTo = (i: number) => {
    setIndex(i);
    scrollRef.current?.scrollTo({ x: i * width, animated: false });
    scrollX.setValue(i * width);
  };

  const onMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / width);
    if (i !== index) setIndex(i);
  };

  // The indicator is bound to scroll position rather than to the settled tab,
  // so a half-finished swipe shows itself as a half-finished move. It is the
  // one piece of motion here that reports something the user cannot otherwise
  // see; everything else in this app animates only when data changed.
  const tabWidth = width / TABS.length;
  const indicatorWidth = tabWidth * INDICATOR_SHARE;
  const lastPage = TABS.length - 1;
  const restX = (tabWidth - indicatorWidth) / 2;
  // Spans the whole pager, not one page: clamping a single-page range would
  // park the indicator under tab two and leave it there for the other three.
  const indicatorX = scrollX.interpolate({
    inputRange: [0, Math.max(1, width * lastPage)],
    outputRange: [restX, restX + tabWidth * lastPage],
    extrapolate: 'clamp',
  });

  return (
    <View style={styles.root}>
      <Header mesh={mesh} />

      <Animated.ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onMomentumScrollEnd}
        scrollEventThrottle={16}
        // A swipe under an open composer would page the tab out from beneath it,
        // and TalkBack would otherwise walk straight off the sheet into a tab
        // the sighted user cannot see.
        scrollEnabled={!composing}
        importantForAccessibility={composing ? 'no-hide-descendants' : 'auto'}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
          useNativeDriver: true,
        })}
        onLayout={(e) => {
          const next = e.nativeEvent.layout.width;
          setWidth(next);
          // Keep the current page snapped after the very first real
          // measurement replaces the Dimensions-based guess.
          scrollRef.current?.scrollTo({ x: index * next, animated: false });
          scrollX.setValue(index * next);
        }}
        style={{ flex: 1 }}
      >
        {TABS.map((t, i) => (
          <View key={t.id} style={{ width, flex: 1 }}>
            {/* Mounted one at a time (plus immediate swipe-neighbours) rather
                than all five at once: the map runs animations off real wire
                traffic and the log renders a couple of hundred rows, and
                keeping every tab alive behind a swipeable pager costs frames
                on the phones this has to run on. A blank placeholder still
                holds the page's width so paging math stays correct. */}
            {Math.abs(i - index) <= 1 ? renderTab(t.id, mesh, () => setComposing(true)) : null}
          </View>
        ))}
      </Animated.ScrollView>

      {/*
        Last in the tree, so it sits under the thumb rather than under the
        status bar. The activity is `adjustResize`, so an open keyboard shrinks
        this whole view — leaving the bar mounted would park five tabs directly
        on top of the keyboard and eat the little room left for results, which
        is the usual way a bottom tab bar ends up worse than a top one. It is
        unmounted instead: nothing to reach for while typing anyway.
      */}
      {!keyboardUp && !composing && (
        <View style={styles.tabBar}>
          <View style={styles.tabIndicatorTrack}>
            <Animated.View
              style={[
                styles.tabIndicator,
                {
                  width: indicatorWidth,
                  backgroundColor: accent,
                  transform: [{ translateX: indicatorX }],
                },
              ]}
            />
          </View>
          <View style={styles.tabs}>
            {TABS.map((t, i) => {
              const on = index === i;
              // Each tab wears its own colour even when inactive would be
              // cheaper — a strip of grey icons teaches nothing about where the
              // colours downstream came from.
              const hue = tabAccent[t.id][theme.scheme];
              return (
                <Pressable
                  key={t.id}
                  onPress={() => goTo(i)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={t.id}
                  android_ripple={{ color: `${hue}22`, borderless: false }}
                  style={({ pressed }) => [styles.tab, pressed && { opacity: 0.7 }]}
                >
                  <Ionicons name={t.icon} size={19} color={on ? hue : theme.faint} />
                  <Text style={[styles.tabText, on && { color: hue, fontWeight: '700' }]}>
                    {t.id.toUpperCase()}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {/* Last in the tree so it covers the masthead too: writing a document is
          not a thing you do *inside* the Files tab, it is the only thing on
          screen while it is happening. */}
      {composing && <Composer mesh={mesh} onClose={() => setComposing(false)} />}
    </View>
  );
}
