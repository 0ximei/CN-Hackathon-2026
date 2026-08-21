# MeshNet — a distributed offline search engine

Each device stores one **shard** of a corpus in a local database. When you search,
the query travels across an **offline mesh network**; every node runs semantic
search over its own shard, replies route back along the path the query took, and
the originating node answers with an **on-device LLM**.

No internet. No server. No cloud inference.

---

## The Bluetooth constraint, up front

The original brief was "connected through bluetooth using a PWA." That is not
achievable, and the reason is worth stating plainly:

- **Web Bluetooth implements the GATT Central role only.** A browser can connect
  *to* a peripheral; it cannot *advertise as* one. There is no
  `navigator.bluetooth.advertise()` in any shipping browser — peripheral mode
  remains an unimplemented request against the Community Group spec.
- Two phones running this app would therefore both be centrals, scanning for a
  peripheral that does not exist. **They can never see each other over BLE.**
- Firefox and every Safari version ship no Web Bluetooth at all.

So the architecture is unchanged and the radio moved behind an interface. The
mesh is written against [`Transport`](src/transport/Transport.ts), and each
physical layer is an implementation:

| Transport | Reach | MTU | Status |
|---|---|---|---|
| [`BroadcastTransport`](src/transport/BroadcastTransport.ts) | tabs on one machine | 64 KB | ships — the always-works demo |
| [`WebRTCTransport`](src/transport/WebRTCTransport.ts) | LAN / hotspot, no server | 16 KB | ships — QR or copy-paste pairing |
| `BleBridgeTransport` | phone → ESP32 → RF mesh | ~180 B | designed for, not built |

The BLE row is the honest version of the original idea: the phone is a central
talking to *its own* ESP32 over GATT, and the ESP32s mesh with each other. The
protocol already fragments to a 180-byte MTU, so that transport is a drop-in.

---

## How a query works

1. The query is embedded locally (all-MiniLM-L6-v2, 384-dim).
2. The vector is **int8-quantized**: 1536 bytes → 388. Over BLE that is the
   difference between 8 frames and 3.
3. A `QUERY` packet floods outward with TTL 4.
4. Every node dedups on message id, records the reverse path, re-floods to
   everyone except the sender, and searches **its own shard only**.
5. Nodes that find something above the relevance floor unicast a `RESULT` back
   along the learned route. Nodes that find nothing **stay silent**.
6. The origin collects until every known peer has replied (or 5s), merges,
   dedups, and re-ranks.
7. `DOC_REQ` pulls full passage text on demand — snippets travel in `RESULT`, so
   packets stay small.
8. Passages go into a grounded prompt; the answer cites each claim back to the
   node that supplied it.

### Routing

Two mechanisms, both visible in the UI:

- **Controlled flooding** for broadcast — TTL bound, split horizon, and a
  512-entry LRU of seen message ids so cycles terminate.
- **Backward learning** for unicast — every packet teaches "node X is reachable
  via link L, N hops away," the same trick a transparent bridge uses. Replies
  follow that route instead of costing a second flood.

If a reply's destination has gone offline, the packet is persisted to a
**store-and-forward** queue and retried when that node reappears.

---

## Running it

```bash
npm install && npm run corpus:build && npm run dev
```

Open the page in **three tabs**. Each tab is an independent node with its own
identity and its own IndexedDB, so give each one a different shard from the
"This node" panel. `34 passages reachable` in the masthead means the whole
corpus is online, split three ways.

Then ask *"how long do I cool a burn"* from a node that does **not** hold the
burns shard. The result comes back badged with the node that answered and its
hop count.

### Demoing the network

The Network controls panel exists to break things on stage:

- **Cut a link** — severs it at both ends, forcing the router to relearn a path
  through a relay. Watch the node jump from `1h` to `2h`.
- **Hop limit** — drop TTL to 1 and distant nodes stop answering.
- **Packet loss** — injected below the router, so the real recovery path runs.

### Tests

```bash
npm test
```

18 tests covering packet round-trips, fragment reassembly at a 185-byte MTU,
int8 quantization accuracy, and the routing invariants — TTL horizons, cycle
termination, backward learning, and rerouting around a broken link.

---

## Notes on two decisions that were not obvious

**The embedder runs WASM + q8, never WebGPU.** q8 weights are silently wrong on
the WebGPU execution provider. Measured on this corpus, *"how long do I cool a
burn"* scored **0.39** against the passage that answers it and **0.49** against
an unrelated rescue-signalling passage — worse than random, with no error raised
anywhere. The same weights on WASM score **0.70 / 0.11**. WebGPU is only correct
here with fp32, which is a ~90 MB download instead of ~23 MB. See
[`embedder.worker.ts`](src/search/embedder.worker.ts).

**A node with nothing relevant says nothing.** Without a relevance floor, a
shard that holds no answer still returns its four least-irrelevant passages, and
the answer layer cites them as though they were answers. On a first-aid corpus
that is the worst available failure — confident frostbite advice for a burn
question. There is an absolute floor per node and a relative cut-off at the
origin, and an out-of-corpus question returns *"Not in the mesh."*

---

## Corpus

Offline first-aid and disaster response, adapted from public-domain guidance —
bleeding, CPR, choking, burns, hypothermia, heat stroke, snake bite, water
purification, earthquake, flood. Chunks are distributed **round-robin** across
shards rather than grouped by topic, deliberately: it guarantees that answering
almost any question needs passages from several nodes, which is the behaviour
the system exists to demonstrate.

This is reference material for emergencies without connectivity. It is not a
substitute for professional medical care.
