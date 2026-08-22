import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { useMesh } from './useMesh';

import { styles } from './mesh/styles';
import { Header } from './mesh/Header';
import { SearchTab } from './mesh/SearchTab';
import { MeshTab } from './mesh/MeshTab';
import { LogTab } from './mesh/LogTab';

type Mesh = ReturnType<typeof useMesh>;
type Tab = 'search' | 'mesh' | 'log';

export function MeshScreen({ mesh }: { mesh: Mesh }) {
  const [tab, setTab] = useState<Tab>('search');

  return (
    <View style={styles.root}>
      <Header mesh={mesh} />
      <View style={styles.tabs}>
        {(['search', 'mesh', 'log'] as Tab[]).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabOn]}>
            <Text style={[styles.tabText, tab === t && styles.tabTextOn]}>{t.toUpperCase()}</Text>
          </Pressable>
        ))}
      </View>
      {tab === 'search' && <SearchTab mesh={mesh} />}
      {tab === 'mesh' && <MeshTab mesh={mesh} />}
      {tab === 'log' && <LogTab activity={mesh.activity} />}
    </View>
  );
}

