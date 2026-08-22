import { useRef, useState } from 'react';
import {
  Dimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';

import type { useMesh } from './useMesh';
import { styles } from './mesh/styles';
import { Header } from './mesh/Header';
import { SearchTab } from './mesh/SearchTab';
import { MapTab } from './mesh/MapTab';
import { FilesTab } from './mesh/FilesTab';
import { NodeTab } from './mesh/NodeTab';
import { LogTab } from './mesh/LogTab';

type Mesh = ReturnType<typeof useMesh>;
type Tab = 'ask' | 'map' | 'files' | 'node' | 'log';

const TABS: Tab[] = ['ask', 'map', 'files', 'node', 'log'];

function renderTab(t: Tab, mesh: Mesh) {
  switch (t) {
    case 'ask':
      return <SearchTab mesh={mesh} />;
    case 'map':
      return <MapTab mesh={mesh} />;
    case 'files':
      return <FilesTab mesh={mesh} />;
    case 'node':
      return <NodeTab mesh={mesh} />;
    case 'log':
      return <LogTab activity={mesh.activity} />;
  }
}

export function MeshScreen({ mesh }: { mesh: Mesh }) {
  const [index, setIndex] = useState(0);
  const [width, setWidth] = useState(Dimensions.get('window').width);
  const scrollRef = useRef<ScrollView>(null);

  // Tab taps jump instantly, same as before swipe existed — an animated glide
  // across several pages would visibly pass over ones outside the mount
  // window (see below) and flash blank. Swiping itself is always one page at
  // a time, which the window always covers, so it stays fully smooth.
  const goTo = (i: number) => {
    setIndex(i);
    scrollRef.current?.scrollTo({ x: i * width, animated: false });
  };

  const onMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / width);
    if (i !== index) setIndex(i);
  };

  return (
    <View style={styles.root}>
      <Header mesh={mesh} />
      <View style={styles.tabs}>
        {TABS.map((t, i) => (
          <Pressable
            key={t}
            onPress={() => goTo(i)}
            style={[styles.tab, index === i && styles.tabOn]}
          >
            <Text style={[styles.tabText, index === i && styles.tabTextOn]}>{t.toUpperCase()}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onMomentumScrollEnd}
        onLayout={(e) => {
          const next = e.nativeEvent.layout.width;
          setWidth(next);
          // Keep the current page snapped after the very first real
          // measurement replaces the Dimensions-based guess.
          scrollRef.current?.scrollTo({ x: index * next, animated: false });
        }}
        style={{ flex: 1 }}
      >
        {TABS.map((t, i) => (
          <View key={t} style={{ width, flex: 1 }}>
            {/* Mounted one at a time (plus immediate swipe-neighbours) rather
                than all five at once: the map runs animations off real wire
                traffic and the log renders a couple of hundred rows, and
                keeping every tab alive behind a swipeable pager costs frames
                on the phones this has to run on. A blank placeholder still
                holds the page's width so paging math stays correct. */}
            {Math.abs(i - index) <= 1 ? renderTab(t, mesh) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
