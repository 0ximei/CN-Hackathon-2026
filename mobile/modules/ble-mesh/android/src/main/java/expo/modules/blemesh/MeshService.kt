package expo.modules.blemesh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Keeps the mesh alive after the user leaves the app.
 *
 * Android kills an app's process when it is swiped out of recents, and starves
 * it of CPU well before that. A radio is not something that can be resumed
 * afterwards — links are torn down, the node stops advertising, and every peer
 * that was routing through it has to relearn the mesh without it. The only
 * supported way to say "this process is doing something the user asked for and
 * must keep running" is a foreground service, which is this.
 *
 * **What this does not do is run the mesh natively.** Routing, deduplication,
 * replication, the catalogue and the store-and-forward outbox are all
 * TypeScript, and a radio without them is a phone holding open connections it
 * cannot answer on. So the job here is not to take the mesh over — it is to
 * keep the *process* alive, and with it the JavaScript that is the mesh. The
 * Activity can be destroyed and the app can vanish from recents; as long as
 * this service is up, the runtime underneath it is not reclaimed.
 *
 * The notification is not a formality either. It is the honest disclosure that
 * a radio is running with the app closed, and the only place a user can turn it
 * off without launching the app again.
 */
class MeshService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      // Asked to stop from the notification, with the app possibly not running.
      onStopRequested?.invoke()
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

    // Deliberately not sticky. Being a foreground service is what stops the
    // process being reclaimed; restarting after it happens anyway is a separate
    // question, and the answer here is no. The radio is started from JavaScript
    // with a node id this service does not have, so a resurrected service would
    // come back with a notification, no radio behind it, and no way to get one
    // — telling the user the mesh is up when it is not. If the system takes the
    // process, the mesh is down until the app is opened, and the missing
    // notification says exactly that.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
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
    private const val EXTRA_DETAIL = "detail"

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
      context.stopService(Intent(context, MeshService::class.java))
    }
  }
}
