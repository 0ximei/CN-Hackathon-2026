package expo.modules.blemesh

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.aware.WifiAwareManager
import android.os.Build
import android.util.Base64
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS surface for [MeshRadio].
 *
 * Frames cross the bridge base64-encoded. Binary would save a third of the
 * bytes, but mesh frames are hundreds of bytes and arrive at radio speed —
 * a few kB/s — so the encoding is never the bottleneck, and a plain string
 * behaves identically across the old and new React Native architectures.
 */
@SuppressLint("MissingPermission")
class BleMeshModule : Module() {
  private var radio: MeshRadio? = null

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("BleMesh")

    Events("onFrame", "onPeers", "onLog", "onState")

    /** Radio capabilities, so the UI can explain a failure before it happens. */
    Function("capabilities") {
      val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
      val adapter = manager?.adapter
      mapOf(
        "hasAdapter" to (adapter != null),
        "enabled" to (adapter?.isEnabled ?: false),
        // The one capability that decides whether a mesh is possible at all.
        // A device that cannot advertise can dial out but can never be found,
        // so it can only ever be a leaf hanging off someone else.
        "canAdvertise" to (adapter?.isMultipleAdvertisementSupported ?: false),
      ) + wifiCapabilities()
    }

    AsyncFunction("start") { nodeId: Int ->
      val running = radio
      if (running != null) {
        // Idempotent for the same node, but only for the same node. The id is
        // what peers key every route, holder record and dial tie-break on, so a
        // radio still advertising a previous identity is worse than no radio:
        // it is a node the mesh believes in and this app no longer is.
        if (running.nodeId == nodeId) {
          return@AsyncFunction mapOf("ok" to true, "error" to null)
        }
        running.stop()
        radio = null
      }
      val instance = MeshRadio(context, nodeId, radioEvents)
      val error = instance.start()
      if (error != null) {
        mapOf("ok" to false, "error" to error)
      } else {
        radio = instance
        mapOf("ok" to true, "error" to null)
      }
    }

    AsyncFunction("stop") {
      radio?.stop()
      radio = null
    }

    /** @return false when no link to that peer is open, so the caller can queue. */
    AsyncFunction("send") { peerId: String, data: String ->
      radio?.send(peerId, Base64.decode(data, Base64.NO_WRAP)) ?: false
    }

    /** @return the number of links the frame went out on. */
    AsyncFunction("broadcast") { data: String, except: String? ->
      radio?.broadcast(Base64.decode(data, Base64.NO_WRAP), except) ?: 0
    }

    Function("peers") {
      radio?.peers()?.map { it.toMap() } ?: emptyList<Map<String, Any?>>()
    }

    OnDestroy {
      radio?.stop()
      radio = null
    }
  }

  /**
   * Whether this device could carry the mesh over Wi-Fi instead.
   *
   * Reported, not used. Wi-Fi would move a catalogue in a blink where BLE takes
   * seconds, but bandwidth is not what BLE is providing here — symmetry is.
   * Every node advertises, scans, and holds several links in both roles at
   * once, with no pairing and no taps, and that is what makes this a mesh
   * rather than a star.
   *
   * Only Wi-Fi Aware keeps that property: simultaneous publish and subscribe,
   * several concurrent data paths, no access point and no user interaction.
   * Wi-Fi Direct forms a *group* with one owner and a device belongs to one
   * group at a time, which is a star wearing a mesh's clothes.
   *
   * So the question that decides it is not "is Wi-Fi faster" but "does this
   * particular handset have Aware", because the answer varies by chipset and
   * vendor HAL rather than by Android version. That is what this reports, for
   * the phones actually in the room.
   */
  private fun wifiCapabilities(): Map<String, Any> {
    val pm = context.packageManager
    val hasDirect = pm.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return mapOf(
        "wifiDirect" to hasDirect,
        "wifiAware" to false,
        "wifiAwareReady" to false,
        "wifiAwareDetail" to "Wi-Fi Aware needs Android 8; this is ${Build.VERSION.RELEASE}",
      )
    }
    val hasAware = pm.hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE)
    // Supported and *available* are different questions: Aware is turned off
    // with Wi-Fi, and is refused outright while some other subsystem holds the
    // radio, so a device can advertise the feature and still not serve it now.
    val ready = if (!hasAware) false else {
      val manager = context.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager
      manager?.isAvailable == true
    }
    return mapOf(
      "wifiDirect" to hasDirect,
      "wifiAware" to hasAware,
      "wifiAwareReady" to ready,
      "wifiAwareDetail" to when {
        !hasAware -> "this chipset does not implement Wi-Fi Aware"
        ready -> "Wi-Fi Aware supported and available now"
        else -> "supported, but unavailable right now — Wi-Fi may be off"
      },
    )
  }

  private fun MeshRadio.PeerSnapshot.toMap() = mapOf(
    "peerId" to peerId,
    "nodeId" to nodeId,
    "role" to role,
    "mtu" to mtu,
    "rssi" to rssi,
  )

  private val radioEvents = object : MeshRadio.RadioEvents {
    override fun onFrame(peerId: String, payload: ByteArray) {
      sendEvent(
        "onFrame",
        mapOf(
          "peerId" to peerId,
          "data" to Base64.encodeToString(payload, Base64.NO_WRAP),
        ),
      )
    }

    override fun onPeers(peers: List<MeshRadio.PeerSnapshot>) {
      sendEvent("onPeers", mapOf("peers" to peers.map { it.toMap() }))
    }

    override fun onLog(message: String) {
      sendEvent("onLog", mapOf("message" to message))
    }

    override fun onState(state: String, detail: String) {
      sendEvent("onState", mapOf("state" to state, "detail" to detail))
    }
  }
}
