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
routes, the MTU framing **and the replication policy** are imported from
`../src` rather than copied, so a change to the protocol cannot leave a phone
and a browser unable to read each other's packets, and the two cannot converge
on different replica sets for the same document.

---

## What you need

BLE peripheral mode does not exist in the Android emulator, and neither does a
second device. **This can only be run on real hardware.**

- **Two or more Android phones**, Android 7.0 (API 24) or newer, with BLE.
  Three is much better — two phones prove a link, three prove *routing*, and
  the storage-budget demo below needs three by construction.
- **JDK 17** and the **Android SDK** (Android Studio, or command-line tools with
  platform 35 and build-tools installed).
- USB debugging enabled on each phone.

```bash
java -version   # expect 17.x
```

```bash
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

> **If you are updating an existing checkout**, rebuild rather than just
> reloading JavaScript. `expo-crypto` was added for identity key generation and
> is a native module. Running an older binary is not fatal — the app falls back
> to a JS entropy pool and says so on the identity card — but a key generated
> that way is a demo credential and nothing more.

---

## Identity

Every node has an **Ed25519 keypair**, generated on the device on first launch,
and its node id is a hash of the public key. That makes the id
*self-certifying*: claiming an id and proving it are the same act, and there is
no registry to consult — which matters, because there is no network to reach one
over.

**Creating one.** First launch asks for a display name and nothing else, because
a name is the only part a person can meaningfully choose. The keypair is
generated before the radio starts, since the node id decides the database
namespace, the BLE dial/wait tie-break and every holder record the node writes.

**Verifying one.** Two separate questions live here, and the app keeps them
apart on purpose:

| Question | Who can answer it | State shown |
|---|---|---|
| Is this node really the id it claims? | the radio, by challenge/response | `key proven` |
| Is this node the person in front of me? | only two people comparing screens | `verified in person` |

The first happens automatically. On a peer's first beacon this node sends an
`IDENT_REQ` carrying sixteen random bytes; the peer replies with its public key,
its name, the nonce echoed back, and a signature over all three. The verifier
checks that the signature is valid **and** that the node id in the packet header
really is the hash of the key that signed. A response to a challenge that was
never sent is discarded rather than acted on, so a signature captured off the
air cannot be replayed.

The second cannot be automated, because an attacker in the room generates a
perfectly valid key of their own. So the NODE tab shows a **safety number** —
thirty digits and six emoji derived from *both* public keys, sorted, so both
phones display exactly the same thing without either side going first. Comparing
it out loud and tapping *it matches* is the only way a node reaches `verified in
person`, and software never awards that state to itself.

Trust is on first use, with the second use actually checked: if an id starts
signing with a different key, it is flagged `key changed` and any in-person
confirmation is dropped, because what was confirmed no longer exists. A peer
that never answers is left `unverified` — an older build cannot sign, and that
is a different thing from a failed signature, so it is reported differently.

A verified peer's results are attributed to the name it **signed**, not the one
it beacons: `HELLO` is unauthenticated, so a node that has proven a name must
not be able to display a different one afterwards.

The private key lives in the app's own SQLite file in private app storage. The
Android Keystore is where it belongs and would keep it off the JS heap entirely;
signing happens in JavaScript here, so it cannot. The onboarding screen says so.

---

## Two tiers: knowing versus storing

Every passage is stored as two separable things, exactly as in the web build.

| Tier | Contents | Size | Replicated to |
|---|---|---|---|
| **metadata** | title, heading, 200-char snippet, int8 embedding | ~620 B, fixed | up to 4 nodes |
| **body** | the full passage text | as long as the passage | 2–5 nodes, by policy |

Metadata is what you need to *find* something; the body is what you need to
*read* it. Making discovery highly available is cheap, making content highly
available is not — so a node can hold metadata for the whole mesh while storing
only the passages the policy assigns it, and still answer *"I know something
relevant, and here is who has it."*

This is visible from the first launch: the built-in corpus seeds **metadata for
every passage and bodies for about 60% of them**, so a phone that has never met
another node already reads `knows 43 · stores 26`.

**Replication** runs the same loop the browser does, against the same pure
functions in [`policy.ts`](../src/replication/policy.ts): weighted rendezvous
hashing for placement, a target driven by popularity and *locally observed*
reliability, capacity as a self-reported weight, and the invariant that outranks
all of them — never drop the last live copy of a body. Only the constants differ,
and they differ because BLE moves a few kilobytes a second: two body pulls per
pass instead of three, eight seconds between passes instead of six.

---

## Proving it works

1. **One phone.** Create an identity, then search *"how do I treat a burn"*.
   Results come back instantly, badged `matched here`. This is local search — no
   radio involved. Some rows will say `snippet only · body on …`: those are
   passages this phone knows about and does not hold.

2. **Second phone, MAP tab.** Within five to fifteen seconds each lists the
   other under REACHABLE NODES with `direct`, a reliability bar, and its free
   space. Coloured dots cross the edges of the topology view as packets actually
   move; the LOG tab shows the same events as a packet trace.

3. **Check the badge.** Each peer shows `key proven` within a second or two of
   being discovered. Open NODE › VERIFYING OTHER NODES, tap *safety number* on
   both phones, and confirm they match before tapping *it matches*.

4. **Search again.** Results now include rows badged `matched by <name>`, and
   rows whose body was fetched from a *third* node — the one that answered often
   is not the one that holds the text.

5. **Tap a remote result.** It expands from a 200-character snippet to the full
   passage — a `DOC_REQ`/`DOC_RES` round trip, visible in the LOG tab. Snippets
   ride inside `RESULT` packets; bodies are fetched only when wanted.

6. **Upload a file** on the FILES tab. Metadata reaches the other phones almost
   immediately; the copies meter fills over the next few reconcile passes as
   bodies are pulled by policy. `2.0/2 copies` means two live replicas against a
   target of two.

7. **Third phone, out of range of the first.** Put two phones at opposite ends
   of a corridor with the third in the middle. Results from the far phone come
   back badged `· 2h` — two hops, relayed by the phone in the middle, which is
   the part that makes this a mesh rather than a set of links.

8. **Shrink the storage budget** to 16 KB on NODE. The phone goes over budget
   immediately, sheds every body it can, and settles as a metadata-only node —
   `knows 43, stores 0`. Search from it: the results still come back, because it
   matched on metadata it kept and pulled the text from a holder. That is the
   entire design in one interaction. Raise the budget again and it re-pulls
   whatever it ranks for.

   This needs **three phones**. `MIN_BODY_REPLICAS` is 2, so on a two-phone mesh
   a node holding one of the only two copies is not allowed to shed it however
   far over budget it is — availability outranks storage pressure, deliberately.

9. **Break the network on purpose**, from MAP › NETWORK CONTROLS. Cut a link and
   watch a peer jump from `1h` to `2h` as the router relearns a path through a
   relay. Drop the hop limit to 1 and distant nodes stop answering. Inject packet
   loss and watch the recovery run for real — loss is applied between the radio
   and the router, so nothing is mocked out.

10. **Airplane mode on one phone mid-query.** The reply is written to the SQLite
    outbox instead of being dropped (TRAFFIC shows `parked for offline peers`),
    and is delivered when that node's next beacon arrives.

---

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
by hand before they can route is not a mesh. What a node *is* is established
above the link, by the identity exchange, not by whether it managed to bond.

---

## What differs from the web build

| | Web | Android |
|---|---|---|
| Radio | tabs, WebRTC | **BLE, dual-role** |
| Storage | Dexie / IndexedDB | expo-sqlite, same two tiers |
| Replication | shared `policy.ts` | **shared `policy.ts`** |
| Identity | random per tab, unauthenticated | **Ed25519, challenge/response** |
| Embeddings | MiniLM via transformers.js | hashing embedder + BM25 (below) |
| Relevance floor | cosine ≥ 0.42 | blended ≥ 0.40 (below) |
| Answer generation | WebLLM | not ported — extractive answers |
| Topology view | SVG | plain Views + `Animated` |
| Pairing | QR / copy-paste | none needed — BLE discovers |

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

**The relevance floor had to be rebuilt around that.** The web build's rule — a
node with nothing relevant says nothing, rather than returning its four
least-irrelevant passages for the answer layer to cite — matters just as much
here, but its threshold does not port. Cosine from a hashing embedder is a poor
discriminator: unrelated passages reach 0.24 unaided. The obvious fix, blending
in BM25, does not work as a *gate* for two reasons worth knowing about:
`BM25Index.normalize` scales the best match to 1.0 whatever it is, so a question
about sourdough produces a 1.0 too; and raw BM25 is not comparable either,
because its IDF term collapses on a small index — a node holding four passages
scores every term identically, so a threshold tuned on a full corpus silences a
node that has just been handed its first document.

So the gate in [`relevance.ts`](src/search/relevance.ts) uses **query-term
coverage**: the fraction of the question's content words that appear in the
passage at all. It is absolute, independent of how much the node knows, and
comparable between two nodes with completely different catalogs — which matters,
because these scores travel inside `RESULT` packets and are merged at the asking
node. BM25 keeps its job as a local tie-break *below* the gate, where a score
normalised against one node's index cannot distort another's.

Measured over the sample corpus: genuine top hits score 0.45–0.92, the best an
out-of-corpus question manages is 0.36, and a node holding a single passage
scores 0.63 for a question about it against 0.05 for one about sourdough. The
floor is 0.40.

Swapping in a real model means implementing the `Embedder` interface and nothing
else — but note that embeddings travel the wire inside `QUERY` packets, so
**every node in a mesh must use the same one**. A mesh with two different
embedders will route packets happily and return nonsense.

---

## Testing

The portable half runs under the repo root's Vitest — the mesh, the replication
loop, the identity layer, and the shared protocol:

```bash
npm test
```

116 tests. Alongside the web build's packet round-trips, framing, routing
invariants and replication policy, the mobile half covers:

- a three-node simulated mesh where a passage held only two hops away comes back
  correctly attributed;
- a node answering from metadata it holds no body for, and the fetch being
  routed to a node that does hold it;
- a node shedding every body but keeping its metadata when its budget shrinks —
  and refusing to shed the last live copy when there is nowhere else;
- an upload replicating to a peer by policy, and reaching a peer that joined
  after the upload happened;
- the relevance floor returning nothing for an out-of-corpus question;
- identity: key derivation, signature verification, id-to-key binding, replayed
  and unsolicited responses, key-change detection, and the rule that in-person
  trust is only ever granted on top of a proven key.

The radio itself is not covered there — nothing short of two phones can exercise
a BLE stack — so `MeshRadio.kt` is verified by the steps under *Proving it
works* above.

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
- **A small mesh converges to holding everything.** The replica target is at
  least two and rises with unreliability, so on two or three phones every node
  ends up ranking for every chunk and the initial 60% slice evens out. That is
  the policy working, not failing — a three-node mesh genuinely cannot afford to
  hold fewer copies. The storage budget is the control that recreates the
  asymmetry on demand.
- **The web build does not answer identity challenges.** It has no keypair, so a
  browser node on a mixed mesh stays `unverified` to every phone. It routes and
  replicates normally; it just cannot prove which node it is.
- **Identity keys are not in the Keystore.** See the note above. Treat them as
  demo credentials.
