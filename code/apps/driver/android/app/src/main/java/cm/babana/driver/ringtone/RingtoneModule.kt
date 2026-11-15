package cm.babana.driver.ringtone

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import cm.babana.driver.R
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Sonnerie d'une proposition de course (15 novembre) : `res/raw/proposal_ringtone.mp3`, en boucle,
 * au volume des alarmes -- elle sonne même téléphone en silencieux (réponse du maître d'ouvrage) --
 * jusqu'à la réponse du chauffeur ou l'expiration de la proposition. L'arrêt automatique est côté
 * natif (`maxDurationMs`) : un téléphone dans une poche, app fermée, ne sonne jamais sans fin.
 *
 * JS : `NativeModules.BabanaRingtone` (src/ringtone.ts).
 */
class RingtoneModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val handler = Handler(Looper.getMainLooper())
  private var player: MediaPlayer? = null
  private val stopRunnable = Runnable { stopNow() }

  override fun getName(): String = "BabanaRingtone"

  @ReactMethod
  fun start(maxDurationMs: Double) {
    handler.post {
      stopNow()
      val attributes =
          AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_ALARM)
              .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
              .build()
      val descriptor = context.resources.openRawResourceFd(R.raw.proposal_ringtone) ?: return@post
      player =
          MediaPlayer().apply {
            setAudioAttributes(attributes)
            setDataSource(descriptor.fileDescriptor, descriptor.startOffset, descriptor.length)
            descriptor.close()
            isLooping = true
            prepare()
            start()
          }
      vibrator()?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 600, 400), 0))
      handler.postDelayed(stopRunnable, maxDurationMs.toLong().coerceIn(1_000L, 120_000L))
    }
  }

  @ReactMethod
  fun stop() {
    handler.post { stopNow() }
  }

  private fun stopNow() {
    handler.removeCallbacks(stopRunnable)
    player?.run {
      try {
        if (isPlaying) stop()
      } catch (_: IllegalStateException) {}
      release()
    }
    player = null
    vibrator()?.cancel()
  }

  private fun vibrator(): Vibrator? =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
      } else {
        @Suppress("DEPRECATION") context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
      }
}
