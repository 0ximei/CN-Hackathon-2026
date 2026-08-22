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
    var retries = 0
    val openedAt: Long = System.currentTimeMillis()
    val outbox = ArrayDeque<ByteArray>()
    var busy = false
    val reassembler = Reassembler()
    val key: String get() = linkKey(device.address, role)
  }

  private val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
  private val adapter: BluetoothAdapter? get() = manager.adapter

  private var advertiser: BluetoothLeAdvertiser? = null
  private var scanner: BluetoothLeScanner? = null
  private var gattServer: BluetoothGattServer? = null
  private var txCharacteristic: BluetoothGattCharacteristic? = null

  private var thread: HandlerThread? = null
  private var handler: Handler? = null
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

  private companion object {
    const val MAX_CENTRAL_LINKS = 4
    const val INBOUND_GRACE_MS = 9_000L
    const val TICK_MS = 3_000L
    const val SCAN_REFRESH_MS = 240_000L
    const val DRAIN_RETRY_MS = 25L
    const val MAX_DRAIN_RETRIES = 40
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
    h.post {
      h.removeCallbacksAndMessages(null)
      stopAdvertising()
      stopScanning()
      for (link in links.values.toList()) teardown(link, "shutdown")
      links.clear()
      awaitingInbound.clear()
      dialling.clear()
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

    // A 128-bit service UUID costs 18 of the 31 advertisement bytes, and the
    // flags field takes 3. The node id will not also fit, so it goes in the
    // scan response — which a scanner in active mode always requests anyway.
    val payload = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .addServiceUuid(ParcelUuid(MeshWire.SERVICE))
      .build()

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

  private fun startScanning() {
    val s = adapter?.bluetoothLeScanner ?: return
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
      log("scanning for mesh nodes")
    } catch (e: Exception) {
      log("startScan threw: ${e.message}")
    }
  }

  private fun stopScanning() {
    try {
      scanner?.stopScan(scanCallback)
    } catch (e: Exception) {
      log("stopScan threw: ${e.message}")
    }
    scanner = null
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
   */
  private fun considerPeer(result: ScanResult) {
    if (!running) return
    val record = result.scanRecord ?: return
    val idData = record.getManufacturerSpecificData(MeshWire.MANUFACTURER_ID) ?: return
    if (idData.size < 4) return
    val peerNode = readId(idData)
    if (peerNode == 0 || peerNode == selfId) return

    links.values.firstOrNull { it.identified && it.nodeId == peerNode }?.let {
      it.rssi = result.rssi
      return
    }

    val address = result.device.address
    if (dialling.contains(address)) return
    if (links.containsKey(linkKey(address, Role.CENTRAL))) return

    val weDial = Integer.compareUnsigned(selfId, peerNode) < 0
    if (!weDial) {
      val since = awaitingInbound.getOrPut(peerNode) { System.currentTimeMillis() }
      if (System.currentTimeMillis() - since < INBOUND_GRACE_MS) return
      log("${peerIdOf(peerNode)} never dialled us, dialling it instead")
    }

    val centralLinks = links.values.count { it.role == Role.CENTRAL }
    if (centralLinks >= MAX_CENTRAL_LINKS) return

    dial(result.device, peerNode, result.rssi)
  }

  private fun dial(device: BluetoothDevice, expectedNode: Int, rssi: Int) {
    dialling.add(device.address)
    log("dialling ${peerIdOf(expectedNode)} at ${device.address}")
    val link = Link(device, Role.CENTRAL)
    link.rssi = rssi
    links[link.key] = link
    // autoConnect=false gives a direct, fast connection; TRANSPORT_LE avoids the
    // stack guessing BR/EDR and returning status 133 on dual-mode devices.
    link.gatt = device.connectGatt(context, false, clientCallback, BluetoothDevice.TRANSPORT_LE)
    if (link.gatt == null) teardown(link, "connectGatt refused")
  }

  private val clientCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      post {
        val link = links[linkKey(gatt.device.address, Role.CENTRAL)]
        if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
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
        if (status != BluetoothGatt.GATT_SUCCESS) log("write failed: status $status")
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
        Role.CENTRAL -> link.gatt?.let { it.disconnect(); it.close() }
        Role.PERIPHERAL -> gattServer?.cancelConnection(link.device)
      }
    } catch (e: Exception) {
      log("teardown threw: ${e.message}")
    }
    link.gatt = null
    if (link.identified) log("lost ${peerIdOf(link.nodeId)}: $reason")
    emitPeers()
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
      for (link in links.values.toList()) {
        if (!link.ready && now - link.openedAt > CONNECT_TIMEOUT_MS) {
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
