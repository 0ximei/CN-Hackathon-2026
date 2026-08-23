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

  /**
   * Last line shown on the service notification, so it is only rewritten when
   * it would actually differ. `onPeers` fires on every link change and posting
   * an identical notification each time is work for nothing.
   */
  private var notified: String? = null

  /**
   * Whether the user asked the mesh to keep running with the app closed.
   *
   * Off by default. The foreground service is what survives the app being
   * swiped away, and it costs a permanent notification — worth it when someone
   * has asked for it, and an imposition when they have not.
   */
  private var background = false

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
        // The radio is up, so the process now has a reason to survive the user
        // leaving. Stopping from the notification has to reach the radio, not
        // just the service, or the app comes back to a node still on air.
        MeshService.onStopRequested = {
          radio?.stop()
          radio = null
          notified = null
          background = false
        }
        if (background) announce("no peers yet")
        mapOf("ok" to true, "error" to null)
      }
    }

    /**
     * Turns the background daemon on or off while the radio is running.
     *
     * Separate from `start` because it is a preference rather than a property
     * of the radio, and someone changing their mind should not cost every link.
     */
    AsyncFunction("setBackground") { on: Boolean ->
      background = on
      if (!on) {
        notified = null
        MeshService.stop(context)
      } else {
        // Unconditionally, radio or not. Raising the service is what starts the
        // headless task that keeps JavaScript's timers being delivered, and the
        // preference is restored during startup — before the radio comes up, and
        // possibly moments before the app is closed.
        announce(peerLine(radio?.peers()?.size ?: 0))
      }
    }

    AsyncFunction("stop") {
      radio?.stop()
      radio = null
      notified = null
      MeshService.stop(context)
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
      // Reached when the React instance is torn down, which with the service
      // running should not happen while the app is merely closed. If it does —
      // the system reclaimed the process anyway — the radio goes with the
      // JavaScript that was the only thing able to answer on it, rather than
      // being left holding links nothing can route over.
      radio?.stop()
      radio = null
      notified = null
      MeshService.stop(context)
    }
  }

  private fun MeshRadio.PeerSnapshot.toMap() = mapOf(
    "peerId" to peerId,
    "nodeId" to nodeId,
    "role" to role,
    "mtu" to mtu,
    "rssi" to rssi,
  )

  /**
   * Keeps the notification honest about what the radio is currently doing, and
   * says so out loud the first time the service comes up or refuses to.
   *
   * The refusal is the part worth reporting. From Android 12 a foreground
   * service cannot be started from the background, and `startForegroundService`
   * throws rather than failing quietly; some vendor builds refuse for their own
   * reasons besides. Swallowed — which is what this used to do — the result is
   * an app that believes background mode is on, a Node tab that says so, and no
   * service anywhere, which is indistinguishable from the mesh simply not
   * working and is why a `remove task` kill at cached priority was so hard to
   * read. `notified` is cleared on failure so the next peer change tries again.
   */
  private fun announce(detail: String) {
    if (!background || detail == notified) return
    // A phone that has not granted the nearby-devices permission cannot have a
    // `connectedDevice` service at all — see [MeshService.mayRun] — and asking
    // for one anyway is what used to take the whole process down on a first
    // launch. `notified` is deliberately left untouched so this is a deferral
    // rather than a refusal: the next peer change, or the `setBackground` that
    // follows a successful start, tries again.
    if (!MeshService.mayRun(context)) {
      log("background: waiting on the nearby-devices permission")
      return
    }
    val first = notified == null
    notified = detail
    runCatching { MeshService.start(context, detail) }
      .onSuccess { if (first) log("background: foreground service up") }
      .onFailure {
        notified = null
        log("background: foreground service refused (${it.message})")
      }
  }

  private fun log(message: String) = sendEvent("onLog", mapOf("message" to message))

  private fun peerLine(n: Int) = when (n) {
    0 -> "no peers in range"
    1 -> "linked to 1 peer"
    else -> "linked to $n peers"
  }

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
      announce(peerLine(peers.size))
    }

    override fun onLog(message: String) {
      sendEvent("onLog", mapOf("message" to message))
    }

    override fun onState(state: String, detail: String) {
      sendEvent("onState", mapOf("state" to state, "detail" to detail))
    }
  }
}
