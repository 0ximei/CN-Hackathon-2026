package expo.modules.blemesh

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.SystemClock

import androidx.core.content.ContextCompat

import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Keeps the mesh on the air after the user leaves, and after the user kills it.
 *
 * Three separate things have to be true for that, and the first version of this
 * service only managed one of them.
 *
 * **The process has to survive the app closing.** Android starves a background
 * process of CPU and reclaims it outright when the app is swiped from recents.
 * A foreground service with a visible notification is the only supported way to
 * say the user asked for this. That much was always here.
 *
 * **The runtime has to keep working, not merely exist.** React Native stops
 * delivering timers when the Activity pauses and does not resume them when it
 * is destroyed, and the mesh is entirely timers. Extending
 * [HeadlessJsTaskService] is what fixes that: a headless task is the one state
 * in which React Native leaves the clock running, and it also knows how to
 * *create* a React context from a service, which is the next problem.
 *
 * **And it has to come back from being killed.** Swiping the app away destroys
 * the task, and on plenty of devices — anything with an aggressive memory
 * manager, which is most Android phones people actually own — takes the process
 * with it regardless of the notification. So the service is sticky and it
 * re-arms itself on task removal, and when it restarts it boots JavaScript with
 * no Activity behind it. What it does *not* do is carry any mesh state across
 * that restart: the identity, the preference and the catalog are all in SQLite
 * already, so `startDaemon` in `src/mesh/daemon.ts` rebuilds the node from disk
 * without the native side having to remember a node id and keep it in sync.
 *
 * That last part is what changed the answer on stickiness. A sticky service
 * that could not restart the radio would come back as a notification claiming a
 * mesh that was not there; one that can is just the daemon doing its job.
 */
class MeshService : HeadlessJsTaskService() {

  /**
   * Whether a task is already holding the runtime open.
   *
   * `onStartCommand` is called again for every notification update — a peer
   * joining is enough — and each one would otherwise start another task on top
   * of the last, each with its own wakelock and its own `startDaemon`.
   */
  private var holding = false

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      // Asked to stop from the notification, with the app possibly not running.
      onStopRequested?.invoke()
      cancelRestart(this)
      stopSelf()
      return START_NOT_STICKY
    }

    // Before anything that can block: from Android 8 the system gives a service
    // started with `startForegroundService` a few seconds to post a
    // notification and kills the process if it does not.
    // Refuse rather than crash when the radio permissions are not granted.
    //
    // From Android 14 `startForeground` with a `connectedDevice` type throws
    // `SecurityException` unless one of the BLUETOOTH_* permissions is held
    // right now, and it throws *here* — on the service's own main thread,
    // inside `handleServiceArgs` — where the module's `runCatching` around
    // `startForegroundService` is a different call stack entirely and catches
    // nothing. Unguarded that is a fatal exception on a START_STICKY service,
    // so the system restarts it and it dies again on the same line.
    //
    // Reachable with no user in front of it: a sticky restart calls back in
    // with no Activity and no React tree, and a permission the user revoked
    // from Settings looks exactly like one they never granted.
    if (!hasRadioPermission()) {
      stopSelf()
      return START_NOT_STICKY
    }

    val detail = intent?.getStringExtra(EXTRA_DETAIL) ?: "starting"
    val notification = build(detail)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      // Declared as `connectedDevice` rather than a generic service: from
      // Android 14 the type is mandatory and is what exempts the process from
      // the background restrictions that would otherwise throttle the radio.
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    if (!holding) {
      holding = true
      // Creates the React context if there is not one — the restart path — and
      // starts the task on it once it is ready.
      super.onStartCommand(intent, flags, startId)
    }

    // Sticky, so the system brings the service back after killing the process.
    // Safe to be, now that a restarted service can rebuild the node from disk;
    // it was not when the node id lived only in JavaScript. The restart arrives
    // with a null intent, which is why `detail` has a fallback.
    return START_STICKY
  }

  /**
   * Whether the process currently holds a permission that satisfies the
   * `connectedDevice` foreground service type.
   *
   * Any one of the three is enough for the platform check. They are asked for
   * together and a partial grant is not something the UI offers, but the test
   * matches what `validateForegroundServiceType` actually enforces rather than
   * what this app happens to request — the point is to never be stricter than
   * the thing that throws, and never looser.
   */
  private fun hasRadioPermission(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    return listOf(
      android.Manifest.permission.BLUETOOTH_CONNECT,
      android.Manifest.permission.BLUETOOTH_SCAN,
      android.Manifest.permission.BLUETOOTH_ADVERTISE,
    ).any {
      ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }
  }

  /**
   * The config for the task that holds the runtime open.
   *
   * Timeout 0 means no deadline: this ends when the service does, not on a
   * clock. Allowed in the foreground because switching background mode on is
   * something someone does while looking at the screen, and `startTask` throws
   * rather than waits if the app happens to be resumed.
   */
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(AWAKE_TASK, Arguments.createMap(), 0L, true)

  /**
   * The app was swiped out of recents.
   *
   * `stopWithTask` is false so the service itself is not stopped, but on many
   * devices the process is killed anyway a moment later, and a killed process
   * cannot schedule its own recovery. So the alarm is set here, while there is
   * still something running to set it: if the process survives, the alarm
   * arrives at a service that is already up and does nothing but redraw a
   * notification; if it does not, the alarm is what brings the mesh back.
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    scheduleRestart(this)
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    holding = false
    runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
      else @Suppress("DEPRECATION") stopForeground(true)
    }
    super.onDestroy()
  }

  private fun build(detail: String): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Mesh radio",
        // Low: this has to be visible, and it does not have to interrupt.
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Shown while this phone is carrying the mesh in the background"
        setShowBadge(false)
      }
      manager.createNotificationChannel(channel)
    }

    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, immutable(PendingIntent.FLAG_UPDATE_CURRENT))
    }
    val stop = PendingIntent.getService(
      this,
      1,
      Intent(this, MeshService::class.java).setAction(ACTION_STOP),
      immutable(PendingIntent.FLAG_UPDATE_CURRENT),
    )

    @Suppress("DEPRECATION")
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      Notification.Builder(this)
    }

    return builder
      .setContentTitle("MeshNet is on the air")
      .setContentText(detail)
      // A framework drawable, so the module needs no resources of its own.
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .apply {
        if (open != null) setContentIntent(open)
        addAction(Notification.Action.Builder(null, "Stop", stop).build())
      }
      .build()
  }

  private fun immutable(flags: Int): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags or PendingIntent.FLAG_IMMUTABLE
    else flags

  companion object {
    private const val CHANNEL_ID = "meshnet.radio"
    private const val NOTIFICATION_ID = 0x4d45
    private const val ACTION_STOP = "expo.modules.blemesh.STOP"
    private const val ACTION_RESTART = "expo.modules.blemesh.RESTART"
    private const val EXTRA_DETAIL = "detail"

    /** Must match `BACKGROUND_TASK` in `src/mesh/backgroundTask.ts`. */
    private const val AWAKE_TASK = "MeshNetBackground"

    /**
     * How long after the task is swiped away to check the mesh is still up.
     *
     * Long enough that the kill, if there is going to be one, has happened —
     * restarting into a process the system is still tearing down just gets the
     * new one killed as well.
     */
    private const val RESTART_DELAY_MS = 3_000L

    /**
     * Invoked when the user taps Stop on the notification.
     *
     * Set by the module while the radio is up. Null after a process restart, in
     * which case there is no radio to stop and shutting the service down is the
     * whole job.
     */
    @Volatile
    var onStopRequested: (() -> Unit)? = null

    fun start(context: Context, detail: String) {
      val intent = Intent(context, MeshService::class.java).putExtra(EXTRA_DETAIL, detail)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    /** Same call as `start`; the service updates its notification in place. */
    fun update(context: Context, detail: String) = start(context, detail)

    fun stop(context: Context) {
      onStopRequested = null
      cancelRestart(context)
      context.stopService(Intent(context, MeshService::class.java))
    }

    /**
     * An inexact alarm on purpose.
     *
     * Exact alarms need `SCHEDULE_EXACT_ALARM` from Android 12, which is a
     * permission users are asked to grant in Settings and which Google Play
     * restricts to alarm clocks and calendars. A mesh coming back a minute
     * later than it might have is not worth that; a mesh not coming back at all
     * is what this is for.
     */
    private fun restartIntent(context: Context): PendingIntent {
      val intent = Intent(context, MeshService::class.java).setAction(ACTION_RESTART)
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_IMMUTABLE else 0
      return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        PendingIntent.getForegroundService(context, 2, intent, flags)
      } else {
        // Below 26 there is no distinction, and no five-second deadline either.
        PendingIntent.getService(context, 2, intent, flags)
      }
    }

    private fun scheduleRestart(context: Context) {
      val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
      runCatching {
        alarms.set(
          AlarmManager.ELAPSED_REALTIME_WAKEUP,
          SystemClock.elapsedRealtime() + RESTART_DELAY_MS,
          restartIntent(context),
        )
      }
    }

    private fun cancelRestart(context: Context) {
      val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
      // Stopping means stopping. Leaving the alarm armed would bring the mesh
      // back a few seconds after the user turned it off, which is the kind of
      // thing that makes people uninstall an app rather than file a bug.
      runCatching { alarms.cancel(restartIntent(context)) }
    }
  }
}
