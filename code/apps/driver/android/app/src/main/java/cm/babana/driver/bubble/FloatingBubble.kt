package cm.babana.driver.bubble

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import cm.babana.driver.MainActivity
import cm.babana.driver.R
import kotlin.math.abs

/**
 * Icône flottante du chauffeur en ligne (15 novembre) : l'app passée en arrière-plan, une bulle
 * ronde à l'icône de l'app reste par-dessus les autres apps ; un appui rouvre l'app, un glissé la
 * déplace. Exige l'autorisation « Afficher par-dessus les autres applis » (SYSTEM_ALERT_WINDOW),
 * demandée une fois par l'app. Android seulement.
 *
 * La même autorisation permet de ramener l'app au premier plan depuis l'arrière-plan
 * (`bringToFront`) : une proposition reçue app cachée l'affiche (réponse du maître d'ouvrage).
 */
object FloatingBubble {
  private var view: View? = null

  fun canDrawOverlays(context: Context): Boolean =
      Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)

  fun openPermissionSettings(context: Context) {
    val intent =
        Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
  }

  fun bringToFront(context: Context) {
    val intent =
        Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    context.startActivity(intent)
  }

  @SuppressLint("ClickableViewAccessibility")
  fun show(context: Context) {
    if (view != null || !canDrawOverlays(context)) return
    val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    val density = context.resources.displayMetrics.density
    val size = (56 * density).toInt()
    val params =
        WindowManager.LayoutParams(
            size,
            size,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
          gravity = Gravity.TOP or Gravity.START
          x = (8 * density).toInt()
          y = (160 * density).toInt()
        }
    val bubble =
        ImageView(context).apply {
          setImageResource(R.mipmap.ic_launcher_round)
          contentDescription = "Babana Pro -- revenir à l'app"
        }
    var startX = 0
    var startY = 0
    var touchX = 0f
    var touchY = 0f
    bubble.setOnTouchListener { touched, event ->
      when (event.action) {
        MotionEvent.ACTION_DOWN -> {
          startX = params.x
          startY = params.y
          touchX = event.rawX
          touchY = event.rawY
          true
        }
        MotionEvent.ACTION_MOVE -> {
          params.x = startX + (event.rawX - touchX).toInt()
          params.y = startY + (event.rawY - touchY).toInt()
          windowManager.updateViewLayout(touched, params)
          true
        }
        MotionEvent.ACTION_UP -> {
          // Un appui (pas un glissé) rouvre l'app.
          if (abs(event.rawX - touchX) < 10 * density && abs(event.rawY - touchY) < 10 * density) {
            bringToFront(context)
          }
          true
        }
        else -> false
      }
    }
    windowManager.addView(bubble, params)
    view = bubble
  }

  fun hide(context: Context) {
    val current = view ?: return
    val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    try {
      windowManager.removeView(current)
    } catch (_: IllegalArgumentException) {}
    view = null
  }
}
