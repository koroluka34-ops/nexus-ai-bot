#!/usr/bin/env python3
"""NEXUS Windows Agent — outbound-only, allowlisted desktop bridge."""
AGENT_VERSION = "2026.11.04-webrtc-debug1"
import base64
import json
import os
import subprocess
import time
import urllib.request
import urllib.error
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "agent-config.json"

def load_config():
    if CONFIG.exists():
        data = json.loads(CONFIG.read_text(encoding="utf-8"))
    else:
        print("Первый запуск NEXUS Agent")
        data = {
            "server": input("URL NEXUS (например https://nexus-ai-bot-kt4w.onrender.com): ").strip().rstrip("/"),
            "token": input("PC_AGENT_TOKEN из Render: ").strip(),
        }
        if not data["server"].startswith("https://") or len(data["token"]) < 32:
            raise SystemExit("Нужен HTTPS URL и токен длиной минимум 32 символа.")
        CONFIG.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        try: os.chmod(CONFIG, 0o600)
        except OSError: pass
    if not data.get("server", "").startswith("https://") or len(data.get("token", "")) < 32:
        raise SystemExit("Проверь agent-config.json: нужен HTTPS и корректный токен.")
    return data

def request(cfg, path, payload=None):
    raw = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(cfg["server"] + path, data=raw, method="GET" if payload is None else "POST",
        headers={"Authorization": "Bearer " + cfg["token"], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=35) as response:
        return json.loads(response.read().decode("utf-8"))

def execute(command):
    action, args = command["action"], command.get("args", {})
    if action == "screenshot":
        import pyautogui
        shot = pyautogui.screenshot()
        from io import BytesIO
        buf = BytesIO()
        shot.save(buf, format="PNG")
        return {"result": "Скриншот готов.", "image": base64.b64encode(buf.getvalue()).decode("ascii")}
    if action == "open_url":
        url = args.get("url", "")
        if not url.startswith(("https://", "http://")): raise ValueError("URL rejected")
        webbrowser.open(url, new=2)
        return {"result": "Сайт открыт в браузере."}
    if action == "launch":
        allowed = {"notepad": "notepad.exe", "calculator": "calc.exe", "paint": "mspaint.exe", "explorer": "explorer.exe"}
        app = args.get("app")
        if app not in allowed: raise ValueError("Application not allowed")
        subprocess.Popen([allowed[app]], shell=False)
        return {"result": "Запущено: " + app}
    if action == "type_text":
        text = str(args.get("text", ""))
        if len(text) > 1000: raise ValueError("Text too long")
        import pyautogui
        import pyperclip
        pyautogui.FAILSAFE = True
        pyperclip.copy(text)
        pyautogui.hotkey("ctrl", "v")
        return {"result": "Текст вставлен в активное окно."}
    if action in ("mouse_move", "mouse_click", "mouse_double", "mouse_scroll", "mouse_drag", "touch_move", "key_press", "hotkey"):
        import pyautogui
        pyautogui.FAILSAFE = True
        pyautogui.PAUSE = 0 if action == "touch_move" else 0.15
        if action == "touch_move":
            # PyAutoGUI ignores durations below MINIMUM_DURATION (default 0.1s).
            # Lower the threshold so short touchpad moves are genuinely interpolated.
            dx, dy = int(args.get("dx", 0)), int(args.get("dy", 0))
            if abs(dx) > 500 or abs(dy) > 500: raise ValueError("Слишком большое движение тачпада")
            # Instant relative movement avoids PyAutoGUI interpolation edge cases
            # that can raise ZeroDivisionError for very short durations.
            pyautogui.moveRel(dx, dy, duration=0)
            return {"result": "Курсор перемещён тачпадом."}
        if action == "mouse_move":
            x, y = int(args.get("x", -1)), int(args.get("y", -1))
            width, height = pyautogui.size()
            if not (0 <= x < width and 0 <= y < height):
                raise ValueError(f"Координаты вне экрана {width}x{height}")
            pyautogui.moveTo(x, y, duration=0.15)
            return {"result": f"Курсор перемещён: {x}, {y}."}
        if action == "mouse_click":
            button = args.get("button", "left")
            if button not in ("left", "right", "middle"): raise ValueError("Недопустимая кнопка мыши")
            pyautogui.click(button=button)
            return {"result": f"Нажатие мыши: {button}."}
        if action == "mouse_double":
            button = args.get("button", "left")
            if button not in ("left", "right"): raise ValueError("Недопустимая кнопка мыши")
            pyautogui.doubleClick(button=button)
            return {"result": "Двойной щелчок мышью."}
        if action == "mouse_scroll":
            direction = args.get("direction")
            amount = int(args.get("amount", 3))
            if direction not in ("up", "down") or not 1 <= amount <= 10:
                raise ValueError("Прокрутка: направление up/down, шаги 1–10")
            pyautogui.scroll(amount if direction == "up" else -amount)
            return {"result": f"Прокрутка {direction}: {amount}."}
        if action == "mouse_drag":
            x1, y1, x2, y2 = (int(args.get(k, -1)) for k in ("x1","y1","x2","y2"))
            width, height = pyautogui.size()
            if not all(0 <= x < width and 0 <= y < height for x,y in ((x1,y1),(x2,y2))):
                raise ValueError(f"Координаты вне экрана {width}x{height}")
            pyautogui.moveTo(x1, y1, duration=0.1)
            pyautogui.dragTo(x2, y2, duration=0.5, button="left")
            return {"result": f"Перетаскивание: {x1},{y1} → {x2},{y2}."}
        if action == "hotkey":
            combo = str(args.get("combo", ""))
            allowed_combos = {"ctrl+c","ctrl+v","ctrl+x","ctrl+z","ctrl+y","ctrl+a","ctrl+s","ctrl+f","ctrl+p","ctrl+w","ctrl+t","ctrl+tab","ctrl+shift+tab","alt+tab","alt+f4","win+d","win+e","ctrl+shift+esc"}
            if combo not in allowed_combos: raise ValueError("Сочетание клавиш не разрешено")
            pyautogui.hotkey(*combo.split("+"))
            return {"result": f"Нажато сочетание: {combo}."}
        key = args.get("key", "")
        allowed_keys = {"enter", "esc", "tab", "space", "backspace", "delete", "up", "down", "left", "right", "home", "end", "pageup", "pagedown"} | {f"f{i}" for i in range(1,13)}
        if key not in allowed_keys: raise ValueError("Клавиша не разрешена")
        pyautogui.press(key)
        return {"result": f"Нажата клавиша: {key}."}
    raise ValueError("Unknown action: " + repr(action) + "; args=" + repr(args)[:200])

def start_webrtc_stream(cfg, offer):
    import asyncio
    import threading
    def worker():
        async def run():
            from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer, VideoStreamTrack
            from av import VideoFrame
            import mss
            import numpy as np
            class ScreenVideoTrack(VideoStreamTrack):
                kind = "video"
                def __init__(self):
                    super().__init__()
                    self.capture = mss.MSS()
                    self.monitor = self.capture.monitors[1]
                    self.frames = 0
                    print("WebRTC монитор:", self.monitor.get("width"), "x", self.monitor.get("height"))
                async def recv(self):
                    pts, time_base = await self.next_timestamp()
                    shot = np.array(self.capture.grab(self.monitor))[:, :, :3]
                    height, width = shot.shape[:2]
                    scale = min(1.0, 1280 / width, 720 / height)
                    if scale < 1.0:
                        from PIL import Image
                        shot = np.array(Image.fromarray(shot).resize((int(width * scale), int(height * scale))))
                    self.frames += 1
                    if self.frames == 1 or self.frames % 60 == 0:
                        print("WebRTC кадр", self.frames, "|", shot.shape[1], "x", shot.shape[0], "| пиксели", int(shot.min()), "-", int(shot.max()))
                    frame = VideoFrame.from_ndarray(shot, format="BGR")
                    frame.pts = pts
                    frame.time_base = time_base
                    return frame
            pc = RTCPeerConnection(RTCConfiguration(iceServers=[RTCIceServer(urls=["stun:stun.l.google.com:19302"])]))
            @pc.on("iceconnectionstatechange")
            async def on_ice_state():
                print("WebRTC ICE:", pc.iceConnectionState, "| connection:", pc.connectionState)
            @pc.on("connectionstatechange")
            async def on_connection_state():
                print("WebRTC connection:", pc.connectionState, "| ICE:", pc.iceConnectionState)
            pc.addTrack(ScreenVideoTrack())
            await pc.setRemoteDescription(RTCSessionDescription(sdp=offer["sdp"], type=offer["type"]))
            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            request(cfg, "/device/webrtc/answer", {"sessionId": offer["sessionId"], "sdp": pc.localDescription.sdp, "type": pc.localDescription.type})
            print("WebRTC answer отправлен. Состояние:", pc.connectionState, "| ICE:", pc.iceConnectionState)
            try:
                while pc.connectionState not in ("failed", "closed"):
                    await asyncio.sleep(1)
                    if pc.connectionState == "disconnected":
                        await asyncio.sleep(5)
                        if pc.connectionState == "disconnected":
                            break
            finally:
                await pc.close()
                print("Видеотрансляция остановлена.")
        try:
            asyncio.run(run())
        except Exception as exc:
            print("Ошибка WebRTC:", repr(exc))
    threading.Thread(target=worker, daemon=True).start()

def main():
    cfg = load_config()
    print("NEXUS Agent", AGENT_VERSION, "| файл:", __file__)
    print("NEXUS Agent подключается к", cfg["server"])
    print("Остановка: Ctrl+C. Агент не принимает произвольные shell-команды.")
    last_screen_frame = 0
    while True:
        try:
            offer_data = request(cfg, "/device/webrtc/offer")
            if offer_data.get("offer"):
                start_webrtc_stream(cfg, offer_data["offer"])
            data = request(cfg, "/device/poll")
            command = data.get("command")
            if command:
                action_name = command.get("action") if isinstance(command, dict) else None
                print("Получена команда:", repr(action_name), "| поля:", list(command.keys()) if isinstance(command, dict) else type(command).__name__)
                try: result = execute(command)
                except Exception as exc:
                    print("Ошибка выполнения:", repr(exc))
                    result = {"result": "Ошибка: " + str(exc)[:500]}
                if command.get("id"):
                    result["id"] = command["id"]
                    request(cfg, "/device/result", result)
            else:
                time.sleep(max(0.005, min(5, data.get("pollAfterMs", 1800) / 1000)))
        except urllib.error.HTTPError as exc:
            print("HTTP", exc.code, "— проверь PC_AGENT_TOKEN в Render и agent-config.json")
            time.sleep(8)
        except Exception as exc:
            print("Связь недоступна:", str(exc)[:250])
            time.sleep(8)

if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: print("\nNEXUS Agent остановлен.")
