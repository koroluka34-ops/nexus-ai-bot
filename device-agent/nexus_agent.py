#!/usr/bin/env python3
"""NEXUS Windows Agent — outbound-only, allowlisted desktop bridge."""
AGENT_VERSION = "2026.11.05-nexus-cursor-fix-3"
import base64
import json
import os
import subprocess
import time
import threading
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

def _send_windows_input(kind, code, down=True):
    """Send real relative mouse / key / button input through Win32 SendInput."""
    import ctypes
    from ctypes import wintypes

    ULONG_PTR = ctypes.c_size_t

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                    ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                    ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                    ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                    ("dwExtraInfo", ULONG_PTR)]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD),
                    ("wParamH", wintypes.WORD)]

    class INPUTUNION(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("union", INPUTUNION)]

    INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
    KEYEVENTF_KEYUP = 0x0002
    KEYEVENTF_SCANCODE = 0x0008
    MOUSEEVENTF_MOVE = 0x0001
    mouse_flags = {"left": (0x0002, 0x0004), "right": (0x0008, 0x0010)}
    key_codes = {
        "space": 0x20, "shift": 0x10, "ctrl": 0x11, "alt": 0x12,
        "escape": 0x1B, "tab": 0x09, "enter": 0x0D,
    }

    item = INPUT()
    if kind == "move":
        item.type = INPUT_MOUSE
        item.union.mi = MOUSEINPUT(int(code[0]), int(code[1]), 0, MOUSEEVENTF_MOVE, 0, 0)
    elif kind == "mouse":
        if code not in mouse_flags:
            raise ValueError("Недопустимая кнопка мыши")
        item.type = INPUT_MOUSE
        item.union.mi = MOUSEINPUT(0, 0, 0, mouse_flags[code][0 if down else 1], 0, 0)
    elif kind == "key":
        key = str(code).lower()
        vk = key_codes.get(key, ord(key.upper()) if len(key) == 1 and key.isalnum() else 0)
        if not vk:
            raise ValueError("Недопустимая клавиша: " + key)
        # Игры вроде Roblox могут игнорировать обычные VK-события.
        # Отправляем физические scan-code события через SendInput.
        scan = ctypes.windll.user32.MapVirtualKeyW(vk, 0)
        if not scan:
            raise ValueError("Не удалось определить scan-code для клавиши: " + key)
        item.type = INPUT_KEYBOARD
        flags = KEYEVENTF_SCANCODE | (0 if down else KEYEVENTF_KEYUP)
        item.union.ki = KEYBDINPUT(0, scan, flags, 0, 0)
    else:
        raise ValueError("Неизвестный тип ввода")
    send_input = ctypes.windll.user32.SendInput
    send_input.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
    send_input.restype = wintypes.UINT
    sent = send_input(1, ctypes.byref(item), ctypes.sizeof(INPUT))
    if sent != 1:
        raise OSError("Windows отклонила игровой ввод через SendInput")


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
        if not text:
            return {"result": "Пустой текст — нечего вводить."}
        # Ввод Unicode напрямую через Windows SendInput: не зависит от буфера обмена.
        import ctypes
        from ctypes import wintypes
        ULONG_PTR = ctypes.c_size_t
        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                        ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                        ("dwExtraInfo", ULONG_PTR)]
        class MOUSEINPUT(ctypes.Structure):
            _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                        ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                        ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]
        class HARDWAREINPUT(ctypes.Structure):
            _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD),
                        ("wParamH", wintypes.WORD)]
        class INPUTUNION(ctypes.Union):
            _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]
        class INPUT(ctypes.Structure):
            _fields_ = [("type", wintypes.DWORD), ("union", INPUTUNION)]
        INPUT_KEYBOARD = 1
        KEYEVENTF_KEYUP = 0x0002
        KEYEVENTF_UNICODE = 0x0004
        inputs = []
        encoded = text.encode("utf-16-le")
        for i in range(0, len(encoded), 2):
            code = int.from_bytes(encoded[i:i+2], "little")
            down = INPUT()
            down.type = INPUT_KEYBOARD
            down.union.ki = KEYBDINPUT(0, code, KEYEVENTF_UNICODE, 0, 0)
            up = INPUT()
            up.type = INPUT_KEYBOARD
            up.union.ki = KEYBDINPUT(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0)
            inputs.extend((down, up))
        array_type = INPUT * len(inputs)
        user32 = ctypes.windll.user32
        user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
        user32.SendInput.restype = wintypes.UINT
        input_array = array_type(*inputs)
        sent = user32.SendInput(len(inputs), input_array, ctypes.sizeof(INPUT))
        if sent != len(inputs):
            raise OSError("Windows SendInput ввёл не все символы: " + str(sent) + "/" + str(len(inputs)))
        return {"result": "Текст введён в активное окно Windows (" + str(len(text)) + " символов)."}
    if action in ("mouse_move", "mouse_click", "mouse_double", "mouse_scroll", "mouse_drag", "mouse_down", "mouse_up", "touch_move", "key_press", "key_down", "key_up", "hotkey"):
        import pyautogui
        pyautogui.FAILSAFE = True
        pyautogui.PAUSE = 0
        if action == "touch_move":
            # Игровая камера должна получать относительное движение мыши.
            # SetCursorPos лишь двигает курсор Windows и часто не вращает камеру в играх.
            dx, dy = int(args.get("dx", 0)), int(args.get("dy", 0))
            if abs(dx) > 500 or abs(dy) > 500:
                raise ValueError("Слишком большое движение тачпада")
            _send_windows_input("move", (dx, dy))
            return {"result": "Относительное движение мыши отправлено."}
        if action in ("key_down", "key_up"):
            key = str(args.get("key", "")).lower()
            allowed_game_keys = {"w","a","s","d","space","shift","ctrl","alt","e","q","f","r","1","2","3","4","5","6","7","8","9","escape","tab","enter","grave"}
            if key not in allowed_game_keys:
                raise ValueError("Игровая клавиша не разрешена")
            _send_windows_input("key", key, action == "key_down")
            return {"result": ("Удерживается: " if action == "key_down" else "Отпущена: ") + key}
        if action in ("mouse_down", "mouse_up"):
            button = args.get("button", "left")
            if button not in ("left", "right"):
                raise ValueError("Игровая кнопка мыши не разрешена")
            _send_windows_input("mouse", button, action == "mouse_down")
            return {"result": "Игровая кнопка мыши обновлена."}
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
            cursor_visible = True
            mobile_client = False
            class ScreenVideoTrack(VideoStreamTrack):
                kind = "video"
                def __init__(self):
                    super().__init__()
                    self.capture = mss.MSS()
                    self.monitor = self.capture.monitors[1]
                    self.frames = 0
                    self.video_started = None
                    self.video_pts = 0
                    print("WebRTC монитор:", self.monitor.get("width"), "x", self.monitor.get("height"))
                    print("WebRTC режим: до 854x480 на ПК / 720x405 на телефоне, цель 30 FPS")

                async def next_timestamp(self):
                    # 30 FPS с пропуском опоздавших слотов: не выдаём пачку кадров
                    # подряд после медленного захвата/кодирования.
                    import fractions
                    now = time.monotonic()
                    if self.video_started is None:
                        self.video_started = now
                        self.video_pts = 0
                    else:
                        self.video_pts += 3000  # 90000 / 30 FPS
                        target = self.video_started + self.video_pts / 90000
                        delay = target - now
                        if delay > 0:
                            await asyncio.sleep(delay)
                        elif delay < -(1 / 30):
                            # Пропускаем только реально потерянные интервалы;
                            # небольшая задержка планировщика не должна резать FPS пополам.
                            missed = int((-delay) / (1 / 30))
                            self.video_pts += max(1, missed) * 3000
                    return self.video_pts, fractions.Fraction(1, 90000)

                async def recv(self):
                    try:
                        pts, time_base = await self.next_timestamp()
                        # Захват вне event loop; создаём RGB напрямую, избегая лишних
                        # BGRA -> BGR -> RGB преобразований и повторной упаковки PIL.
                        raw = await asyncio.to_thread(self.capture.grab, self.monitor)
                        from PIL import Image, ImageDraw
                        rgb_image = Image.frombytes("RGB", raw.size, raw.rgb)
                        width, height = rgb_image.size
                        max_width, max_height = (720, 405) if mobile_client else (854, 480)
                        scale = min(1.0, max_width / width, max_height / height)
                        if scale < 1.0:
                            out_size = (max(1, int(width * scale)), max(1, int(height * scale)))
                            rgb_image = rgb_image.resize(out_size, Image.Resampling.BILINEAR)

                        # Рисуем указатель в том же RGB-буфере, без второго PIL/NumPy цикла.
                        try:
                            import ctypes
                            from ctypes import wintypes
                            class CursorPoint(ctypes.Structure):
                                _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]
                            cursor = CursorPoint()
                            if cursor_visible and ctypes.windll.user32.GetCursorPos(ctypes.byref(cursor)):
                                cx = int((cursor.x - int(self.monitor.get("left", 0))) * scale)
                                cy = int((cursor.y - int(self.monitor.get("top", 0))) * scale)
                                if 0 <= cx < rgb_image.width and 0 <= cy < rgb_image.height:
                                    draw = ImageDraw.Draw(rgb_image)
                                    k = max(0.8, scale)
                                    pointer = [(cx, cy), (cx, cy + int(17*k)),
                                        (cx + int(4*k), cy + int(13*k)),
                                        (cx + int(8*k), cy + int(21*k)),
                                        (cx + int(11*k), cy + int(19*k)),
                                        (cx + int(7*k), cy + int(12*k)),
                                        (cx + int(14*k), cy + int(12*k))]
                                    draw.polygon(pointer, fill=(255,255,255), outline=(0,0,0), width=2)
                        except Exception as cursor_exc:
                            if self.frames == 0:
                                print("Не удалось нарисовать курсор в видео:", repr(cursor_exc))

                        self.frames += 1
                        if self.frames == 1 or self.frames % 30 == 0:
                            print("WebRTC кадр", self.frames, "|", rgb_image.width, "x", rgb_image.height)
                        rgb = np.asarray(rgb_image)
                        frame = VideoFrame.from_ndarray(rgb, format="rgb24")
                        frame.pts = pts
                        frame.time_base = time_base
                        return frame
                    except Exception as exc:
                        print("Ошибка получения WebRTC кадра:", repr(exc))
                        raise
            pc = RTCPeerConnection(RTCConfiguration(iceServers=[RTCIceServer(urls=["stun:stun.l.google.com:19302"])]))
            @pc.on("iceconnectionstatechange")
            async def on_ice_state():
                print("WebRTC ICE:", pc.iceConnectionState, "| connection:", pc.connectionState)
            @pc.on("connectionstatechange")
            async def on_connection_state():
                print("WebRTC connection:", pc.connectionState, "| ICE:", pc.iceConnectionState)
            screen_track = ScreenVideoTrack()
            pc.addTrack(screen_track)

            held_keys, held_buttons = set(), set()
            cursor_target = None

            async def smooth_remote_cursor():
                # Сглаживаем движение, но не удерживаем курсор в старой
                # удалённой позиции: после достижения цели отдаём управление
                # локальной мыши Windows.
                nonlocal cursor_target
                import ctypes
                from ctypes import wintypes
                class CursorPoint(ctypes.Structure):
                    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]
                point = CursorPoint()
                user32 = ctypes.windll.user32
                while True:
                    try:
                        target = cursor_target
                        if target is not None and user32.GetCursorPos(ctypes.byref(point)):
                            dx, dy = target[0] - point.x, target[1] - point.y
                            distance = max(abs(dx), abs(dy))
                            if distance <= 2:
                                cursor_target = None
                            else:
                                # Меньший коэффициент и ограничение шага убирают резкие скачки.
                                step_x = max(-24, min(24, int(dx * 0.20)))
                                step_y = max(-24, min(24, int(dy * 0.20)))
                                if step_x == 0 and dx:
                                    step_x = 1 if dx > 0 else -1
                                if step_y == 0 and dy:
                                    step_y = 1 if dy > 0 else -1
                                user32.SetCursorPos(point.x + step_x, point.y + step_y)
                    except Exception as cursor_smooth_exc:
                        print("Ошибка сглаживания курсора:", repr(cursor_smooth_exc))
                    await asyncio.sleep(1 / 60)

            cursor_smooth_task = asyncio.create_task(smooth_remote_cursor())

            @pc.on("datachannel")
            def on_datachannel(channel):
                print("WebRTC канал управления открыт:", channel.label)
                @channel.on("message")
                def on_control_message(message):
                    nonlocal cursor_visible, mobile_client, cursor_target
                    try:
                        if isinstance(message, bytes):
                            message = message.decode("utf-8")
                        data = json.loads(message)
                        kind = data.get("type")
                        if kind == "client-profile":
                            if data.get("profile") == "mobile":
                                mobile_client = True
                                print("Профиль видео: телефон 720x405 / 30 FPS")
                            return
                        if kind == "cursor-visibility":
                            cursor_visible = bool(data.get("visible", True))
                            print("Курсор в видеопотоке:", "показан" if cursor_visible else "скрыт")
                            return
                        if kind == "cursor-position":
                            # Координаты нормализованы относительно видеокадра (0..1).
                            monitor = screen_track.monitor
                            nx = max(0.0, min(1.0, float(data.get("x", 0))))
                            ny = max(0.0, min(1.0, float(data.get("y", 0))))
                            px = int(monitor.get("left", 0) + nx * max(0, monitor["width"] - 1))
                            py = int(monitor.get("top", 0) + ny * max(0, monitor["height"] - 1))
                            cursor_target = (px, py)
                            return
                        if kind == "move":
                            dx, dy = int(data.get("dx", 0)), int(data.get("dy", 0))
                            if abs(dx) > 500 or abs(dy) > 500:
                                return
                            _send_windows_input("move", (dx, dy))
                            return
                        import pyautogui
                        pyautogui.PAUSE = 0
                        if kind == "game-key":
                            key, state = str(data.get("key", "")).lower(), data.get("state")
                            allowed = {"w","a","s","d","space","shift","ctrl","alt","e","q","f","r","g","1","2","3","4","5","6","7","8","9","escape","tab","enter"}
                            if key not in allowed or state not in ("down", "up"):
                                return
                            if state == "down":
                                if key not in held_keys:
                                    _send_windows_input("key", key, True); held_keys.add(key)
                                    print("Игровая клавиша нажата:", key)
                            elif key in held_keys:
                                _send_windows_input("key", key, False); held_keys.discard(key)
                                print("Игровая клавиша отпущена:", key)
                            return
                        if kind in ("game-mouse", "game-click"):
                            button = str(data.get("button", "left"))
                            if button not in ("left", "right"):
                                return
                            if kind == "game-click":
                                _send_windows_input("mouse", button, True)
                                _send_windows_input("mouse", button, False)
                            elif data.get("state") == "down":
                                if button not in held_buttons:
                                    _send_windows_input("mouse", button, True); held_buttons.add(button)
                            elif data.get("state") == "up" and button in held_buttons:
                                _send_windows_input("mouse", button, False); held_buttons.discard(button)
                    except Exception as control_exc:
                        print("Ошибка быстрого управления:", repr(control_exc))

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
                cursor_smooth_task.cancel()
                try:
                    import pyautogui
                    for key in list(held_keys):
                        try: pyautogui.keyUp(key)
                        except Exception: pass
                    for button in list(held_buttons):
                        try: pyautogui.mouseUp(button=button)
                        except Exception: pass
                except Exception: pass
                await pc.close()
                print("Видеотрансляция остановлена.")
        try:
            asyncio.run(run())
        except Exception as exc:
            print("Ошибка WebRTC:", repr(exc))
    threading.Thread(target=worker, daemon=True).start()

def webrtc_offer_listener(cfg):
    """Check WebRTC offers independently from the long-polling command loop."""
    while True:
        try:
            offer_data = request(cfg, "/device/webrtc/offer")
            offer = offer_data.get("offer")
            if offer:
                print("Получено предложение WebRTC:", offer.get("sessionId"))
                start_webrtc_stream(cfg, offer)
            else:
                time.sleep(0.25)
        except Exception as exc:
            print("Ошибка проверки WebRTC:", str(exc)[:250])
            time.sleep(3)


def main():
    cfg = load_config()
    print("NEXUS Agent", AGENT_VERSION, "| файл:", __file__)
    print("NEXUS Agent подключается к", cfg["server"])
    print("Остановка: Ctrl+C. Агент не принимает произвольные shell-команды.")
    threading.Thread(target=webrtc_offer_listener, args=(cfg,), daemon=True).start()
    print("Проверка WebRTC запущена отдельно от команд.")
    while True:
        try:
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
