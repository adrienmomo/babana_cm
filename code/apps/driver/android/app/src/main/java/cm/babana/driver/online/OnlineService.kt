package cm.babana.driver.online

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Online driver: a real foreground service (type location) for as long as the driver is online.
 *
 * Two jobs, both needed to keep receiving proposals with the app in the background or swiped
 * away (decision of 14 November):
 *  - Android keeps the process alive and keeps delivering location to it (a location-type
 *    foreground service is the only way to read GPS from the background on Android 14+).
 *  - React Native pauses every JS timer once the app leaves the screen, except while a headless JS
 *    task is running (JavaTimerManager). The service runs one ("BabanaDriverOnline",
 *    src/onlineTask.ts) that only ends when the driver goes offline: the 2-second capture,
 *    the WebSocket heartbeat and the proposal alert keep running.
 *
 * The notification is the one the driver already knew ("Dernière position envoyée..."): its text
 * still comes from JS (location/background.ts), this service only carries it.
 */
class OnlineService : HeadlessJsTaskService() {

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: lastText
    try {
      startAsForeground(text)
    } catch (error: Exception) {
      // Not allowed right now (location permission withdrawn, start from the background refused
      // by the system): no service, and JS retries at the next notification refresh.
      running = false
      stopSelf()
      return START_NOT_STICKY
    }
    running = true
    return super.onStartCommand(intent, flags, startId)
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
      // No timeout: the task lasts as long as the driver is online. Allowed in foreground: the
      // driver goes online with the app on screen, and the task must already be running then.
      HeadlessJsTaskConfig(TASK_NAME, Arguments.createMap(), 0, true)

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  private fun startAsForeground(text: String) {
    val notification = buildNotification(this, text)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  companion object {
    const val TASK_NAME = "BabanaDriverOnline"
    const val EXTRA_TEXT = "text"

    // Same channel and id as the notification posted from JS before this service existed
    // (location/background.ts): one notification, never two side by side after an update.
    private const val CHANNEL_ID = "location-tracking"
    private const val NOTIFICATION_ID = 4202

    @Volatile var running = false
      private set

    @Volatile private var lastText = ""

    fun show(context: Context, text: String) {
      lastText = text
      if (running) {
        context.getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(context, text))
        return
      }
      val intent = Intent(context, OnlineService::class.java).putExtra(EXTRA_TEXT, text)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      // Starting: the next refresh updates the notification instead of starting a second task.
      // onStartCommand puts it back to false if the system refuses the foreground start.
      running = true
    }

    fun hide(context: Context) {
      context.stopService(Intent(context, OnlineService::class.java))
      running = false
    }

    private fun buildNotification(context: Context, text: String): Notification {
      ensureChannel(context)
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val tap =
          launch?.let {
            PendingIntent.getActivity(
                context,
                0,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
          }
      return NotificationCompat.Builder(context, CHANNEL_ID)
          .setContentTitle(context.applicationInfo.loadLabel(context.packageManager))
          .setContentText(text)
          .setSmallIcon(context.applicationInfo.icon)
          .setOngoing(true)
          .setOnlyAlertOnce(true)
          .setSilent(true)
          .setPriority(NotificationCompat.PRIORITY_LOW)
          .setCategory(NotificationCompat.CATEGORY_SERVICE)
          .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
          .setContentIntent(tap)
          .build()
    }

    private fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java)
      if (manager.getNotificationChannel(CHANNEL_ID) != null) return
      manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Partage de position", NotificationManager.IMPORTANCE_LOW)
              .apply {
                description =
                    "Indique quand votre position a été envoyée pour la dernière fois, pendant que vous êtes en ligne"
                setSound(null, null)
                enableVibration(false)
              })
    }
  }
}
