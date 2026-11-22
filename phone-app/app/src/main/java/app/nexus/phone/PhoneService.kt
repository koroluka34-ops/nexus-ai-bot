package app.nexus.phone

import android.app.*
import android.content.Context
import android.content.Intent
import android.hardware.camera2.CameraManager
import android.os.Build
import android.os.IBinder
import java.net.HttpURLConnection
import java.net.URL

class PhoneService : Service() {
    @Volatile private var running = true
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel("nexus_phone", "NEXUS PHONE", NotificationManager.IMPORTANCE_LOW))
        val notification = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "nexus_phone") else Notification.Builder(this)
        startForeground(42, notification.setContentTitle("NEXUS PHONE подключён").setContentText("Ожидание команд от NEXUS").setSmallIcon(android.R.drawable.ic_dialog_info).build())
        Thread { pollLoop() }.start()
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY
    override fun onDestroy() { running = false; super.onDestroy() }

    private fun pollLoop() {
        while (running) {
            try {
                val prefs = getSharedPreferences("nexus_phone", MODE_PRIVATE)
                val id = prefs.getString("deviceId", null) ?: break
                val token = prefs.getString("deviceToken", null) ?: break
                val conn = (URL("https://nexus-ai-bot-kt4w.onrender.com/phone/commands?deviceId=$id").openConnection() as HttpURLConnection)
                conn.setRequestProperty("Authorization", "Bearer $token"); conn.connectTimeout = 10000; conn.readTimeout = 15000
                val json = org.json.JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
                val commands = json.getJSONArray("commands")
                for (i in 0 until commands.length()) execute(id, token, commands.getJSONObject(i))
                conn.disconnect()
            } catch (_: Exception) { }
            try { Thread.sleep(3000) } catch (_: InterruptedException) { }
        }
        stopSelf()
    }

    private fun execute(deviceId: String, token: String, command: org.json.JSONObject) {
        val id = command.optString("id")
        val action = command.optString("action")
        var ok = true; var message = "Выполнено"
        try {
            val p = command.optJSONObject("params") ?: org.json.JSONObject()
            when (action) {
                "set_timer" -> startActivity(Intent(AlarmClock.ACTION_SET_TIMER).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(AlarmClock.EXTRA_LENGTH, (p.optLong("durationMs") / 1000).toInt()).putExtra(AlarmClock.EXTRA_MESSAGE, p.optString("label", "NEXUS")).putExtra(AlarmClock.EXTRA_SKIP_UI, false))
                "set_alarm" -> startActivity(Intent(AlarmClock.ACTION_SET_ALARM).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(AlarmClock.EXTRA_HOUR, p.optInt("hour")).putExtra(AlarmClock.EXTRA_MINUTES, p.optInt("minute")).putExtra(AlarmClock.EXTRA_MESSAGE, p.optString("message", "NEXUS")).putExtra(AlarmClock.EXTRA_SKIP_UI, false))
                "open_app" -> {
                    val pkg = p.optString("packageName")
                    if (pkg !in setOf("com.google.android.youtube", "org.telegram.messenger")) throw SecurityException("Приложение не разрешено")
                    val launch = packageManager.getLaunchIntentForPackage(pkg) ?: throw IllegalStateException("Приложение не установлено")
                    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(launch)
                }
                "open_settings" -> startActivity(Intent(android.provider.Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                "torch" -> {
                    val camera = getSystemService(Context.CAMERA_SERVICE) as CameraManager
                    val cameraId = camera.cameraIdList.firstOrNull() ?: throw IllegalStateException("Фонарик недоступен")
                    camera.setTorchMode(cameraId, p.optBoolean("enabled"))
                }
                else -> throw IllegalArgumentException("Неизвестная команда")
            }
        } catch (e: Exception) { ok = false; message = e.message ?: "Ошибка выполнения" }
        try {
            val conn = (URL("https://nexus-ai-bot-kt4w.onrender.com/phone/result?deviceId=$deviceId").openConnection() as HttpURLConnection)
            conn.requestMethod = "POST"; conn.doOutput = true; conn.setRequestProperty("Authorization", "Bearer $token"); conn.setRequestProperty("Content-Type", "application/json")
            val body = org.json.JSONObject().put("commandId", id).put("ok", ok).put("message", message).toString()
            conn.outputStream.use { it.write(body.toByteArray()) }; conn.inputStream.close(); conn.disconnect()
        } catch (_: Exception) { }
    }
}
