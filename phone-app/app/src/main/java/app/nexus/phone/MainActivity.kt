package app.nexus.phone

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 48, 32, 24); gravity = Gravity.CENTER_HORIZONTAL }
        layout.addView(TextView(this).apply { text = "NEXUS PHONE"; textSize = 26f })
        layout.addView(TextView(this).apply { text = "Введи одноразовый код из Telegram, чтобы привязать этот телефон."; textSize = 16f; setPadding(0, 24, 0, 24) })
        val code = EditText(this).apply { hint = "Код подключения из NEXUS"; inputType = 2 }
        layout.addView(code)
        val button = Button(this).apply { text = "Подключить телефон" }
        layout.addView(button)
        val status = TextView(this).apply { text = "После подключения оставь приложение включённым, чтобы получать команды."; setPadding(0, 24, 0, 0) }
        layout.addView(status)
        setContentView(layout)
        button.setOnClickListener {
            val value = code.text.toString().trim()
            if (value.length != 6) { Toast.makeText(this, "Нужен шестизначный код", Toast.LENGTH_SHORT).show(); return@setOnClickListener }
            button.isEnabled = false
            Thread {
                try {
                    val connection = (java.net.URL("https://nexus-ai-bot-kt4w.onrender.com/phone/pair").openConnection() as java.net.HttpURLConnection)
                    connection.requestMethod = "POST"; connection.doOutput = true
                    connection.setRequestProperty("Content-Type", "application/json")
                    connection.outputStream.use { it.write("{\"code\":\"$value\",\"deviceName\":\"${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}\"}".toByteArray()) }
                    val response = connection.inputStream.bufferedReader().use { it.readText() }
                    val json = org.json.JSONObject(response)
                    getSharedPreferences("nexus_phone", MODE_PRIVATE).edit().putString("deviceId", json.getString("deviceId")).putString("deviceToken", json.getString("deviceToken")).apply()
                    runOnUiThread {
                        status.text = "Телефон привязан. NEXUS может отправлять команды. Разрешения Android будут запрашиваться отдельно по мере необходимости."
                        button.text = "Подключено"; button.isEnabled = true
                        startForegroundService(Intent(this, PhoneService::class.java))
                    }
                } catch (e: Exception) {
                    runOnUiThread { button.isEnabled = true; Toast.makeText(this, "Не удалось подключить: ${e.message}", Toast.LENGTH_LONG).show() }
                }
            }.start()
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), 101)
        }
    }
}
