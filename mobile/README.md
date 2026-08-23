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

This project stands on its own. The radio-agnostic half of the mesh — the packet
codec, the MTU framing, the flooding router with its TTL and dedup LRU, the
store-and-forward queue, the replication policy, BM25 and the vector helpers —
lives under [`src/core/`](src/core) and is plain TypeScript with no DOM, no Node
and no React Native in it. `@core/*` resolves there and nowhere else.

It used to resolve into the sibling web app, on the reasoning that one copy of
the codec cannot drift. What that actually bought was an app which could not be
built, tested or checked out without the other project present, and a Metro
config whose job was to stop the bundler wandering into the web app's
`node_modules` and serving a second copy of React from it. The copy is the
lesser problem, and it is a *checked* problem:
[`src/core/protocol/protocol.test.ts`](src/core/protocol/protocol.test.ts)
carries the codec round-trips, so a drift between the two builds shows up as a
failing test rather than as two devices that cannot read each other.

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
thirty digits and six icons derived from *both* public keys, sorted, so both
phones display exactly the same thing without either side going first. The
icons are drawn from a bundled vector font rather than from emoji, so two
phones cannot disagree about the picture they are showing. Comparing it out
loud and tapping *it matches* is the only way a node reaches `verified in
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

A fresh install holds nothing. The app used to ship six first-aid documents and
plant them on first launch, which made an empty phone look populated and gave a
demo something to search — but it also meant most of what a node held was not
the user's, every peer held a byte-identical copy, and neither discovery nor
replication was being exercised by any of it. The gap between `knows` and
`stores` now opens because the policy put it there.

**Replication** runs the same loop the browser does, against the same pure
functions in [`policy.ts`](src/core/replication/policy.ts): weighted rendezvous
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
   the part that makes this a mesh rather than a set of links. Watch the MAP:
   it is layered by distance, so the far phone sits a row *below* the relay it
   is reached through, with no line between it and this one, and packets to it
   visibly turn the corner at the middle phone. Nothing on that graph joins two
   nodes that have no radio link — a peer past two hops gets a faint tail
   standing in for the hops this node cannot see, which is a different claim
   from either a link or nothing.

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
A handful of details separate a BLE demo that works on a bench from one that
works in a room, and each is commented at the code:

- **Exactly one link per pair.** Both ends discover each other, so both would
  dial and you would get two links between two phones — double the traffic and
  every flood arriving twice. The lower node id owns the central role and the
  higher one waits, with a nine-second escape hatch in case the call never
  comes. No negotiation is needed: both sides know both ids.
- **Liveness outranks the tie-break.** That rule decides between two links that
  both work, and it cannot see the difference between a working link and a dead
  one. Asked to, it keeps whichever the role says — so a link that stopped
  carrying anything half a minute ago beats the one the peer just built to
  replace it, and then beats the next replacement, and the next. Peers rotate
  their BLE address, so the new link arrives on a MAC the old one never used
  and none of the address-based guards catch it. Dead rivals are reaped before
  the tie-break runs, and an advertisement from a node whose link has gone quiet
  is treated as what it is: proof the peer is powered, in range, and not
  reaching us on that link.
- **A connect path built around status 133.** 133 is `GATT_ERROR`, the generic
  code the Android stack returns for most of its internal refusals, and four of
  its causes are the caller's to avoid. The scan is paused for the duration of
  a direct attempt, because an LE scan running during connection establishment
  is its most common trigger and this one scans at `SCAN_MODE_LOW_LATENCY`.
  `connectGatt` is issued on the main looper, since the stack binds part of its
  callback plumbing to the calling thread. And after two failed direct attempts
  the peer is handed to `autoConnect`, which waits for a device instead of
  insisting it is there.
- **Giving a handle back in the order the stack needs.** `disconnect()` starts
  an asynchronous teardown; `close()` unregisters the client interface
  immediately. Calling them back to back — the obvious way to write it — pulls
  the registration out from under a teardown that has not happened yet, so
  nothing finishes it and nothing reports it. The connection lingers, the next
  `connectGatt` to that device attaches to the *existing* ACL instead of
  opening a fresh one, and when the stack finally reaps the orphan a few
  seconds later it takes the new link with it. That is a link that connects,
  looks healthy, and dies seconds later for no reason either end can see, over
  and over — and each round burns one of the small fixed number of client
  interfaces an app gets, until `connectGatt` fails for every peer and the node
  goes silent until the process restarts. So: disconnect, wait for the callback
  that says it happened, *then* close, with a two-second timeout for the
  callback that never comes. A handle that never connected is only closed —
  disconnecting that one is what strands it.
- **Backoff on a failed dial.** The GATT client takes about one attempt at a
  time and answers a tight retry loop with 133. Scan results arrive several
  times a second, so a dial path with no backoff turns one failed connection
  into an unbounded redial storm — a log full of `dialling …` and a mesh that
  never links. Each consecutive failure doubles the wait, to a minute; a
  successful handshake clears the record. Scan restarts are rate-limited for
  the same reason: Android silently stops reporting results to an app that
  calls `startScan` more than five times in thirty seconds.
- **An airtime budget.** One radio has to advertise, scan, and service every
  live connection, and `SCAN_MODE_LOW_LATENCY` is a 100% duty cycle — the
  controller scans in every interval and keeps nothing back. That is the right
  setting for an empty room and fatal once a link exists: the connection events
  lose to the scan, get missed, and the link dies on its supervision timeout a
  few seconds after coming up, looking for all the world like the peer hung up.
  So a node with no links hunts hard, and a node that has found the mesh backs
  both the scan and the advertiser off to a duty cycle that leaves room to keep
  what it has. Finding *more* peers is slower; a peer found over a link that
  then drops was worth nothing anyway.
- **Deadlines on everything the stack owes us.** Android does not always
  deliver a completion callback, and a link whose last write never completed
  stays subscribed, stays in the peer list, and never moves another byte —
  quieter and harder to spot than a disconnect. The tick tears down a link with
  a segment outstanding for twelve seconds, one that has heard nothing at all
  for fifty, and one that subscribed but never said who it is. A link that has
  gone quiet for twenty seconds gets a HELLO first, since a half-open
  connection only reveals itself when you try to use it.
- **Flow control.** `writeCharacteristic` and `notifyCharacteristicChanged`
  fail while the connection is congested and silently discard what you gave
  them. The classic Android BLE bug is to loop over your data, watch every call
  return, and lose most of it. Every link here has a queue drained by the
  completion callback and never faster. Congestion is not failure: refusals are
  retried for six seconds before the link is given up, which sounds long until
  you watch two nodes trade catalogues five seconds after meeting — tens of
  kilobytes into one link in a single tick, both directions at once, while both
  radios are still advertising and scanning.
- **Segmentation against the negotiated MTU and the attribute ceiling**, not a
  guess and not the MTU alone. Bluetooth caps a single attribute value at 512
  octets however large the ATT MTU grows, and Android enforces it by *throwing*
  rather than returning a status — so sizing segments from a 517-byte MTU gives
  514-byte values and every write and every notify of every multi-segment
  message fails, while a one-segment beacon sails through. Peers find each
  other, link, identify and beacon perfectly, and not one byte of content ever
  crosses. `MeshWireTest` asserts the arithmetic at every MTU, because nothing
  short of two phones in a room could see it otherwise. Frames are cut to fit
  with a one-byte header carrying a sequence number — not for ordering, which GATT
  already guarantees, but so a truncated message is *detected* rather than
  silently concatenated into the next one. Detected, and then dropped: a
  message is all-or-nothing across its segments, nothing retransmits, and a
  link that dies mid-message clears its queue without telling anyone. Beacons
  are one segment and re-sent every three seconds, so they always heal; a
  metadata packet is several and is sent once, so what has to heal it is the
  layer above asking again. That asymmetry is why a mesh can show its peers
  perfectly while no file ever crosses it.
- **One serialised thread.** The Android BLE stack is not re-entrant and
  misbehaves when driven from several threads, so every mutation runs on a
  single `HandlerThread`.

Nodes are found by a 128-bit service UUID in the advertisement, which carries
the node id alongside it: flags cost 3 of the 31 bytes and the UUID 18, leaving
just enough for four bytes of id and its header. The id is repeated in the scan
response, which is free, but it cannot live *only* there — an advertisement and
its scan response are separate radio events, and whether the stack merges them
before handing over a `ScanResult` is up to the stack. A peer whose id cannot be
read is one the tie-break cannot rank, so it is skipped entirely.
Characteristics are unencrypted by design:
requiring encryption would force pairing, and a mesh whose nodes must be paired
by hand before they can route is not a mesh. What a node *is* is established
above the link, by the identity exchange, not by whether it managed to bond.

---

## Who wrote this

Node identity was already provable: a peer answers a challenge with a signature
and its id is the hash of its key, so claiming an id and proving it are the same
act. That says nothing about a *document*. A file crosses several hops, is
re-announced by nodes that did not write it, and lands on phones that have never
met its author — so the proof has to travel with the document, not with the link
it arrived on.

An upload is signed before its first announcement leaves. What travels is the
author's Ed25519 public key, a signature over the document's manifest, and a
SHA-256 of the content. A receiver checks three things, and they answer
different questions:

1. **The signature verifies** under the key that came with it — somebody holding
   that private key attested to this exact manifest.
2. **The key hashes to the claimed author id.** Without this, step 1 proves only
   that *someone* signed it; a forger can always sign their own forgery with
   their own key and staple it to a stolen author id.
3. **The content hashes to what was signed** — the part that covers the bytes
   rather than the description of them.

Every field in the manifest is length-prefixed, because without that a manifest
with title `ab` and source `c` encodes identically to one with title `a` and
source `bc`, and one signature would verify both — a free way to relabel someone
else's document.

The Files tab shows the author, the hash and the signature, with the document
marked `SIGNED`, `UNSIGNED` or `FORGED`. Those are three states, not two.
`UNSIGNED` is an honest absence — a node with no keys — where `FORGED` is an
accusation, and conflating them would either slander an honest node or hide a
real attack. A forged document is still ingested, because
refusing data on suspicion is how a mesh loses the ability to route; it is shown
as claiming an author rather than having one, and the key it arrived with is
discarded rather than stored.

**Two honest limits.** The content check needs the whole document: the hash
covers every passage in order, so a node holding four of six says "not held in
full here" rather than reporting a failure it did not observe. And this binds a
document to a *keypair*, not to a person — binding a keypair to a human is what
the safety-number comparison in the Node tab is for.

Attestation costs 128 bytes on an announcement: 32 for the hash, 96 for the key
and signature, and the 96 are omitted entirely when a document is unsigned,
which is most of what a fresh node gossips.

## Answers

Retrieval finds passages; the generator turns them into an answer. On this build
that is llama.cpp, through `llama.rn`, running a quantised GGUF on the CPU.

**The model is never the source.** It is handed the retrieved passages, numbered,
and told to restate them with citations — a 0.5B model asked a first-aid
question from its own weights produces fluent, confident, wrong dosages, which
on this corpus is the worst failure available. `src/core/llm/prompt.ts` holds
that prompt, and `src/llm/context.ts` cuts the passages to fit the window before
they reach it: llama.cpp does not politely shorten an over-long prompt, it drops
tokens from the front, and the front is where the system prompt lives.

**It is optional at every level.** No model present, a model that will not load,
a generation that fails or comes back too short — every one of those falls
through to the extractive answer, which is the retrieved sentences that best
match the question. Those cannot invent a dosage, and for procedural first aid they
are often better than a paraphrase. Every answer says which mode produced it, and
`hasLlm` is beaconed in the HELLO capability bits so the mesh knows which nodes
can generate.

**Getting a model onto a phone** has two routes, and only one of them is the
interesting one. Downloading needs a network once — the Node tab lists three
(360M / 0.5B / 1B, 258 MB to 770 MB) with real sizes and a resumable progress
bar. Opening a `.gguf` already on the device needs no network at all, which is
the route that works where this app is meant to be used: a model can arrive over
USB, on a card, or from another phone's file manager. CPU only, deliberately —
Android GPU backends vary by vendor and fail in ways that look like bad answers
rather than errors.

Adding `llama.rn` costs about 74 MB of native libraries in the APK: llama.cpp is
shipped as one `.so` per ARM feature level (v8, v8.2, dotprod, i8mm) and picks
the best at runtime.

## What differs from the web build

| | Web | Android |
|---|---|---|
| Radio | tabs, WebRTC | **BLE, dual-role** |
| Storage | Dexie / IndexedDB | expo-sqlite, same two tiers |
| Replication | shared `policy.ts` | **shared `policy.ts`** |
| Identity | random per tab, unauthenticated | **Ed25519, challenge/response** |
| Document authorship | none | **signed on upload, verified on receipt** |
| Embeddings | MiniLM via transformers.js | hashing embedder + BM25 (below) |
| Relevance floor | cosine ≥ 0.42 | blended ≥ 0.40 (below) |
| Answer generation | WebLLM (WebGPU) | **llama.cpp via `llama.rn`, GGUF, CPU** |
| Topology view | SVG | plain Views + `Animated` |
| Pairing | QR / copy-paste | none needed — BLE discovers |

**The embedder is the significant one**, and it is a different problem from the
generator below. Retrieval runs on every passage as it is ingested and on every
keystroke-length query, so it has to be present, instant and free. React Native
has no Web Workers and no threaded WASM runtime, so `Xenova/all-MiniLM-L6-v2`
does not port, and every native alternative wants a model download — the one
thing a disaster-response tool cannot assume. So
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

Measured over a sample library: genuine top hits score 0.45–0.92, the best an
out-of-corpus question manages is 0.36, and a node holding a single passage
scores 0.63 for a question about it against 0.05 for one about sourdough. The
floor is 0.40.

Swapping in a real model means implementing the `Embedder` interface and nothing
else — but note that embeddings travel the wire inside `QUERY` packets, so
**every node in a mesh must use the same one**. A mesh with two different
embedders will route packets happily and return nonsense.

---

## Staying on the air

Android reclaims a process the moment its app leaves the screen and kills it
outright when the app is swiped from recents. A radio does not survive that and
cannot be resumed afterwards: links drop, the node stops advertising, and every
peer routing through it has to rebuild the mesh without it.

**KEEP THE MESH RUNNING** in the Node tab raises a foreground service
(`MeshService`, type `connectedDevice`) with a permanent notification showing
the live peer count and a Stop action. It is on by default and the tab turns it
off.

That default was the other way round first, on the reasoning that a permanent
notification and a wakelock are an imposition nobody asked for. The reasoning
was wrong for what this app is. A mesh of one node is not a mesh, and a phone
that only relays while someone is looking at it is not carrying anything — so
the setting is really a decision about *other people's* connectivity, and
leaving it off by default meant the common case was a mesh that dissolved every
time somebody pocketed their phone. Unset and explicitly-off are kept distinct
for that reason: a phone that has never been asked gets the default, a phone
that said no keeps saying no.

**It is not a native daemon, and the distinction matters.** Routing,
deduplication, replication, the catalogue and the store-and-forward outbox are
all TypeScript. A radio without them is a phone holding connections it cannot
answer on. So the service's job is to keep the *process* alive, and with it the
JavaScript that is actually the mesh.

Keeping the process is not the same as keeping it working, and the first version
of this only did the first. React Native stops the clock when the Activity
pauses: `JavaTimerManager.onHostPause` drops the choreographer callback that
fires expired timers, and `onHostDestroy` — which is what swiping the app out of
recents reaches — leaves it dropped. Every `setTimeout` and `setInterval` in the
app simply stops being delivered. Most apps never notice. This one is nothing
*but* those intervals, so a closed app sat there advertising over a radio that
had gone mute above it: peers saw the hardware, got no HELLO, and dropped the
node inside the liveness deadline. The notification claimed a mesh nobody could
see.

The one exception React Native makes is a headless task — `clearFrameCallback`
leaves the clock alone whenever `hasActiveTasks()` is true. So `MeshService`
extends `HeadlessJsTaskService` and starts a task
([`backgroundTask.ts`](src/mesh/backgroundTask.ts)) that does nothing except
refuse to finish, and the timers that are the mesh keep firing with the app
closed. The task key spans two languages with nothing to catch a rename, so
[a test](src/mesh/backgroundTask.test.ts) compares the two spellings.

That has a consequence in the app itself. A `MeshNode` used to be created and
destroyed by a React effect, which is right for something that only exists while
it is on screen and wrong for a radio — Android stops the surface when the
Activity is destroyed, React unmounts, and the effect's cleanup would stop the
very node the service was keeping alive. Ownership moved to
[`liveNode.ts`](src/mesh/liveNode.ts): the effect acquires a node and releases
it, and whether releasing stops it is a question about background mode rather
than about rendering. It is keyed by identity, so an Activity recreation
re-acquires the running node instead of building a second one onto the same
radio.

### Coming back from a kill

Keeping a running process running covers the app being closed. It does not cover
the app being *killed* — memory pressure, a crash, or one of the aggressive task
killers that ship on most Android phones people actually own, several of which
will take a foreground service with the swipe regardless of what the manifest
says. The process then comes back empty: no Activity, no React tree, no node.

So `MeshService` is `START_STICKY`, and it re-arms itself from `onTaskRemoved`
with an alarm three seconds out — set while there is still something alive to
set it, because a killed process cannot schedule its own recovery. If the
process survived, the alarm reaches a service that is already up and costs a
redrawn notification; if it did not, the alarm is what brings the mesh back.
(Inexact, deliberately: exact alarms need `SCHEDULE_EXACT_ALARM`, which Play
restricts to alarm clocks and calendars.)

Stickiness used to be the wrong answer, and the thing that changed is
[`daemon.ts`](src/mesh/daemon.ts). The old service had no way to restart a radio
— the node id lived in JavaScript — so a restarted service would have been a
notification with nothing behind it, claiming a mesh that was not there. But
everything needed is already on disk: the identity is a keypair in SQLite, the
preference is a row beside it, and the catalog is the database itself. So
`startDaemon` rebuilds the node from storage with no user and no screen, and the
native side never has to remember a node id or keep it in sync. A restarted
service is now just the daemon doing its job.

One consequence worth naming: the catalog can now be opened from two places —
the daemon with no UI, and the screen when someone finally launches the app.
`LocalCatalog.open` is memoised for that reason. Two instances is not a slow
path but a wrong one, since each holds its own vector matrix and lexical index
over the same file, and the node keeps whichever it was built with.

Two limits remain. On Android 13+ the notification needs consent; refused, the
service still runs and the disclosure is what disappears. And none of this
survives a reboot — there is no `BOOT_COMPLETED` receiver, so a phone that has
been restarted carries no mesh until someone opens the app once.

## Testing the radio

The Kotlin in `modules/ble-mesh` is mostly untestable off-device — a GATT stack
is the thing being driven — with one exception that earns its keep. `MeshWire.kt`
is pure: segment arithmetic, splitting, reassembly, no Android in it. That runs
on the JVM:

```bash
cd android && ./gradlew :ble-mesh:testDebugUnitTest
```

Everything else about the radio is verified by two phones and a log, and the
teardown reasons are written to name the layer at fault — `congested for 6s`,
`silent for Ns`, `stack rejected a NNNB segment outright`, or a raw `status N`
straight from the stack.

## Testing

Everything that does not need a radio or a real SQLite runs under this
project's own Vitest — the protocol, the mesh, the replication loop, the
identity layer and the storage helpers:

```bash
npm test
```

156 tests. Alongside the packet round-trips, framing, routing invariants and
replication policy in `src/core`, this build covers:

- a three-node simulated mesh where a passage held only two hops away comes back
  correctly attributed;
- a node answering from metadata it holds no body for, and the fetch being
  routed to a node that does hold it;
- a node shedding every body but keeping its metadata when its budget shrinks —
  and refusing to shed the last live copy when there is nowhere else;
- an upload replicating to a peer by policy, and reaching a peer that joined
  after the upload happened;
- an upload being *read* on a node that only ever heard its metadata, which is a
  second packet exchange against a second tier and was previously untested — the
  existing coverage stopped at "the peer learned the passage exists";
- a catalog sync whose request is lost on the radio, recovering without waiting
  for the once-a-minute re-announcement walk to come round;
- authorship: a signature stapled to somebody else's author id, a relay that
  edits the title, the filename or the content hash, a character moved across a
  field boundary, and half an attestation — each rejected, and an absent
  signature called unsigned rather than forged;
- a hostile peer on the wire re-announcing a real signature over an edited
  document, and the receiving node storing it as forged with the key discarded;
- a `docs` table created before the authorship columns existed, upgraded and
  still readable — the upgrade path a fresh test database cannot exercise;
- the context window: passages dropped from the back rather than cut in half,
  one over-long passage kept rather than sending none, and the assembled prompt
  measured against the window it claims to respect — because overflowing it
  drops the system prompt, which is the only thing keeping a small model on the
  passages;
- a budget on how many GATT segments one metadata packet may need. The transport
  reports a 4 KB MTU, which is true of the interface and not of the link: the
  radio cuts every packet into 514-byte segments that must all arrive or the
  message is discarded whole, and nothing retransmits. Segments per packet is
  therefore a reliability number, and it is invisible from every layer anyone
  would think to review;
- the real SQLite catalog on both ends of a replication. Every other test here
  runs the protocol against `MemoryCatalog`, so `LocalCatalog` — the storage
  layer that actually ships — had never been on either side of one. It runs
  against `node:sqlite` through a shim in `src/storage/__testshim__`, so the
  DDL, the migration and all 41 raw queries are the real ones;
- the relevance floor returning nothing for an out-of-corpus question;
- identity: key derivation, signature verification, id-to-key binding, replayed
  and unsolicited responses, key-change detection, and the rule that in-person
  trust is only ever granted on top of a proven key;
- airtime: a budget on steady-state gossip, and a check that a brand-new link
  carries beacons before it carries anything large;
- render rate: a budget on how often the node may ask React to redraw, because
  every event it emits is a `setState` and the map tab animates while they
  arrive;
- transaction serialization, including a test that reproduces the corruption
  that happens without it — `withTransactionAsync` rolls back a *concurrent*
  caller's uncommitted work, so two overlapping writes lose both.

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
- **Background mode is opt-in.** Left off, Android suspends the radio when the
  app is backgrounded and kills it when the app is swiped away. Turn on **KEEP
  THE MESH RUNNING** in the Node tab, or keep the screen on for a demo.
- **Two copies of the protocol.** `src/core` is this project's own copy of the
  radio-agnostic modules the web build also has. The codec tests travel with it,
  so a divergence fails the build rather than reaching two devices — but keeping
  the two in step is now a deliberate act rather than a guarantee of the file
  layout.
- **A few kB/s per link.** BLE is slow, and the mesh's own overhead has to fit
  inside that alongside real traffic. Holder claims and popularity shares are
  refreshed with a compact `HOLDERS` packet (~21 bytes a chunk) rather than by
  re-sending the `ANNOUNCE` that carried them (~660 bytes a chunk, almost all of
  it an embedding and a snippet that never change). Steady-state gossip is about
  320 B/s; `src/mesh/airtime.test.ts` fails the build if it climbs past 400.
  This is not a micro-optimisation — at ~1.8 kB/s the beacons queue behind the
  metadata, miss the peer-liveness deadline, and the app reports zero peers over
  links that are perfectly healthy.
  The collection window is six seconds for the same reason, and large documents
  take visible time to move.
- **A small mesh converges to holding everything.** The replica target is at
  least two and rises with unreliability, so on two or three phones every node
  ends up ranking for every chunk. That is the policy working, not failing — a
  three-node mesh genuinely cannot afford to hold fewer copies. The storage
  budget is the control that recreates the asymmetry on demand.
- **The web build does not answer identity challenges.** It has no keypair, so a
  browser node on a mixed mesh stays `unverified` to every phone. It routes and
  replicates normally; it just cannot prove which node it is.
- **Identity keys are not in the Keystore.** See the note above. Treat them as
  demo credentials.
