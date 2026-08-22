# MeshNet — a distributed offline search engine

Upload a document and it enters a mesh of browsers, then spreads on its own.
When you search, the query travels across an **offline mesh network**; every
node runs semantic search over what it knows, replies route back along the path
the query took, and the originating node answers with an **on-device LLM**.

Nothing is preloaded and nothing is assigned. Documents arrive by upload and
replicate themselves according to how popular they are, how much room each node
has, and how reliable each node has proven to be.

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
| [`BleTransport`](mobile/src/transport/BleTransport.ts) | phone ↔ phone, real BLE | negotiated, ~517 B | ships — **Android app**, see [`mobile/`](mobile/README.md) |

The last row is the original idea, delivered — but it is not a PWA, and it could
not have been. The gap is the *peripheral role*, not Bluetooth itself: Android
exposes `BluetoothLeAdvertiser` and `BluetoothGattServer` as public API, so a
native node can advertise, accept connections, scan and dial out all at once.
That symmetry is what turns a star of client/server links into a mesh.

[`mobile/`](mobile/README.md) is a React Native app that does exactly that, on
two or more real Android phones with no router, no pairing and no internet. It
imports the packet codec, router and framing from `src/` rather than copying
them, so both builds speak the same protocol.

---

## Two tiers: knowing versus storing

Every passage is stored as two separable things.

| Tier | Contents | Size | Replicated to |
|---|---|---|---|
| **metadata** | title, heading, 200-char snippet, int8 embedding | ~620 B, fixed | up to 8 nodes |
| **body** | the full passage text | as long as the passage | 2–5 nodes, by policy |

Metadata is what you need to *find* something. The body is what you need to
*read* it. Making discovery highly available is cheap; making content highly
available is not. So a node can hold metadata for the whole mesh while storing
only the passages the policy assigns it, and still answer *"I know something
relevant, and here is who has it."*

**An honest note on the size win.** Metadata is a *fixed* ~620 bytes, 384 of
which is the embedding. On the short first-aid samples here (~740-byte
passages) that is nearly half a body, and wide metadata replication is barely
cheaper than wide body replication — the UI shows the real ratio rather than a
flattering one. On documents chunked at 1.5–4 KB it is a third to a sixth. The
structural argument does not depend on the ratio: discovery stays available
when the nodes holding the content do not.

---

## How a query works

1. The query is embedded locally (all-MiniLM-L6-v2, 384-dim).
2. The vector is **int8-quantized**: 1536 bytes → 388. Over BLE that is the
   difference between 8 frames and 3.
3. A `QUERY` packet floods outward with TTL 4.
4. Every node dedups on message id, records the reverse path, re-floods to
   everyone except the sender, and searches **its own catalog** — everything it
   has metadata for, whether or not it stores the text.
5. Nodes that find something above the relevance floor unicast a `RESULT` back
   along the learned route, each hit naming a node that **holds the body**.
   Nodes that find nothing **stay silent**.
6. The origin collects until every known peer has replied (or 5s), merges,
   dedups, and re-ranks.
7. `DOC_REQ` pulls full text from a *holder* — often not the node that answered,
   because answering only requires metadata.
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

## Replication

Every node runs the same loop against gossiped state, with no coordinator and
no consensus. It lives in [`policy.ts`](src/replication/policy.ts) as pure
functions and [`Replicator.ts`](src/replication/Replicator.ts) as the part that
touches the network and the clock.

**Where a body goes** — weighted rendezvous hashing. Each node scores itself for
each chunk (`weight / -ln(u)`, u from a hash of chunk and node id); the top-K
scores are the replica set. Every node computes the same ranking from the same
inputs. The property that earns HRW its place over a hash ring is minimal
disruption: when a node leaves, only the chunks *it* held move, and they spread
across the survivors rather than landing on one neighbour. There is a test for
exactly that.

**How many copies** — the larger of two pressures:

| Signal | Effect | Where it comes from |
|---|---|---|
| **popularity** | hot chunks earn up to 3 extra copies | a G-counter: each node counts its own accesses and gossips its share, readers sum |
| **reliability** | flaky holders raise the target until 1.5 copies are *expected online* | locally observed beacon regularity and answered requests — never self-reported |
| **capacity** | a full node's weight drops to zero and it stops being chosen | self-reported free bytes, the one thing a node is the authority on |
| **availability** | reconciliation acts on *live* holders, not claimed ones | holder claims gossiped in `ANNOUNCE`, expired after 60s |

Reliability is measured, not announced, so two nodes can rank candidates
slightly differently. That is deliberate: acting on the observed replica count
means disagreement converges to slightly too many copies rather than a gap, and
over-replication is safe where under-replication is not.

**The invariant that outranks everything:** never drop the last live copy of a
body. Storage pressure can evict anything else.

---

## Running it

```bash
npm install && npm run corpus:build && npm run dev
```

Open the page in **three tabs**. Each tab is an independent node with its own
identity and its own IndexedDB.

1. In tab one, drop a `.txt` or `.md` file onto the Library panel — or click one
   of the sample documents, which are uploaded through exactly the same path.
2. Watch the other two tabs. Metadata arrives first: they go to `knows 5 · 0 B`
   stored while `ANNOUNCE` packets cross the wire log. Bodies follow as the
   replicator pulls them, and each document's meter fills toward its target.
3. Ask *"how long do I cool a burn"* from any tab.

### Demoing the storage split

Set a tab's **storage budget** to `4 KB` in the This node panel. It is over
budget immediately, evicts every body it holds, and settles as a metadata-only
node — `knows 5, stores 0`. Search from it: the results still come back, badged
`body fetched`, because it matched on metadata it kept and pulled the text from
a holder. That is the entire design in one interaction.

Raise the budget again and it re-pulls whatever it ranks for.

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

53 tests. Packet round-trips including `ANNOUNCE` with a 384-byte embedding,
fragment reassembly at a 185-byte MTU, int8 quantization accuracy, the routing
invariants (TTL horizons, cycle termination, backward learning, rerouting
around a broken link), and the replication policy — placement determinism,
minimal disruption on node loss, weight proportionality, target response to
popularity and to unreliability, convergence and settling, and the
never-drop-the-last-copy invariant.

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
node that knows nothing relevant still returns its four least-irrelevant passages, and
the answer layer cites them as though they were answers. On a first-aid corpus
that is the worst available failure — confident frostbite advice for a burn
question. There is an absolute floor per node and a relative cut-off at the
origin, and an out-of-corpus question returns *"Not in the mesh."*

---

## Sample documents

Six markdown files of offline first-aid and disaster response, adapted from
public-domain guidance — bleeding, CPR, choking, burns, hypothermia, heat
stroke, snake bite, water purification, earthquake, flood.

They are **not** preloaded. `npm run corpus:build` copies them into `public/`
untouched, and the app uploads them through the same parse → chunk → embed →
announce path as a file dragged in from the desktop. A build step that
pre-chunked them would be quietly exercising a path real uploads never take.

This is reference material for emergencies without connectivity. It is not a
substitute for professional medical care.
