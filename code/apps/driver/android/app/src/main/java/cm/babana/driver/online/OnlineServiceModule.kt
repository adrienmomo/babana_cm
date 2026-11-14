package cm.babana.driver.online

import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS side: `NativeModules.BabanaOnlineService` (src/location/background.ts). `show` starts the
 * service on first call and only updates its notification afterwards; `hide` stops it.
 */
class OnlineServiceModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {

  override fun getName(): String = "BabanaOnlineService"

  @ReactMethod
  fun show(text: String) {
    // A location-type foreground service started without location permission is a crash on
    // Android 14+, not an error: never start it before the permission is granted. JS calls again
    // at every capture and refresh, so the service starts as soon as the driver allows it.
    if (!OnlineService.running && !hasLocationPermission()) return
    try {
      OnlineService.show(context, text)
    } catch (error: Exception) {
      // Start from the background refused (Android 12+): retried at the next call.
    }
  }

  @ReactMethod
  fun hide() {
    OnlineService.hide(context)
  }

  private fun hasLocationPermission(): Boolean =
      listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION).any {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
      }
}
