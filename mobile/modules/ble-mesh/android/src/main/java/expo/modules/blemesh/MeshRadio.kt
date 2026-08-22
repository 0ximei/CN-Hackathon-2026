package expo.modules.blemesh

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.ParcelUuid
import java.util.concurrent.ConcurrentHashMap

/**
 * A BLE node that is a peripheral and a central at the same time.
 *
 * This is the whole reason the app is native. A browser implements the GATT
 * central role only — it can connect to a peripheral but cannot be one — so two
 * phones running the web version can never see each other over Bluetooth; both
 * sit there scanning for a peripheral that does not exist. Android exposes
 * `BluetoothLeAdvertiser` and `BluetoothGattServer`, so every node here can
 * advertise, accept connections, scan, and dial out, all concurrently. That
 * symmetry is what turns a star of client/server links into a mesh.
 *
 * Four things make the difference between a demo that works on a bench and one
 * that works in a room, and all four are implemented below:
 *
 *  1. **Exactly one link per pair.** Both ends discover each other, so both
 *     would dial. The lower node id owns the central role; the higher one
 *     waits. See [considerPeer].
 *  2. **Flow control.** `writeCharacteristic` and `notifyCharacteristicChanged`
 *     fail while the stack is congested and silently drop what you handed them.
 *     Every link has a queue drained by the completion callback, never faster.
 *     See [drain].
 *  3. **Segmentation against the negotiated MTU**, not a guess. See [Segmenter].
 *  4. **A single serialised thread.** The Android BLE stack is not re-entrant
 *     and misbehaves badly when driven from several threads. Every mutation
 *     here happens on [handler].
 */
@SuppressLint("MissingPermission")
class MeshRadio(
  private val context: Context,
  private val selfId: Int,
  private val events: RadioEvents,
) {

  /** The identity this radio is advertising, so the bridge can spot a change. */
  val nodeId: Int get() = selfId

  interface RadioEvents {
    fun onFrame(peerId: String, payload: ByteArray)
    fun onPeers(peers: List<PeerSnapshot>)
    fun onLog(message: String)
    fun onState(state: String, detail: String)
  }

  data class PeerSnapshot(
    val peerId: String,
    val nodeId: Int,
    val role: String,
    val mtu: Int,
    val rssi: Int,
  )

  private enum class Role { CENTRAL, PERIPHERAL }

  private inner class Link(val device: BluetoothDevice, val role: Role) {
    var gatt: BluetoothGatt? = null
    var remoteRx: BluetoothGattCharacteristic? = null
    var nodeId: Int = 0
    var mtu: Int = MeshWire.MIN_MTU
    /** Notifications are flowing; we may send. */
    var ready = false
    /** The peer told us its node id, so it can be addressed. */
    var identified = false
    var rssi: Int = 0
    /**
     * Who we believed we were dialling, before a HELLO proved it. Only a
     * CENTRAL link has one, and it is what a failed dial is booked against.
     */
    var expectedNode: Int = 0
    /** The stack reported this link connected, so `disconnect` is meaningful. */
    var connected = false
    /** Dialled with autoConnect: slower to arrive, and allowed to take longer. */
    var background = false
    /** This dial is why the scan is paused, and must hand it back exactly once. */
    var holdsScan = false
    var retries = 0
    /** Consecutive over-the-air write failures reported by the async GATT callback. */
    var writeFailures = 0
    val openedAt: Long = System.currentTimeMillis()
    val outbox = ArrayDeque<ByteArray>()
    var busy = false
    val reassembler = Reassembler()
    val key: String get() = linkKey(device.address, role)
  }

  private val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
  private val adapter: BluetoothAdapter? get() = manager.adapter

  /**
   * Whether the node id fits in the primary advertisement on this device. Set
   * false only if the stack rejects the packet; see [advertiseCallback].
   */
  private var advertiseIdInPrimary = true

  private var advertiser: BluetoothLeAdvertiser? = null
  private var scanner: BluetoothLeScanner? = null
  private var gattServer: BluetoothGattServer? = null
  private var txCharacteristic: BluetoothGattCharacteristic? = null

  private var thread: HandlerThread? = null
  private var handler: Handler? = null

  /**
   * `connectGatt` is issued from here and nowhere else.
   *
   * The stack binds part of its client-callback plumbing to the looper of the
   * calling thread, and a connection opened from an arbitrary background thread
   * is a well-worn source of status 133 — sometimes immediately, sometimes only
   * once a second link is in play. Everything *after* the connection is opened
   * still runs on the radio thread; only the call itself moves.
   */
  private val mainHandler = Handler(Looper.getMainLooper())

  private var running = false

  /**
   * Concurrent because `send`, `broadcast` and `peers` are called straight from
   * the JS thread while every mutation happens on the radio thread. Mutating
   * operations still post; this only makes the reads safe.
   */
  private val links = ConcurrentHashMap<String, Link>()

  /**
   * Peers we have seen but deliberately have not dialled, because their node id
   * is below ours and the convention says they dial us. The timestamp is the
   * escape hatch: if the call never comes, we place it ourselves.
   */
  private val awaitingInbound = HashMap<Int, Long>()
  private val dialling = HashSet<String>()

  /**
   * Node id -> the earliest time we may dial it again, and how many attempts in
   * a row have come to nothing. Both are cleared the moment a link to that node
   * identifies, so a peer that works is never penalised for an earlier miss.
   */
  private val dialBackoff = HashMap<Int, Long>()
  private val dialFailures = HashMap<Int, Int>()

  private companion object {
    const val MAX_CENTRAL_LINKS = 4
    const val INBOUND_GRACE_MS = 9_000L
    const val TICK_MS = 3_000L
    const val SCAN_REFRESH_MS = 240_000L
    const val DRAIN_RETRY_MS = 25L
    const val MAX_DRAIN_RETRIES = 40
    /**
     * A write the stack accepted but the async callback then reports as failed —
     * distinct from `MAX_DRAIN_RETRIES`, which counts the stack refusing to
     * accept a write in the first place. A handful of consecutive async
     * failures means the link is dead under us; tear it down so scanning and
     * dialling can replace it, instead of silently failing forever.
     */
    const val MAX_WRITE_FAILURES = 3
    const val PREFERRED_MTU = 517

    /**
     * How long a dialled link may take to become usable.
     *
     * Android's GATT client does not always call back. A connection that fails
     * with status 133 sometimes reports nothing at all, and the half-open link
     * left behind holds one of the four outbound slots and blocks that peer
     * from ever being retried — the mesh quietly shrinks. Sweeping is the only
     * way to notice.
     */
    const val CONNECT_TIMEOUT_MS = 15_000L

    /**
     * How long to leave a node alone after a dial to it failed.
     *
     * Android's GATT client takes roughly one connection attempt at a time and
     * punishes a caller that retries in a tight loop: the follow-up attempts
     * fail with status 133, and the client interfaces they hold are not always
     * given back. Scan results arrive several times a second, so a dial path
     * with no backoff turns one failed connection into an unbounded redial
     * storm — a log full of `dialling ...` and a mesh that never links.
     *
     * The wait doubles per consecutive failure. A peer that is simply out of
     * range costs one attempt a minute instead of thousands, and a peer that
     * comes back is dialled promptly because a successful identify clears it.
     */
    const val DIAL_BACKOFF_MS = 3_000L
    const val MAX_DIAL_BACKOFF_MS = 60_000L
    const val MAX_BACKOFF_DOUBLINGS = 5
    const val FACELESS_LOG_MS = 30_000L

    /**
     * Direct attempts before handing the peer to `autoConnect`. Two, because a
     * direct connect that is going to work usually works first time, and the
     * second only covers a peer that was briefly busy.
     */
    const val DIRECT_DIAL_ATTEMPTS = 2

    /** A background connect waits for the device, so it gets a longer leash. */
    const val BACKGROUND_CONNECT_TIMEOUT_MS = 45_000L

    /** Android's limit is five starts per thirty seconds; stay under it. */
    const val SCAN_QUOTA = 4
    const val SCAN_QUOTA_WINDOW_MS = 30_000L
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  fun start(): String? {
    if (running) return null
    val a = adapter ?: return "This device has no Bluetooth adapter"
    if (!a.isEnabled) return "Bluetooth is turned off"
    if (a.bluetoothLeAdvertiser == null) {
      return "This device cannot advertise over BLE, so other nodes can never see it"
    }

    val t = HandlerThread("meshnet-ble").also { it.start() }
    thread = t
    handler = Handler(t.looper)
    running = true

    post {
      openGattServer()
      startAdvertising()
      startScanning()
      scheduleTick()
      scheduleScanRefresh()
    }
    return null
  }

  fun stop() {
    if (!running) return
    running = false
    val h = handler ?: return
    mainHandler.removeCallbacksAndMessages(null)
    h.post {
      h.removeCallbacksAndMessages(null)
      stopAdvertising()
      stopScanning()
      for (link in links.values.toList()) teardown(link, "shutdown")
      links.clear()
      awaitingInbound.clear()
      dialling.clear()
      dialBackoff.clear()
      dialFailures.clear()
      scanStarts.clear()
      scanRestartPending = false
      try {
        gattServer?.close()
      } catch (e: Exception) {
        log("gatt server close failed: ${e.message}")
      }
      gattServer = null
      txCharacteristic = null
      thread?.quitSafely()
      thread = null
      handler = null
      events.onPeers(emptyList())
      events.onState("stopped", "")
    }
  }

  /* ------------------------------------------------------------------ */
  /* Public send API                                                     */
  /* ------------------------------------------------------------------ */

  /** @return false if no open link to that peer exists right now. */
  fun send(peerId: String, payload: ByteArray): Boolean {
    val link = links.values.firstOrNull { it.identified && it.ready && peerIdOf(it.nodeId) == peerId }
      ?: return false
    post { enqueue(link, MeshWire.KIND_FRAME, payload) }
    return true
  }

  /** @return how many links the frame was queued on. */
  fun broadcast(payload: ByteArray, except: String?): Int {
    val targets = links.values.filter {
      it.identified && it.ready && (except == null || peerIdOf(it.nodeId) != except)
    }
    if (targets.isEmpty()) return 0
    post { for (link in targets) enqueue(link, MeshWire.KIND_FRAME, payload) }
    return targets.size
  }

  fun peers(): List<PeerSnapshot> = links.values
    .filter { it.identified && it.ready }
    .map { PeerSnapshot(peerIdOf(it.nodeId), it.nodeId, it.role.name.lowercase(), it.mtu, it.rssi) }

  /* ------------------------------------------------------------------ */
  /* Advertising — the half a browser cannot do                          */
  /* ------------------------------------------------------------------ */

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
      log("advertising as ${peerIdOf(selfId)}")
      events.onState("advertising", peerIdOf(selfId))
    }

    override fun onStartFailure(errorCode: Int) {
      // A node that cannot advertise cannot be found at all, so the one failure
      // worth recovering from automatically is the one we might have caused:
      // some stacks count the 31 bytes differently than the arithmetic above.
      // Drop back to a bare service UUID and let the scan response carry the id.
      if (errorCode == AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE && advertiseIdInPrimary) {
        advertiseIdInPrimary = false
        log("advertisement too large with the node id in it, falling back")
        post {
          stopAdvertising()
          startAdvertising()
        }
        return
      }
      val reason = when (errorCode) {
        AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED -> "already started"
        AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE -> "advertisement payload too large"
        AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "peripheral role unsupported on this device"
        AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR -> "internal stack error"
        AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "too many advertisers"
        else -> "code $errorCode"
      }
      log("advertising failed: $reason")
      events.onState("advertise-failed", reason)
    }
  }

  private fun startAdvertising() {
    val adv = adapter?.bluetoothLeAdvertiser ?: return
    advertiser = adv

    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      .setConnectable(true)
      .setTimeout(0)
      .build()

    // The 31-byte budget: flags 3, a 128-bit service UUID 18, four bytes of node
    // id with its header 8 — 29, with two to spare.
    //
    // The id used to live in the scan response alone, on the reasoning that an
    // active scanner always asks for one. It does, but the two reports are
    // separate radio events and whether the stack merges them before handing
    // over a ScanResult is up to the stack; several OEM builds deliver the
    // advertisement by itself. [considerPeer] cannot act on a peer whose id it
    // cannot read, so a node whose scan response never arrives is invisible to
    // half the room. It goes in the packet that always arrives, and is repeated
    // in the scan response, which is free.
    val payload = advertisement(withId = advertiseIdInPrimary)

    val scanResponse = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .addManufacturerData(MeshWire.MANUFACTURER_ID, idBytes(selfId))
      .build()

    try {
      adv.startAdvertising(settings, payload, scanResponse, advertiseCallback)
    } catch (e: Exception) {
      log("startAdvertising threw: ${e.message}")
    }
  }

  private fun advertisement(withId: Boolean): AdvertiseData {
    val builder = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .addServiceUuid(ParcelUuid(MeshWire.SERVICE))
    if (withId) builder.addManufacturerData(MeshWire.MANUFACTURER_ID, idBytes(selfId))
    return builder.build()
  }

  private fun stopAdvertising() {
    try {
      advertiser?.stopAdvertising(advertiseCallback)
    } catch (e: Exception) {
      log("stopAdvertising threw: ${e.message}")
    }
    advertiser = null
  }

  /* ------------------------------------------------------------------ */
  /* GATT server — accepting inbound links                               */
  /* ------------------------------------------------------------------ */

  private fun openGattServer() {
    val server = try {
      manager.openGattServer(context, serverCallback)
    } catch (e: Exception) {
      log("openGattServer threw: ${e.message}")
      null
    }
    if (server == null) {
      events.onState("error", "could not open a GATT server")
      return
    }
    gattServer = server

    val service = BluetoothGattService(MeshWire.SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY)

    val rx = BluetoothGattCharacteristic(
      MeshWire.RX,
      BluetoothGattCharacteristic.PROPERTY_WRITE or
        BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
      // Deliberately not PERMISSION_WRITE_ENCRYPTED: requiring encryption would
      // force pairing, and a mesh whose nodes must be paired by hand before they
      // can route is not a mesh. The payload is a public first-aid corpus.
      BluetoothGattCharacteristic.PERMISSION_WRITE,
    )

    val tx = BluetoothGattCharacteristic(
      MeshWire.TX,
      BluetoothGattCharacteristic.PROPERTY_NOTIFY,
      BluetoothGattCharacteristic.PERMISSION_READ,
    )
    tx.addDescriptor(
      BluetoothGattDescriptor(
        MeshWire.CCCD,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
      ),
    )

    service.addCharacteristic(rx)
    service.addCharacteristic(tx)
    txCharacteristic = tx
    server.addService(service)
  }

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      post {
        if (newState == BluetoothProfile.STATE_CONNECTED) {
          if (links[linkKey(device.address, Role.PERIPHERAL)] == null) {
            links[linkKey(device.address, Role.PERIPHERAL)] = Link(device, Role.PERIPHERAL)
            log("inbound connection from ${device.address}")
          }
        } else {
          links[linkKey(device.address, Role.PERIPHERAL)]?.let { teardown(it, "remote closed") }
        }
      }
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      post {
        links[linkKey(device.address, Role.PERIPHERAL)]?.let {
          it.mtu = mtu
          log("inbound mtu ${mtu}B from ${device.address}")
        }
      }
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray,
    ) {
      post {
        if (responseNeeded) {
          gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
        }
        if (characteristic.uuid != MeshWire.RX) return@post
        val link = links[linkKey(device.address, Role.PERIPHERAL)] ?: return@post
        receive(link, value)
      }
    }

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray,
    ) {
      post {
        if (responseNeeded) {
          gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
        }
        if (descriptor.uuid != MeshWire.CCCD) return@post
        val link = links[linkKey(device.address, Role.PERIPHERAL)] ?: return@post
        val enabling = value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
        if (!enabling) {
          teardown(link, "peer unsubscribed")
          return@post
        }
        // Only now can this half of the link carry anything.
        link.ready = true
        enqueue(link, MeshWire.KIND_HELLO, idBytes(selfId))
      }
    }

    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
      post {
        val link = links[linkKey(device.address, Role.PERIPHERAL)] ?: return@post
        link.busy = false
        if (status != BluetoothGatt.GATT_SUCCESS) log("notify failed: status $status")
        drain(link)
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Scanning and dialling — the central half                            */
  /* ------------------------------------------------------------------ */

  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      post { considerPeer(result) }
    }

    override fun onBatchScanResults(results: MutableList<ScanResult>) {
      post { for (r in results) considerPeer(r) }
    }

    override fun onScanFailed(errorCode: Int) {
      log("scan failed: code $errorCode")
      events.onState("scan-failed", "code $errorCode")
    }
  }

  /**
   * Android blocks an app that calls `startScan` more than five times in thirty
   * seconds, and blocks it silently — scanning simply stops reporting results,
   * which on this app looks exactly like an empty room. Pausing the scan around
   * each dial makes that limit reachable, so starts are spaced to stay clear of
   * it and a start that would breach the quota waits for the window instead.
   */
  private val scanStarts = ArrayDeque<Long>()
  private var scanning = false
  private var scanRestartPending = false

  private fun startScanning() {
    if (!running || scanning) return
    val s = adapter?.bluetoothLeScanner ?: return

    val now = System.currentTimeMillis()
    while (scanStarts.isNotEmpty() && scanStarts.first() < now - SCAN_QUOTA_WINDOW_MS) {
      scanStarts.removeFirst()
    }
    if (scanStarts.size >= SCAN_QUOTA) {
      if (scanRestartPending) return
      scanRestartPending = true
      val wait = scanStarts.first() + SCAN_QUOTA_WINDOW_MS - now + 200
      handler?.postDelayed({
        scanRestartPending = false
        startScanning()
      }, wait)
      return
    }
    scanStarts.addLast(now)

    scanner = s
    val filters = listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(MeshWire.SERVICE)).build())
    val settings = ScanSettings.Builder()
      .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
      .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
      .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
      .setNumOfMatches(ScanSettings.MATCH_NUM_MAX_ADVERTISEMENT)
      .setReportDelay(0)
      .build()
    try {
      s.startScan(filters, settings, scanCallback)
      scanning = true
      log("scanning for mesh nodes")
    } catch (e: Exception) {
      log("startScan threw: ${e.message}")
    }
  }

  private fun stopScanning() {
    if (!scanning) return
    try {
      scanner?.stopScan(scanCallback)
    } catch (e: Exception) {
      log("stopScan threw: ${e.message}")
    }
    scanner = null
    scanning = false
  }

  /**
   * Take the radio off scanning for the duration of a connection attempt.
   *
   * An LE scan running while a GATT connection is being established is the
   * single most common cause of status 133 on Android, and this one scans at
   * `SCAN_MODE_LOW_LATENCY` with aggressive matching — about as hostile to a
   * concurrent connect as the API allows. The attempt gets the radio to itself
   * and the scan comes back the moment no direct dial is outstanding.
   */
  private fun holdScanFor(link: Link) {
    link.holdsScan = true
    stopScanning()
  }

  private fun releaseScan(link: Link) {
    if (!link.holdsScan) return
    link.holdsScan = false
    if (links.values.any { it.holdsScan }) return
    startScanning()
  }

  /**
   * Decide whether to dial a node we just heard advertising.
   *
   * Both ends of every pair see each other, so "connect to whatever you find"
   * produces two links between the same two phones — double the traffic, and a
   * flood that arrives twice. The tie-break is the node id: the lower id dials,
   * the higher id waits. It needs no negotiation because both sides know both
   * ids, and it is stable across reconnects.
   *
   * The wait is not unconditional. If the lower node never calls — it may have
   * hit its connection budget, or its central role may be wedged — the higher
   * one dials after a grace period rather than sitting there forever.
   *
   * Every path out of here that does *not* dial has to be cheap, because this
   * runs on every advertisement and a phone in range produces several a second.
   */
  private fun considerPeer(result: ScanResult) {
    if (!running) return
    val record = result.scanRecord ?: return
    val idData = record.getManufacturerSpecificData(MeshWire.MANUFACTURER_ID)
    if (idData == null || idData.size < 4) {
      // It answers to the mesh service UUID but carries no node id, so the
      // tie-break cannot be evaluated and it has to be skipped. Worth saying
      // out loud once in a while: this is what an unreadable scan response
      // looks like from this side, and it is otherwise completely silent.
      noteFaceless(result.device.address)
      return
    }
    val peerNode = readId(idData)
    if (peerNode == 0 || peerNode == selfId) return

    links.values.firstOrNull { it.identified && it.nodeId == peerNode }?.let {
      it.rssi = result.rssi
      return
    }

    val address = result.device.address
    if (dialling.contains(address)) return
    if (links.containsKey(linkKey(address, Role.CENTRAL))) return
    // An inbound connection from this address is this peer arriving under its
    // own steam, mid-handshake and not yet identified. Dialling it as well only
    // manufactures a duplicate for `identify` to close again, at the cost of a
    // connection attempt the adapter would rather spend elsewhere.
    if (links.containsKey(linkKey(address, Role.PERIPHERAL))) return
    // Our own dial to this node, in flight under a different address: BLE
    // addresses rotate, so `dialling` alone does not catch it.
    if (links.values.any { !it.identified && it.expectedNode == peerNode }) return

    val now = System.currentTimeMillis()
    dialBackoff[peerNode]?.let { if (now < it) return }

    val weDial = Integer.compareUnsigned(selfId, peerNode) < 0
    if (!weDial) {
      val since = awaitingInbound.getOrPut(peerNode) { now }
      if (now - since < INBOUND_GRACE_MS) return
    }

    val centralLinks = links.values.count { it.role == Role.CENTRAL }
    if (centralLinks >= MAX_CENTRAL_LINKS) return

    // Re-arm the grace period before dialling, not after it resolves. Whether
    // this attempt succeeds or fails, the next decision about this peer should
    // start its own wait — otherwise a lapsed grace stays lapsed and the escape
    // hatch fires again on the very next advertisement.
    awaitingInbound[peerNode] = now
    if (!weDial) log("${peerIdOf(peerNode)} never dialled us, dialling it instead")

    dial(result.device, peerNode, result.rssi)
  }

  /** Throttled: a faceless node is reported by one advertisement in hundreds. */
  private var facelessLoggedAt = 0L

  private fun noteFaceless(address: String) {
    val now = System.currentTimeMillis()
    if (now - facelessLoggedAt < FACELESS_LOG_MS) return
    facelessLoggedAt = now
    log("$address advertises the mesh service but no node id — older build?")
  }

  /**
   * Open a connection, doing the three things the Android stack insists on.
   *
   * A direct `connectGatt` is fast and usually right, and when it is not it
   * fails as status 133 — a generic error the stack returns for most of its
   * internal refusals. Three of its causes are ours to avoid:
   *
   *  - a concurrent LE scan, so the scan is paused for the attempt;
   *  - a call from a thread other than the main looper, so the call is posted
   *    there while everything around it stays on the radio thread;
   *  - a direct connection to a device that is not there right now, which is
   *    what `autoConnect` exists for. Direct attempts are tried first because
   *    they are seconds rather than tens of seconds; after a couple of failures
   *    the peer is clearly not answering a direct call and the attempt is handed
   *    to the stack's background connector, which waits for the device instead
   *    of insisting on it.
   */
  private fun dial(device: BluetoothDevice, expectedNode: Int, rssi: Int) {
    dialling.add(device.address)
    val link = Link(device, Role.CENTRAL)
    link.rssi = rssi
    link.expectedNode = expectedNode
    link.background = (dialFailures[expectedNode] ?: 0) >= DIRECT_DIAL_ATTEMPTS
    links[link.key] = link

    log(
      "dialling ${peerIdOf(expectedNode)} at ${device.address}" +
        if (link.background) " (background)" else "",
    )

    // A background connect may sit for a long time by design, and holding the
    // scan down for it would blind this node for as long as it waits.
    if (!link.background) holdScanFor(link)

    mainHandler.post {
      // TRANSPORT_LE keeps the stack from guessing BR/EDR, which is its own
      // route to 133 on a dual-mode phone.
      val gatt = try {
        device.connectGatt(context, link.background, clientCallback, BluetoothDevice.TRANSPORT_LE)
      } catch (e: Exception) {
        null
      }
      val radio = handler
      if (radio == null) {
        // Stopped while the call was crossing threads. Nothing will run on the
        // radio thread again, so the handle has to be released here.
        runCatching { gatt?.close() }
        return@post
      }
      radio.post {
        if (links[link.key] !== link) {
          // Torn down while the call was crossing threads; the handle it
          // returned is still ours to close.
          runCatching { gatt?.close() }
          return@post
        }
        link.gatt = gatt
        if (gatt == null) teardown(link, "connectGatt refused")
      }
    }
  }

  private val clientCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      post {
        val link = links[linkKey(gatt.device.address, Role.CENTRAL)]
        if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
          link?.connected = true
          // MTU first, then discovery: asking afterwards makes some stacks keep
          // serving the 23-byte default to already-discovered characteristics.
          gatt.requestMtu(PREFERRED_MTU)
        } else {
          dialling.remove(gatt.device.address)
          if (link != null) teardown(link, "disconnected (status $status)")
          else runCatching { gatt.close() }
        }
      }
    }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      post {
        links[linkKey(gatt.device.address, Role.CENTRAL)]?.mtu =
          if (status == BluetoothGatt.GATT_SUCCESS) mtu else MeshWire.MIN_MTU
        log("outbound mtu ${mtu}B to ${gatt.device.address}")
        gatt.discoverServices()
      }
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      post {
        val link = links[linkKey(gatt.device.address, Role.CENTRAL)] ?: return@post
        val service = gatt.getService(MeshWire.SERVICE)
        if (service == null) {
          teardown(link, "peer exposes no mesh service")
          return@post
        }
        link.remoteRx = service.getCharacteristic(MeshWire.RX)
        val remoteTx = service.getCharacteristic(MeshWire.TX)
        if (link.remoteRx == null || remoteTx == null) {
          teardown(link, "mesh service is missing a characteristic")
          return@post
        }
        gatt.setCharacteristicNotification(remoteTx, true)
        val cccd = remoteTx.getDescriptor(MeshWire.CCCD)
        if (cccd == null) {
          teardown(link, "peer TX has no CCCD")
          return@post
        }
        writeDescriptor(gatt, cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
      }
    }

    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      post {
        val link = links[linkKey(gatt.device.address, Role.CENTRAL)] ?: return@post
        if (status != BluetoothGatt.GATT_SUCCESS) {
          teardown(link, "could not subscribe (status $status)")
          return@post
        }
        dialling.remove(gatt.device.address)
        link.ready = true
        // The connection is established; scanning is safe again.
        releaseScan(link)
        enqueue(link, MeshWire.KIND_HELLO, idBytes(selfId))
      }
    }

    override fun onCharacteristicWrite(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int,
    ) {
      post {
        val link = links[linkKey(gatt.device.address, Role.CENTRAL)] ?: return@post
        link.busy = false
        if (status != BluetoothGatt.GATT_SUCCESS) {
          log("write failed: status $status")
          if (++link.writeFailures >= MAX_WRITE_FAILURES) {
            teardown(link, "${link.writeFailures} consecutive write failures (status $status)")
            return@post
          }
        } else {
          link.writeFailures = 0
        }
        drain(link)
      }
    }

    @Deprecated("Superseded by the value-carrying overload on API 33")
    @Suppress("DEPRECATION")
    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      val value = characteristic.value ?: return
      val copy = value.copyOf()
      post {
        links[linkKey(gatt.device.address, Role.CENTRAL)]?.let { receive(it, copy) }
      }
    }

    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
    ) {
      post {
        links[linkKey(gatt.device.address, Role.CENTRAL)]?.let { receive(it, value) }
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun writeDescriptor(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, value: ByteArray) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      gatt.writeDescriptor(descriptor, value)
    } else {
      descriptor.setValue(value)
      gatt.writeDescriptor(descriptor)
    }
  }

  /* ------------------------------------------------------------------ */
  /* Message plumbing                                                    */
  /* ------------------------------------------------------------------ */

  private fun enqueue(link: Link, kind: Byte, body: ByteArray) {
    val message = ByteArray(1 + body.size)
    message[0] = kind
    System.arraycopy(body, 0, message, 1, body.size)
    link.outbox.addAll(Segmenter.split(message, link.mtu))
    drain(link)
  }

  /**
   * Hand one segment to the stack, and only one.
   *
   * Both `writeCharacteristic` and `notifyCharacteristicChanged` are fire-and-
   * forget from the caller's point of view but fail while the connection is
   * congested — the classic Android BLE bug is to loop over your data calling
   * them, watch every call return, and lose most of the payload. The next
   * segment goes out from the completion callback, never before it.
   */
  private fun drain(link: Link) {
    if (link.busy || !link.ready) return
    val segment = link.outbox.removeFirstOrNull() ?: return
    link.busy = true

    val accepted = when (link.role) {
      Role.CENTRAL -> writeSegment(link, segment)
      Role.PERIPHERAL -> notifySegment(link, segment)
    }

    if (accepted) {
      link.retries = 0
      return
    }

    // Stack refused it. Put it back and try again shortly rather than dropping.
    link.busy = false
    link.outbox.addFirst(segment)
    if (++link.retries > MAX_DRAIN_RETRIES) {
      teardown(link, "congested, gave up after ${link.retries} retries")
      return
    }
    handler?.postDelayed({ drain(link) }, DRAIN_RETRY_MS)
  }

  @Suppress("DEPRECATION")
  private fun writeSegment(link: Link, segment: ByteArray): Boolean {
    val gatt = link.gatt ?: return false
    val characteristic = link.remoteRx ?: return false
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        gatt.writeCharacteristic(
          characteristic,
          segment,
          BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT,
        ) == BluetoothStatusCodes.SUCCESS
      } else {
        characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        // setValue, not `.value =`: it returns boolean, so Kotlin synthesises no
        // settable property for it.
        characteristic.setValue(segment)
        gatt.writeCharacteristic(characteristic)
      }
    } catch (e: Exception) {
      log("write threw: ${e.message}")
      false
    }
  }

  @Suppress("DEPRECATION")
  private fun notifySegment(link: Link, segment: ByteArray): Boolean {
    val server = gattServer ?: return false
    val characteristic = txCharacteristic ?: return false
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        server.notifyCharacteristicChanged(link.device, characteristic, false, segment) ==
          BluetoothStatusCodes.SUCCESS
      } else {
        // Pre-33 the value is read off the shared characteristic object. Safe
        // only because every drain runs on the one radio thread and the notify
        // call reads it synchronously.
        characteristic.setValue(segment)
        server.notifyCharacteristicChanged(link.device, characteristic, false)
      }
    } catch (e: Exception) {
      log("notify threw: ${e.message}")
      false
    }
  }

  private fun receive(link: Link, segment: ByteArray) {
    val message = link.reassembler.push(segment) { log("${describe(link)}: $it") } ?: return
    if (message.isEmpty()) return
    when (message[0]) {
      MeshWire.KIND_HELLO -> {
        if (message.size < 5) return
        identify(link, readId(message, 1))
      }
      MeshWire.KIND_FRAME -> {
        if (!link.identified) {
          log("${describe(link)}: frame before hello, dropped")
          return
        }
        events.onFrame(peerIdOf(link.nodeId), message.copyOfRange(1, message.size))
      }
      else -> log("${describe(link)}: unknown message kind ${message[0]}")
    }
  }

  /**
   * Bind a node id to a link, and resolve the race if we ended up with two.
   *
   * Both ends run the same rule — the lower id keeps the central role — so both
   * pick the same survivor and the loser is closed once, not twice.
   */
  private fun identify(link: Link, nodeId: Int) {
    if (nodeId == 0 || nodeId == selfId) {
      teardown(link, "peer reported an unusable node id")
      return
    }
    link.nodeId = nodeId
    link.identified = true
    awaitingInbound.remove(nodeId)
    // The peer works. Anything held against it from an earlier failure is stale.
    dialFailures.remove(nodeId)
    dialBackoff.remove(nodeId)

    val duplicate = links.values.firstOrNull {
      it !== link && it.identified && it.nodeId == nodeId
    }
    if (duplicate != null) {
      val keep = if (Integer.compareUnsigned(selfId, nodeId) < 0) Role.CENTRAL else Role.PERIPHERAL
      val loser = if (link.role == keep) duplicate else link
      log("two links to ${peerIdOf(nodeId)}, closing the ${loser.role.name.lowercase()} one")
      teardown(loser, "duplicate link")
      if (loser === link) return
    }

    log("linked to ${peerIdOf(nodeId)} as ${link.role.name.lowercase()}, mtu ${link.mtu}B")
    emitPeers()
  }

  private fun teardown(link: Link, reason: String) {
    links.remove(link.key)
    dialling.remove(link.device.address)
    link.outbox.clear()
    link.reassembler.reset()
    link.ready = false
    try {
      when (link.role) {
        // `close` always, `disconnect` only if there is a connection to drop:
        // disconnecting a handle that never connected leaves the stack holding
        // a client interface, and it has a finite number of those. Running out
        // is one of the ways a phone starts answering every dial with 133 and
        // keeps doing it until the app is restarted.
        Role.CENTRAL -> link.gatt?.let {
          if (link.connected) it.disconnect()
          it.close()
        }
        Role.PERIPHERAL -> gattServer?.cancelConnection(link.device)
      }
    } catch (e: Exception) {
      log("teardown threw: ${e.message}")
    }
    link.gatt = null
    link.connected = false
    releaseScan(link)
    if (link.identified) log("lost ${peerIdOf(link.nodeId)}: $reason") else noteDialFailure(link, reason)
    emitPeers()
  }

  /**
   * A dial that never reached an identified link, held against the node so the
   * next attempt waits. Only outbound links count: an inbound connection that
   * dies is the peer's attempt to spend, not ours.
   */
  private fun noteDialFailure(link: Link, reason: String) {
    if (link.role != Role.CENTRAL) return
    val node = link.expectedNode
    if (node == 0 || !running) return
    val failures = (dialFailures[node] ?: 0) + 1
    dialFailures[node] = failures
    val wait = minOf(
      DIAL_BACKOFF_MS shl minOf(failures - 1, MAX_BACKOFF_DOUBLINGS),
      MAX_DIAL_BACKOFF_MS,
    )
    dialBackoff[node] = System.currentTimeMillis() + wait
    log("dial to ${peerIdOf(node)} failed ($reason), attempt $failures, waiting ${wait / 1000}s")
  }

  /* ------------------------------------------------------------------ */
  /* Housekeeping                                                        */
  /* ------------------------------------------------------------------ */

  private fun scheduleTick() {
    handler?.postDelayed({
      if (!running) return@postDelayed
      // Peers whose grace period lapsed get reconsidered on the next
      // advertisement; expiring the record is what lets that happen.
      val now = System.currentTimeMillis()
      awaitingInbound.entries.removeAll { it.value < now - INBOUND_GRACE_MS * 3 }
      // A node out of range for a good while is not a node in penalty; forget
      // its record so it is dialled promptly when it comes back, and so neither
      // map grows for the life of the session.
      dialBackoff.entries.removeAll { it.value < now - MAX_DIAL_BACKOFF_MS * 2 }
      dialFailures.keys.removeAll { !dialBackoff.containsKey(it) }
      for (link in links.values.toList()) {
        val budget = if (link.background) BACKGROUND_CONNECT_TIMEOUT_MS else CONNECT_TIMEOUT_MS
        if (!link.ready && now - link.openedAt > budget) {
          teardown(link, "handshake never completed")
        }
      }
      events.onState("running", "${peers().size} peer(s)")
      scheduleTick()
    }, TICK_MS)
  }

  /**
   * Android quietly degrades a long-lived scan, and several OEM stacks stop
   * reporting duplicates entirely after a few minutes. Cycling the scan is the
   * accepted workaround; the interval stays well clear of the five-starts-per-
   * thirty-seconds limit that would get the app's scans blocked outright.
   */
  private fun scheduleScanRefresh() {
    handler?.postDelayed({
      if (!running) return@postDelayed
      stopScanning()
      startScanning()
      scheduleScanRefresh()
    }, SCAN_REFRESH_MS)
  }

  private fun emitPeers() = events.onPeers(peers())

  private fun post(block: () -> Unit) {
    handler?.post {
      try {
        block()
      } catch (e: Exception) {
        log("radio task failed: ${e.message}")
      }
    }
  }

  private fun log(message: String) = events.onLog(message)

  private fun describe(link: Link) =
    if (link.identified) peerIdOf(link.nodeId) else link.device.address

  private fun linkKey(address: String, role: Role) = "$address/${role.name}"

  private fun idBytes(id: Int) = byteArrayOf(
    (id ushr 24).toByte(),
    (id ushr 16).toByte(),
    (id ushr 8).toByte(),
    id.toByte(),
  )

  private fun readId(bytes: ByteArray, offset: Int = 0): Int =
    ((bytes[offset].toInt() and 0xff) shl 24) or
      ((bytes[offset + 1].toInt() and 0xff) shl 16) or
      ((bytes[offset + 2].toInt() and 0xff) shl 8) or
      (bytes[offset + 3].toInt() and 0xff)

  private fun peerIdOf(nodeId: Int) = String.format("%08x", nodeId)
}
