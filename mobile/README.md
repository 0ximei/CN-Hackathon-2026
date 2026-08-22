# MeshNet for Android — a real Bluetooth mesh

The web build routes packets over browser tabs and WebRTC because it has no
choice: **Web Bluetooth implements the GATT Central role only.** A browser can
connect *to* a peripheral, but it cannot *be* one — there is no
`navigator.bluetooth.advertise()` in any shipping browser. Two phones running
the PWA are therefore both centrals, scanning for a peripheral that does not
exist, and they can never see each other.

Android has no such gap. `BluetoothLeAdvertiser` and `BluetoothGattServer` are
public API, so every node here **advertises, accepts connections, scans and
dials out at the same time**. That symmetry is the whole difference between a
star of client/server links and a mesh — and it is why this app is native.

Everything above the radio is the same code as the web build. The packet codec,
the flooding router with its TTL and dedup LRU, the backward-learned unicast
routes and the MTU framing are imported from `../src` rather than copied, so a
change to the protocol cannot leave a phone and a browser unable to read each
other's packets.

---

## What you need

BLE peripheral mode does not exist in the Android emulator, and neither does a
second device. **This can only be run on real hardware.**

- **Two or more Android phones**, Android 7.0 (API 24) or newer, with BLE.
  Three is much better — two phones prove a link, three prove *routing*.
- **JDK 17** and the **Android SDK** (Android Studio, or command-line tools with
  platform 35 and build-tools installed).
- USB debugging enabled on each phone.

```bash
java -version   # expect 17.x
adb devices     # expect one line per phone, "device" not "unauthorized"
```

## Build and run

```bash
cd mobile && npm install
```

```bash
npm run prebuild
```

```bash
npm run android
```

`prebuild` generates the `android/` project from `app.json` and autolinks the
local `modules/ble-mesh` module. Run it again after changing `app.json` or any
native dependency; it is not needed for JavaScript changes.

With more than one phone attached, `npm run android` will ask which to target —
run it once per device, or build the APK once and `adb install -r` it on the
rest.

Grant the Bluetooth permissions when prompted. On Android 12+ these are
`BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE` and `BLUETOOTH_CONNECT`; the manifest
marks the scan `neverForLocation`, so the app never asks for location. Older
phones are asked for location instead, because before Android 12 that is what
scanning was classified as.

## Proving it works

1. **One phone.** Search *"how do I treat a burn"*. Results come back instantly,
   badged `matched here`. This is local search — no radio involved.
2. **Second phone, MESH tab.** Within five to fifteen seconds each lists the
   other under REACHABLE NODES with `direct` and a negotiated MTU. The LOG tab
   shows the whole handshake: `dialling`, `outbound mtu 517B`, `linked to …`.
3. **Search again.** Results now include rows badged `matched by <name>`. Each
   node holds only ~60% of the corpus, so the mesh is genuinely finding
   passages the asking phone does not have.
4. **Tap a remote result.** It expands from a 200-character snippet to the full
   passage — that is a `DOC_REQ`/`DOC_RES` round trip, visible in the LOG tab.
   Snippets ride inside `RESULT` packets; bodies are fetched only when wanted.
5. **Third phone, out of range of the first.** Put two phones at opposite ends
   of a corridor with the third in the middle. Results from the far phone come
   back badged `· 2h` — two hops, relayed by a phone in the middle, which is the
   part that makes this a mesh rather than a set of links.
6. **Airplane mode on one phone mid-query.** The reply is written to the SQLite
   outbox instead of being dropped (TRAFFIC shows `parked for offline peers`),
   and is delivered when that node's next beacon arrives.

## How the radio works

`modules/ble-mesh/android/…/MeshRadio.kt` is where the interesting parts are.
Four details separate a BLE demo that works on a bench from one that works in a
room, and each is commented at the code:

- **Exactly one link per pair.** Both ends discover each other, so both would
  dial and you would get two links between two phones — double the traffic and
  every flood arriving twice. The lower node id owns the central role and the
  higher one waits, with a nine-second escape hatch in case the call never
  comes. No negotiation is needed: both sides know both ids.
- **Flow control.** `writeCharacteristic` and `notifyCharacteristicChanged`
  fail while the connection is congested and silently discard what you gave
  them. The classic Android BLE bug is to loop over your data, watch every call
  return, and lose most of it. Every link here has a queue drained by the
  completion callback and never faster.
- **Segmentation against the negotiated MTU**, not a guess. Each link asks for
  517 bytes, gets what the peer allows, and frames are cut to fit with a
  one-byte header carrying a sequence number — not for ordering, which GATT
  already guarantees, but so a truncated message is *detected* rather than
  silently concatenated into the next one.
- **One serialised thread.** The Android BLE stack is not re-entrant and
  misbehaves when driven from several threads, so every mutation runs on a
  single `HandlerThread`.

Nodes are found by a 128-bit service UUID in the advertisement, with the node id
in the scan response — the advertisement itself has no room left, since the UUID
alone costs 18 of its 31 bytes. Characteristics are unencrypted by design:
requiring encryption would force pairing, and a mesh whose nodes must be paired
by hand before they can route is not a mesh.

## What differs from the web build

| | Web | Android |
|---|---|---|
| Radio | tabs, WebRTC | **BLE, dual-role** |
| Storage | Dexie / IndexedDB | expo-sqlite |
| Embeddings | MiniLM via transformers.js | hashing embedder (below) |
| Answer generation | WebLLM | not ported — extractive results only |
| Replication | popularity/reliability driven | fixed per-node slice |

**The embedder is the significant one.** React Native has no Web Workers and no
WASM runtime with threads, so `Xenova/all-MiniLM-L6-v2` does not port. Running a
real transformer on Android means ExecuTorch or a TFLite delegate plus a ~23 MB
model download — the one thing a disaster-response tool cannot assume. So
`src/search/embedder.ts` is a hashing embedder over unigrams, bigrams and
character 4-grams: instant, deterministic, no download, and **not semantic**. It
matches "burns" to "burned" through shared character n-grams but will not match
"haemorrhage" to "bleeding", because nothing in it has read a sentence. BM25
runs alongside and is blended at rank time, which covers the exact clinical
terms that matter most in this corpus.

Swapping in a real model means implementing the `Embedder` interface and nothing
else — but note that embeddings travel the wire inside `QUERY` packets, so
**every node in a mesh must use the same one**. A mesh with two different
embedders will route packets happily and return nonsense.

## Testing

The portable half runs under the repo root's Vitest, including a three-node
simulated mesh that asserts a passage held only by a node two hops away comes
back correctly attributed:

```bash
npm test
```

The radio itself is not covered there — nothing short of two phones can
exercise a BLE stack — so `MeshRadio.kt` is verified by the steps under
*Proving it works* above.

## Known limits

- **Android only.** iOS can do dual-role BLE, but backgrounded apps advertise
  in an overflow area that only other iOS devices can see, so a cross-platform
  mesh needs a different discovery story.
- **Four outbound links per node.** Android stacks vary between about four and
  seven concurrent GATT connections; the cap is deliberate and set in
  `MeshRadio.MAX_CENTRAL_LINKS`.
- **Foreground only.** There is no foreground service, so Android will suspend
  the radio when the app is backgrounded. Keep the screen on for a demo.
- **A few kB/s per link.** BLE is slow. The collection window is six seconds for
  that reason, and large documents take visible time to move.
