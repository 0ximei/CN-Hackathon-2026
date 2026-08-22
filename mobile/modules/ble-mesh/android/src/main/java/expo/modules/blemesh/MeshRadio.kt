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
    // `send`, `broadcast` and `peers` read these straight from the JS thread
    // while the radio thread writes them. `links` being concurrent publishes
    // the Link *object*, but every one of these is assigned after it was put
    // in the map, so nothing orders them — a JS-thread reader is entitled to
    // go on seeing `ready == false` forever and quietly refuse every send.
    @Volatile var nodeId: Int = 0
    @Volatile var mtu: Int = MeshWire.MIN_MTU
    /** Notifications are flowing; we may send. */
    @Volatile var ready = false
    /** The peer told us its node id, so it can be addressed. */
    @Volatile var identified = false
    @Volatile var rssi: Int = 0
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
    /**
     * Last time anything arrived on this link.
     *
     * A GATT connection that has died without the stack noticing looks exactly
     * like an idle one, and the app layer beacons every three seconds, so
     * silence is a reliable signal here rather than a guess.
     */
    var lastHeardAt: Long = System.currentTimeMillis()
    /**
     * Last time the stack accepted or completed a segment on this link.
     *
     * [busy] is cleared by a completion callback, and Android does not always
     * deliver one. Without a deadline the link stays `ready`, stays listed as a
     * peer, and never moves another byte for the rest of the session.
     */
    var lastProgressAt: Long = System.currentTimeMillis()
    /** Last native keepalive, so the tick does not send one every three seconds. */
    var lastPingAt: Long = 0L
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

  /**
   * GATT handles we have asked to disconnect and have not closed yet, by address.
   *
   * `disconnect()` is asynchronous and `close()` is not. Closing straight after
   * disconnecting unregisters this app's client interface while the controller
   * still has the ACL up, so nothing is left to finish the teardown or to
   * report it — see [releaseGatt].
   */
  private val closing = HashMap<String, BluetoothGatt>()

  private companion object {
    const val MAX_CENTRAL_LINKS = 4
    const val INBOUND_GRACE_MS = 9_000L
    const val TICK_MS = 3_000L
    const val SCAN_REFRESH_MS = 240_000L
    const val DRAIN_RETRY_MS = 25L
    /**
     * How long the stack may keep refusing a segment before the link is given up.
     *
     * Six seconds, and it needs every one of them. Five seconds after two nodes
     * first hear each other they exchange catalogues — tens of kilobytes of
     * metadata queued into one link in a single tick, in both directions at
     * once, while both radios are also advertising and scanning. A congested
     * stack refuses writes for as long as that takes to clear.
     *
     * This was one second. The burst arrives a few seconds after the link comes
     * up, which is precisely when the link was being torn down: not by the peer
     * and not by the radio, but by this timer, for the crime of being busy.
     */
    const val MAX_DRAIN_RETRIES = 240
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

    /**
     * How long to wait for a disconnect to land before closing the handle anyway.
     *
     * The callback normally arrives in tens of milliseconds. This only covers
     * the case where it never comes at all, which must not leak the handle.
     */
    const val CLOSE_GRACE_MS = 2_000L

    /** Android's limit is five starts per thirty seconds; stay under it. */
    const val SCAN_QUOTA = 4
    const val SCAN_QUOTA_WINDOW_MS = 30_000L

    /**
     * How long a segment may sit in the stack with no completion callback.
     *
     * Generous, because a genuinely congested link can take seconds to accept
     * one write. What this catches is the callback that never comes at all.
     */
    const val WRITE_STALL_MS = 12_000L

    /**
     * Silence after which the peer is prodded, and after which it is presumed
     * gone.
     *
     * The app layer beacons every three seconds, so ten seconds of silence is
     * already three missed beacons and the link is suspect; the keepalive also
     * covers the case where JS has stopped and only the radio is still up.
     * Twenty-five seconds with nothing at all — not a beacon, not a keepalive
     * reply, not an ack — is a link the stack is holding open over a connection
     * that is gone.
     *
     * These were 20s and 50s, which is slower than the app layer's own
     * thirteen-second peer timeout. A radio insisting on a link that the layer
     * above had already written off is what "0 peers" looks like from the
     * inside.
     */
    const val LINK_IDLE_MS = 10_000L
    const val LINK_SILENCE_MS = 25_000L
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
      // `teardown` just asked for these disconnects and posted their closes to
      // a handler that is about to stop. Closing them here would strand them
      // exactly the way the old teardown did, which matters because `stop` is
      // also how the radio restarts under a new identity. Hand them to the main
      // looper, which outlives this thread, and give the disconnects the same
      // grace they would have had.
      val pending = closing.values.toList()
      closing.clear()
      if (pending.isNotEmpty()) {
        mainHandler.postDelayed({ for (gatt in pending) runCatching { gatt.close() } }, CLOSE_GRACE_MS)
      }
      awaitingInbound.clear()
      dialling.clear()
      dialBackoff.clear()
      dialFailures.clear()
      scanStarts.clear()
      scanRestartPending = false
      advertisingRelaxed = false
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

    // Same trade as the scan mode, for the same reason: every advertising event
    // is radio time a live connection does not get. 100ms while looking for the
    // mesh, 250ms once there is a link worth protecting — still four
    // advertisements a second, so nothing takes meaningfully longer to find us.
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(
        if (advertisingRelaxed) AdvertiseSettings.ADVERTISE_MODE_BALANCED
        else AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY,
      )
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
          // Android reports a connection to the GATT server for links this app
          // opened itself as a central. Taking that at face value invents a
          // second Link over the one ACL which can never complete a handshake:
          // it holds a slot, blocks re-dialling that address, and is eventually
          // swept as a failure that never happened.
          if (links.containsKey(linkKey(device.address, Role.CENTRAL))) return@post
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
        link.lastProgressAt = System.currentTimeMillis()
        // There is a connection to protect now; back the radio off.
        retuneRadio()
        enqueue(link, MeshWire.KIND_HELLO, idBytes(selfId))
      }
    }

    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
      post {
        val link = links[linkKey(device.address, Role.PERIPHERAL)] ?: return@post
        link.busy = false
        link.lastProgressAt = System.currentTimeMillis()
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

  /** The mode the running scan was started with, or -1 when not scanning. */
  private var activeScanMode = -1

  /** True while the advertiser is on its relaxed, already-connected duty cycle. */
  private var advertisingRelaxed = false

  private fun linked() = links.values.any { it.ready }

  /**
   * How hard to scan, given whether this node already has a link.
   *
   * `SCAN_MODE_LOW_LATENCY` is a 100% duty cycle: the controller scans in every
   * single interval and has no radio time left over. That is the right setting
   * for an empty room, and it is fatal once a connection exists — the link's
   * connection events lose to the scan, get missed, and the link dies on its
   * supervision timeout a few seconds after it came up. The peer sees a
   * disconnect it did not ask for and neither side knows why.
   *
   * So the aggressive scan is what an unconnected node does to find the mesh,
   * and a node that has found it backs off to a duty cycle that leaves the
   * radio time to keep what it has. Discovery of *further* peers is slower;
   * that is the correct trade, because a peer discovered on a link that then
   * drops is worth nothing.
   */
  private fun desiredScanMode(): Int =
    if (linked()) ScanSettings.SCAN_MODE_LOW_POWER else ScanSettings.SCAN_MODE_LOW_LATENCY

  /**
   * Re-tune scanning and advertising to the current link state.
   *
   * Called whenever a link becomes usable or is lost. Deliberately does not
   * *start* a scan that is currently stopped: a dial in flight holds it down on
   * purpose, and [releaseScan] is what hands it back.
   */
  private fun retuneRadio() {
    if (!running) return
    if (scanning && activeScanMode != desiredScanMode()) {
      stopScanning()
      startScanning()
    }
    val relaxed = linked()
    if (relaxed != advertisingRelaxed) {
      advertisingRelaxed = relaxed
      stopAdvertising()
      startAdvertising()
    }
  }

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
      // Say so. Being over quota means this node is deaf until the window
      // rolls, and a deaf node is indistinguishable from an empty room — which
      // is exactly the confusing silence this log line exists to break.
      log("scan start quota reached, deaf for ${wait / 1000}s")
      handler?.postDelayed({
        scanRestartPending = false
        startScanning()
      }, wait)
      return
    }
    scanStarts.addLast(now)

    scanner = s
    val mode = desiredScanMode()
    val filters = listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(MeshWire.SERVICE)).build())
    val settings = ScanSettings.Builder()
      .setScanMode(mode)
      .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
      .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
      .setNumOfMatches(ScanSettings.MATCH_NUM_MAX_ADVERTISEMENT)
      .setReportDelay(0)
      .build()
    try {
      s.startScan(filters, settings, scanCallback)
      scanning = true
      activeScanMode = mode
      log(if (mode == ScanSettings.SCAN_MODE_LOW_LATENCY) "scanning for mesh nodes" else "scanning gently, links to keep alive")
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
    activeScanMode = -1
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

    val existing = links.values.firstOrNull { it.identified && it.nodeId == peerNode }
    if (existing != null) {
      // It is advertising, so it is powered, in range, and not talking to us.
      // Believing the link over that evidence costs the entire silence budget,
      // and every inbound link the peer builds meanwhile is refused as a
      // duplicate of a connection that has already stopped existing.
      if (System.currentTimeMillis() - existing.lastHeardAt > LINK_IDLE_MS) {
        teardown(existing, "advertising again while its link stays silent")
      } else {
        existing.rssi = result.rssi
        return
      }
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
    // A handle for this address still waiting on its disconnect would otherwise
    // be closed by its timeout partway through the new connection.
    finishClose(device.address)
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
          //
          // If the stack refuses the request outright there is no `onMtuChanged`
          // coming, and discovery is only ever started from that callback — so
          // the link would sit half-open until the sweep collected it, having
          // never once been usable. A refused MTU is not a reason to give up a
          // connection; it only means smaller segments.
          if (!gatt.requestMtu(PREFERRED_MTU)) {
            log("mtu request refused by the stack, continuing at ${MeshWire.MIN_MTU}B")
            gatt.discoverServices()
          }
        } else {
          dialling.remove(gatt.device.address)
          // The disconnect we were waiting for before closing the handle. It
          // arrives here whether the peer hung up or `releaseGatt` asked for it.
          if (link != null) teardown(link, "disconnected (status $status)")
          finishClose(gatt.device.address, fallback = if (link == null) gatt else null)
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
        link.lastProgressAt = System.currentTimeMillis()
        // The connection is established; scanning is safe again — but gently,
        // so resuming it does not immediately starve the link that just came up.
        releaseScan(link)
        retuneRadio()
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
        link.lastProgressAt = System.currentTimeMillis()
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
      link.lastProgressAt = System.currentTimeMillis()
      return
    }

    // Stack refused it. Put it back and try again shortly rather than dropping.
    link.busy = false
    link.outbox.addFirst(segment)
    if (++link.retries > MAX_DRAIN_RETRIES) {
      teardown(link, "congested for ${MAX_DRAIN_RETRIES * DRAIN_RETRY_MS / 1000}s")
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
    // Before reassembly, deliberately: a segment arriving is proof the link is
    // alive whether or not it completes a message.
    link.lastHeardAt = System.currentTimeMillis()
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
   *
   * That rule decides between two links that both work. It must never be asked
   * to decide between a working link and a dead one, because it cannot see the
   * difference: it would keep a link that stopped carrying anything half a
   * minute ago purely because of its role, close the one the peer has just
   * built to replace it, and go on closing every replacement the peer offers
   * until the silence sweep finally collects the corpse. So the dead ones are
   * reaped first and the tie-break only ever sees live candidates.
   */
  private fun identify(link: Link, nodeId: Int) {
    if (nodeId == 0 || nodeId == selfId) {
      teardown(link, "peer reported an unusable node id")
      return
    }
    // A HELLO on a link that is already bound to this peer is a keepalive.
    // `receive` has already recorded it; re-running the duplicate resolution
    // and re-announcing the peer would only churn the UI.
    if (link.identified && link.nodeId == nodeId) return
    link.nodeId = nodeId
    link.identified = true
    awaitingInbound.remove(nodeId)
    // The peer works. Anything held against it from an earlier failure is stale.
    dialFailures.remove(nodeId)
    dialBackoff.remove(nodeId)

    val now = System.currentTimeMillis()
    val rivals = links.values.filter { it !== link && it.identified && it.nodeId == nodeId }
    for (dead in rivals) {
      if (now - dead.lastHeardAt > LINK_IDLE_MS) {
        teardown(dead, "superseded — nothing heard on it for ${(now - dead.lastHeardAt) / 1000}s")
      }
    }

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
        Role.CENTRAL -> link.gatt?.let { releaseGatt(link.device.address, it, link.connected) }
        // One ACL carries both GATT sessions when a pair ends up linked in both
        // directions, so cancelling the server side would drop the connection
        // the central half is still using. Leaving the server session idle
        // costs nothing; taking the radio link out from under a working central
        // costs the peer.
        Role.PERIPHERAL ->
          if (links.containsKey(linkKey(link.device.address, Role.CENTRAL))) {
            log("leaving ${link.device.address} connected for the central half")
          } else {
            gattServer?.cancelConnection(link.device)
          }
      }
    } catch (e: Exception) {
      log("teardown threw: ${e.message}")
    }
    link.gatt = null
    link.connected = false
    releaseScan(link)
    // Losing the last link means going back to hunting for the mesh in earnest.
    retuneRadio()
    if (link.identified) log("lost ${peerIdOf(link.nodeId)}: $reason") else noteDialFailure(link, reason)
    emitPeers()
  }

  /**
   * Give a GATT client handle back to the stack, in the order the stack needs.
   *
   * `disconnect()` starts an asynchronous teardown; `close()` unregisters this
   * app's client interface immediately. Calling them back to back — which is
   * what this did — removes the registration while the controller still holds
   * the ACL, so nothing is left to finish the teardown and nothing reports it.
   * Two things follow, and between them they are the whole bug:
   *
   *  - The connection lingers. The *next* `connectGatt` to that device attaches
   *    to the existing ACL rather than opening a fresh one, so the new link is
   *    born on a connection already scheduled to die; when the stack finally
   *    reaps the orphan a few seconds later it takes the new link with it. That
   *    is the disconnect that arrives seconds after a connection that looked
   *    perfectly healthy, and it repeats because each attempt leaves another.
   *  - Every cycle burns a client interface, and an app gets a small fixed
   *    number of them. Once they are gone `connectGatt` fails immediately, for
   *    every peer, until the process restarts — the silence after the flapping.
   *
   * So: disconnect, wait for the callback to say it happened, then close. The
   * timeout is only there for the callback that never comes.
   */
  private fun releaseGatt(address: String, gatt: BluetoothGatt, connected: Boolean) {
    if (!connected) {
      // Nothing to disconnect — closing a handle that never connected is the
      // whole release, and disconnecting it is what strands a client interface.
      runCatching { gatt.close() }
      return
    }
    closing[address]?.let { if (it !== gatt) runCatching { it.close() } }
    closing[address] = gatt
    runCatching { gatt.disconnect() }
    handler?.postDelayed({ finishClose(address) }, CLOSE_GRACE_MS)
  }

  /** Closes a handle whose disconnect has landed, or timed out. Idempotent. */
  private fun finishClose(address: String, fallback: BluetoothGatt? = null) {
    val gatt = closing.remove(address) ?: fallback ?: return
    runCatching { gatt.close() }
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
        if (!link.ready) {
          val budget = if (link.background) BACKGROUND_CONNECT_TIMEOUT_MS else CONNECT_TIMEOUT_MS
          if (now - link.openedAt > budget) teardown(link, "handshake never completed")
          continue
        }
        // A segment handed to the stack whose completion callback never came.
        // The link is not congested — `drain` handles that and gives up loudly
        // — it is wedged: `busy` stays true, `drain` returns immediately every
        // time, and the link sits in the peer list moving nothing.
        if (link.busy && now - link.lastProgressAt > WRITE_STALL_MS) {
          teardown(link, "the stack never finished a write")
          continue
        }
        // Subscribed, but the peer never said who it is. It cannot be addressed
        // and it cannot be routed through, so it is holding an outbound slot
        // for nothing.
        if (!link.identified) {
          val budget = if (link.background) BACKGROUND_CONNECT_TIMEOUT_MS else CONNECT_TIMEOUT_MS
          if (now - link.openedAt > budget) teardown(link, "peer never introduced itself")
          continue
        }
        val silence = now - link.lastHeardAt
        if (silence > LINK_SILENCE_MS) {
          teardown(link, "silent for ${silence / 1000}s")
          continue
        }
        // Half-open: the connection is gone but neither stack has noticed, so
        // no disconnect callback is coming. Sending something is the only way
        // to find out, and a HELLO is what the peer already expects.
        if (silence > LINK_IDLE_MS && now - link.lastPingAt > LINK_IDLE_MS) {
          link.lastPingAt = now
          enqueue(link, MeshWire.KIND_HELLO, idBytes(selfId))
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
