import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

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

export function MeshScreen({ mesh }: { mesh: Mesh }) {
  const [tab, setTab] = useState<Tab>('ask');

  return (
    <View style={styles.root}>
      <Header mesh={mesh} />
      <View style={styles.tabs}>
        {TABS.map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            style={[styles.tab, tab === t && styles.tabOn]}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextOn]}>{t.toUpperCase()}</Text>
          </Pressable>
        ))}
      </View>

      {/* Mounted one at a time rather than hidden: the map runs animations and
          the log renders a couple of hundred rows, and keeping both alive
          behind the search tab costs frames on the phones this has to run on. */}
      {tab === 'ask' && <SearchTab mesh={mesh} />}
      {tab === 'map' && <MapTab mesh={mesh} />}
      {tab === 'files' && <FilesTab mesh={mesh} />}
      {tab === 'node' && <NodeTab mesh={mesh} />}
      {tab === 'log' && <LogTab activity={mesh.activity} />}
    </View>
  );
}
