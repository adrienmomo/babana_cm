package cm.babana.client.keepawake

import android.view.WindowManager
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * Keeps the screen on while a map screen is open (decision of 14 November). JS side:
 * `NativeModules.BabanaKeepAwake` (src/screenWake.ts). A window flag, not a wake lock: it only
 * holds while the app is on screen, and Android drops it by itself when the app leaves.
 */
class KeepAwakeModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {

  override fun getName(): String = "BabanaKeepAwake"

  @ReactMethod
  fun activate() {
    UiThreadUtil.runOnUiThread {
      context.currentActivity?.window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
  }

  @ReactMethod
  fun deactivate() {
    UiThreadUtil.runOnUiThread {
      context.currentActivity?.window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
  }
}
