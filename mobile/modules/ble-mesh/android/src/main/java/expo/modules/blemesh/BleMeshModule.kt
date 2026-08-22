package expo.modules.blemesh

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.content.Context
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
      )
    }

    AsyncFunction("start") { nodeId: Int ->
      if (radio != null) return@AsyncFunction mapOf("ok" to true, "error" to null)
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
