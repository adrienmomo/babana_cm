package cm.babana.driver.bubble

import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/** JS : `NativeModules.BabanaFloatingBubble` (src/floatingBubble.ts). */
class FloatingBubbleModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val main = Handler(Looper.getMainLooper())

  override fun getName(): String = "BabanaFloatingBubble"

  @ReactMethod
  fun canDrawOverlays(promise: Promise) {
    promise.resolve(FloatingBubble.canDrawOverlays(context))
  }

  @ReactMethod
  fun openPermissionSettings() {
    main.post { FloatingBubble.openPermissionSettings(context) }
  }

  @ReactMethod
  fun show() {
    main.post { FloatingBubble.show(context.applicationContext) }
  }

  @ReactMethod
  fun hide() {
    main.post { FloatingBubble.hide(context.applicationContext) }
  }

  @ReactMethod
  fun bringToFront() {
    main.post {
      try {
        FloatingBubble.bringToFront(context.applicationContext)
      } catch (_: Exception) {
        // Démarrage depuis l'arrière-plan refusé (autorisation retirée) : la sonnerie et la
        // notification restent le canal de la proposition.
      }
    }
  }
}
