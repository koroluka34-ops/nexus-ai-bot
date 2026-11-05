#!/usr/bin/env python3
"""NEXUS Windows Agent — outbound-only, allowlisted desktop bridge."""
AGENT_VERSION = "2026.11.05-voice-pc-19"
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
    if action == "inspect_ui":
        # Только чтение доступных имён элементов активного окна; никаких кликов/ввода.
        ps = r"""
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NexusForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
}
'@
$hwnd = [NexusForegroundWindow]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[NexusForegroundWindow]::GetWindowText($hwnd, $sb, $sb.Capacity) | Out-Null
$windowTitle = $sb.ToString()
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "Не удалось определить активное окно."; exit 0 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
if ($null -eq $root) { Write-Output ("Окно: " + $windowTitle + [Environment]::NewLine + "UI Automation недоступна для этого окна."); exit 0 }
$items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("Активное окно: " + $windowTitle)
$interesting = @("ControlType.Edit","ControlType.ComboBox","ControlType.Button","ControlType.TabItem","ControlType.CheckBox","ControlType.RadioButton","ControlType.Document","ControlType.SplitButton","ControlType.MenuItem")
$controls = New-Object System.Collections.Generic.List[object]
for ($i=0; $i -lt $items.Count; $i++) {
  $el = $items.Item($i)
  try {
    $type = [string]$el.Current.ControlType.ProgrammaticName
    if ($interesting -notcontains $type) { continue }
    $r = $el.Current.BoundingRectangle
    $isOffscreen = [bool]$el.Current.IsOffscreen
    $name = [string]$el.Current.Name
    $focused = [bool]$el.Current.HasKeyboardFocus
    $focusable = [bool]$el.Current.IsKeyboardFocusable
    # Сохраняем элементы ввода даже если UIA считает их частично скрытыми.
    if ($isOffscreen -and $type -ne "ControlType.Edit" -and $type -ne "ControlType.Document") { continue }
    if ($r.Width -le 0 -or $r.Height -le 0) { continue }
    $controls.Add([pscustomobject]@{Type=$type;Name=$name;X=[int]$r.X;Y=[int]$r.Y;W=[int]$r.Width;H=[int]$r.Height;Enabled=[bool]$el.Current.IsEnabled;Focused=$focused;Focusable=$focusable;Offscreen=$isOffscreen})
  } catch {}
}
# Сначала показываем поля ввода и элементы, имеющие фокус; сообщения переписки не выводим.
$ordered = @($controls | Sort-Object @{Expression={ if ($_.Type -eq "ControlType.Edit" -or $_.Type -eq "ControlType.Document") {0} elseif ($_.Focused) {1} else {2} }}, Y, X)
foreach ($c in ($ordered | Select-Object -First 80)) {
  $safeName = ([string]$c.Name).Replace([char]34, [char]39)
  if ($safeName.Length -gt 100) { $safeName = $safeName.Substring(0,100) }
  $flags = "enabled=" + $c.Enabled + ", focused=" + $c.Focused + ", focusable=" + $c.Focusable + ", offscreen=" + $c.Offscreen
  $bounds = "x={0}, y={1}, w={2}, h={3}" -f $c.X,$c.Y,$c.W,$c.H
  $lines.Add(("{0}: '{1}' [{2}] {3}" -f $c.Type,$safeName,$bounds,$flags))
}
if ($controls.Count -eq 0) { $lines.Add("Интерактивные элементы UI Automation не обнаружены. Возможно, Telegram рисует поле ввода нестандартным способом.") }
$lines | Select-Object -First 85
"""
        try:
            proc = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20, shell=False)
        except subprocess.TimeoutExpired:
            raise RuntimeError("Проверка интерфейса превысила 20 секунд.")
        output = (proc.stdout or "").strip()
        if proc.returncode != 0:
            detail = (proc.stderr or output or "неизвестная ошибка").strip()
            raise RuntimeError("Windows UI Automation: " + detail[-700:])
        return {"result": output[:5000] or "Windows не вернула список элементов. Открой TurboVPN и повтори проверку."}

    if action == "pc_info":
        import psutil
        battery = None
        try:
            b = psutil.sensors_battery()
            if b is not None: battery = {"percent": round(b.percent), "plugged": bool(b.power_plugged)}
        except Exception: pass
        mem = psutil.virtual_memory()
        disks = []
        for part in psutil.disk_partitions(all=False):
            try:
                usage = psutil.disk_usage(part.mountpoint)
                disks.append({"drive": part.device, "free_gb": round(usage.free / (1024**3), 1), "total_gb": round(usage.total / (1024**3), 1)})
            except Exception: pass
        cpu = psutil.cpu_percent(interval=0.25)
        lines = ["CPU: " + str(cpu) + "%", "ОЗУ: " + str(round(mem.percent)) + "% (" + str(round(mem.used/(1024**3),1)) + "/" + str(round(mem.total/(1024**3),1)) + " ГБ)"]
        if battery: lines.append("Батарея: " + str(battery["percent"]) + "%" + (" (заряжается)" if battery["plugged"] else ""))
        if disks: lines.append("Диски: " + "; ".join(x["drive"] + " свободно " + str(x["free_gb"]) + " из " + str(x["total_gb"]) + " ГБ" for x in disks[:4]))
        return {"result": " | ".join(lines)}
    if action == "media_control":
        command = str(args.get("command", "")).lower()
        keys = {"play_pause": 0xB3, "next": 0xB0, "previous": 0xB1, "stop": 0xB2}
        if command not in keys: raise ValueError("Неизвестная команда медиаплеера.")
        import ctypes
        from ctypes import wintypes
        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]
        class INPUTUNION(ctypes.Union): _fields_ = [("ki", KEYBDINPUT), ("padding", ctypes.c_byte * 32)]
        class INPUT(ctypes.Structure): _fields_ = [("type", wintypes.DWORD), ("union", INPUTUNION)]
        inp = INPUT(); inp.type = 1; inp.union.ki = KEYBDINPUT(keys[command], 0, 0, 0, 0)
        ctypes.windll.user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
        return {"result": {"play_pause":"Пауза/воспроизведение","next":"Следующий трек","previous":"Предыдущий трек","stop":"Остановка"}[command] + " выполнено."}
    if action == "show_desktop":
        import ctypes
        ctypes.windll.user32.keybd_event(0x5B, 0, 0, 0)
        ctypes.windll.user32.keybd_event(0x44, 0, 0, 0)
        ctypes.windll.user32.keybd_event(0x44, 0, 2, 0)
        ctypes.windll.user32.keybd_event(0x5B, 0, 2, 0)
        return {"result": "Рабочий стол показан."}
    if action == "screenshot":
        import pyautogui
        shot = pyautogui.screenshot()
        from io import BytesIO
        buf = BytesIO()
        shot.save(buf, format="PNG")
        return {"result": "Скриншот готов.", "image": base64.b64encode(buf.getvalue()).decode("ascii")}
    if action == "open_app":
        app = str(args.get("app", "")).strip()
        if not app or len(app) > 80 or any(ch in app for ch in '\\/:*?"<>|'):
            raise ValueError("Недопустимое название приложения")
        import re
        def norm(value):
            value = str(value).casefold().replace("ё", "е")
            # Транслитерация русской речи, если распознавание записало английское имя кириллицей.
            translit = {"а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ж":"zh","з":"z","и":"i","й":"y","к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f","х":"h","ц":"ts","ч":"ch","ш":"sh","щ":"sch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya"}
            value = "".join(translit.get(ch, ch) for ch in value)
            return re.sub(r"[^a-z0-9]+", "", value)
        wanted = norm(app)
        # Common Russian nicknames and Whisper/ASR variants for installed apps.
        aliases = {
            "telegram": ["телега", "телеграм", "телеграмма", "телеграмм", "телеграмчик"],
            "discord": ["дискорд", "дискордик", "дискордд"],
            "turbovpn": ["турбо впн", "турбовпн", "турбо vpn", "турбо в п н"],
            "millidalauncher": ["меллида", "мелида лаунчер", "миллида лаунчер", "мильида лаунчер"],
            "roblox": ["роблокс", "роблоксс"],
            "spotify": ["спотифай", "спотифай"],
            "steam": ["стим"],
            "chrome": ["хром", "гугл хром"]
        }
        for canonical, variants in aliases.items():
            if wanted == canonical or wanted in {norm(v) for v in variants}:
                wanted = canonical
                break
        from difflib import SequenceMatcher
        def best_matches(items, get_name, threshold=0.76, margin=0.055):
            # Windows may expose the same shortcut twice (per-user and all-users
            # Start Menu). Collapse identical display names before ambiguity checks.
            unique = {}
            for item in items:
                candidate = norm(get_name(item))
                if not candidate:
                    continue
                score = SequenceMatcher(None, wanted, candidate).ratio()
                if candidate == wanted:
                    score = 1.0
                elif len(wanted) >= 5 and candidate.startswith(wanted):
                    # e.g. "Telegram" should resolve to the installed "Telegram Desktop".
                    score = max(score, 0.91)
                elif len(wanted) >= 5 and wanted in candidate:
                    score = max(score, 0.86)
                previous = unique.get(candidate)
                if previous is None or score > previous[0]:
                    unique[candidate] = (score, item)
            scored = list(unique.values())
            if not scored:
                return []
            scored.sort(key=lambda pair: pair[0], reverse=True)
            top_score = scored[0][0]
            if top_score < threshold:
                return []
            return [item for score, item in scored if score >= threshold and top_score - score < margin]
        roots = [
            Path.home() / "AppData/Roaming/Microsoft/Windows/Start Menu/Programs",
            Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "Microsoft/Windows/Start Menu/Programs",
        ]
        shortcuts = []
        for root in roots:
            if root.is_dir():
                try: shortcuts.extend(p for p in root.rglob("*.lnk") if p.is_file())
                except OSError: pass
        matches = best_matches(shortcuts, lambda p: p.stem)
        if len(matches) == 1:
            os.startfile(str(matches[0]))
            return {"result": "Открыто приложение: " + matches[0].stem}
        if len(matches) > 1:
            raise ValueError("Нашёл несколько похожих ярлыков: " + ", ".join(p.stem for p in matches[:6]) + ". Уточни название.")
        # Получаем список приложений Windows безопасной фиксированной командой.
        ps = r"[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $OutputEncoding = New-Object System.Text.UTF8Encoding($false); Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"
        try:
            proc = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15, shell=False)
            rows = json.loads(proc.stdout) if proc.returncode == 0 and proc.stdout.strip() else []
            if isinstance(rows, dict): rows = [rows]
            matches = best_matches(rows, lambda x: x.get("Name", ""))
            if len(matches) == 1 and matches[0].get("AppID"):
                subprocess.Popen(["explorer.exe", "shell:AppsFolder\\" + str(matches[0]["AppID"])], shell=False)
                return {"result": "Открываю приложение: " + str(matches[0].get("Name", app))}
            if len(matches) > 1:
                raise ValueError("Нашёл несколько похожих приложений: " + ", ".join(str(x.get("Name", "")) for x in matches[:6]) + ". Уточни название.")
        except subprocess.TimeoutExpired:
            print("Поиск приложений Windows превысил лимит времени.")
        # Резервный поиск exe в записях установленных программ.
        try:
            import winreg
            locations = [
                (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
                (winreg.HKEY_LOCAL_MACHINE, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
                (winreg.HKEY_LOCAL_MACHINE, r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
            ]
            found = []
            for hive, key_path in locations:
                try:
                    with winreg.OpenKey(hive, key_path) as parent:
                        for i in range(winreg.QueryInfoKey(parent)[0]):
                            try:
                                with winreg.OpenKey(parent, winreg.EnumKey(parent, i)) as item:
                                    display = str(winreg.QueryValueEx(item, "DisplayName")[0])
                                    if display:
                                        icon = str(winreg.QueryValueEx(item, "DisplayIcon")[0])
                                        exe = os.path.expandvars(icon.strip().strip('"').split(",")[0])
                                        path = Path(exe)
                                        if path.is_file() and path.suffix.lower() == ".exe":
                                            found.append((display, path))
                            except (OSError, ValueError): pass
                except OSError: pass
            found = best_matches(found, lambda x: x[0])
            if len(found) == 1:
                os.startfile(str(found[0][1]))
                return {"result": "Открываю приложение: " + found[0][0]}
            if len(found) > 1:
                raise ValueError("Нашёл несколько похожих установленных программ: " + ", ".join(x[0] for x in found[:6]) + ". Уточни название.")
        except ImportError: pass
        raise ValueError("Не нашёл установленное приложение «" + app + "». Проверь название или произношение.")
    if action == "close_app":
        app = str(args.get("app", "")).strip()
        if not app or len(app) > 80 or any(ch in app for ch in '\\/:*?"<>|'):
            raise ValueError("Недопустимое название приложения")
        import ctypes
        import re
        from ctypes import wintypes
        from difflib import SequenceMatcher
        def norm(value):
            value = str(value).casefold().replace("ё", "е")
            translit = {"а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ж":"zh","з":"z","и":"i","й":"y","к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f","х":"h","ц":"ts","ч":"ch","ш":"sh","щ":"sch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya"}
            value = "".join(translit.get(ch, ch) for ch in value)
            return re.sub(r"[^a-z0-9]+", "", value)
        aliases = {
            "millidalauncher": ["меллида", "мелида", "миллида", "мильида", "меллида лаунчер", "мелида лаунчер", "миллида лаунчер", "мильида лаунчер"],
            "telegram": ["телега", "телеграм", "телеграмма", "телеграмм"],
            "discord": ["дискорд", "дискордик"],
            "turbovpn": ["турбо впн", "турбовпн"],
            "roblox": ["роблокс"],
            "spotify": ["спотифай"],
            "steam": ["стим"],
        }
        wanted = norm(app)
        for canonical, variants in aliases.items():
            if wanted == norm(canonical) or wanted in {norm(v) for v in variants}:
                wanted = norm(canonical)
                break
        user32 = ctypes.windll.user32
        WM_CLOSE = 0x0010
        SMTO_ABORTIFHUNG = 0x0002
        current_pid = os.getpid()
        protected = {"explorer.exe", "dwm.exe", "sihost.exe", "startmenuexperiencehost.exe",
            "shellexperiencehost.exe", "searchhost.exe", "textinputhost.exe", "lockapp.exe",
            "cmd.exe", "powershell.exe", "pwsh.exe", "windowsterminal.exe", "wt.exe",
            "conhost.exe", "openconsole.exe", "python.exe", "pythonw.exe"}
        matches = []
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def enum_window(hwnd, _):
            try:
                if not user32.IsWindowVisible(hwnd):
                    return True
                length = user32.GetWindowTextLengthW(hwnd)
                if length <= 0:
                    return True
                title = ctypes.create_unicode_buffer(min(length + 1, 512))
                user32.GetWindowTextW(hwnd, title, len(title))
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                if pid.value == current_pid:
                    return True
                handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid.value)
                process_name = ""
                if handle:
                    try:
                        image_path = ctypes.create_unicode_buffer(1024)
                        size = wintypes.DWORD(len(image_path))
                        if ctypes.windll.kernel32.QueryFullProcessImageNameW(handle, 0, image_path, ctypes.byref(size)):
                            process_name = os.path.basename(image_path.value)
                    finally:
                        ctypes.windll.kernel32.CloseHandle(handle)
                if process_name.lower() in protected:
                    return True
                title_candidate = norm(title.value)
                process_candidate = norm(Path(process_name).stem)
                def candidate_score(candidate):
                    if not candidate:
                        return 0.0
                    if candidate == wanted:
                        return 1.0
                    return max(SequenceMatcher(None, wanted, candidate).ratio(),
                        0.91 if len(wanted) >= 5 and candidate.startswith(wanted) else 0.0,
                        0.86 if len(wanted) >= 5 and wanted in candidate else 0.0)
                # Prefer the visible title; process name is only a fallback.
                score = candidate_score(title_candidate)
                if score < 0.76:
                    score = candidate_score(process_candidate)
                if score >= 0.76:
                    matches.append((hwnd, title.value[:100], score, pid.value))
            except Exception:
                pass
            return True
        callback = callback_type(enum_window)
        user32.EnumWindows(callback, 0)
        if not matches:
            raise ValueError("Не нашёл открытое окно приложения «" + app + "».")
        # Collapse multiple top-level windows belonging to one process.
        by_pid = {}
        for item in matches:
            if item[3] not in by_pid or item[2] > by_pid[item[3]][2]:
                by_pid[item[3]] = item
        matches = sorted(by_pid.values(), key=lambda item: item[2], reverse=True)
        if len(matches) > 1 and matches[0][2] - matches[1][2] < 0.055:
            distinct = list(dict.fromkeys(item[1] for item in matches[:5]))
            raise ValueError("Нашёл несколько похожих приложений: " + ", ".join(distinct) + ". Уточни название.")
        best_score = matches[0][2]
        targets = [item for item in matches if best_score - item[2] < 0.055]
        for hwnd, _title, _score, _pid in targets:
            result = wintypes.DWORD()
            user32.SendMessageTimeoutW(hwnd, WM_CLOSE, 0, 0, SMTO_ABORTIFHUNG, 1500, ctypes.byref(result))
        return {"result": "Отправил обычный запрос на закрытие приложения «" + app + "» (" + str(len(targets)) + " окно/окна). Несохранённые данные можно сохранить в самом приложении; принудительное завершение не выполнялось."}
    if action == "close_all_apps":
        # Graceful close only: WM_CLOSE lets each application show its own
        # unsaved-work prompt. Never force-kill processes or bypass dialogs.
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        WM_CLOSE = 0x0010
        SMTO_ABORTIFHUNG = 0x0002
        current_pid = os.getpid()
        shell_processes = {"explorer.exe", "dwm.exe", "sihost.exe",
            "startmenuexperiencehost.exe", "shellexperiencehost.exe",
            "searchhost.exe", "textinputhost.exe", "lockapp.exe",
            "cmd.exe", "powershell.exe", "pwsh.exe", "windowsterminal.exe",
            "wt.exe", "conhost.exe", "openconsole.exe", "python.exe", "pythonw.exe"}
        closed, skipped = [], []
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def close_window(hwnd, _):
            try:
                if not user32.IsWindowVisible(hwnd):
                    return True
                length = user32.GetWindowTextLengthW(hwnd)
                if length <= 0:
                    return True
                title = ctypes.create_unicode_buffer(min(length + 1, 512))
                user32.GetWindowTextW(hwnd, title, len(title))
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                if pid.value == current_pid:
                    return True
                process_name = ""
                PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
                handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
                if handle:
                    try:
                        image_path = ctypes.create_unicode_buffer(1024)
                        size = wintypes.DWORD(len(image_path))
                        if ctypes.windll.kernel32.QueryFullProcessImageNameW(handle, 0, image_path, ctypes.byref(size)):
                            process_name = os.path.basename(image_path.value).lower()
                    finally:
                        ctypes.windll.kernel32.CloseHandle(handle)
                if process_name in shell_processes:
                    return True
                result = wintypes.DWORD()
                user32.SendMessageTimeoutW(hwnd, WM_CLOSE, 0, 0, SMTO_ABORTIFHUNG, 1500, ctypes.byref(result))
                closed.append(title.value[:100])
            except Exception as exc:
                skipped.append(str(exc)[:100])
            return True
        callback = callback_type(close_window)
        user32.EnumWindows(callback, 0)
        return {"result": "Отправил обычное закрытие для " + str(len(closed)) + " окон. Если в приложениях есть несохранённые данные, Windows покажет запрос на сохранение. Принудительное завершение не выполнялось."}
    if action == "set_volume":
        mode = str(args.get("mode", "set")).lower()
        if mode == "set":
            value = args.get("percent")
            if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value or not 0 <= int(value) <= 100:
                raise ValueError("Громкость должна быть от 0 до 100 процентов.")
            value = int(value)
        elif mode in ("up", "down"):
            value = args.get("amount", 10)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value or not 1 <= int(value) <= 100:
                raise ValueError("Шаг изменения громкости должен быть от 1 до 100.")
            value = int(value)
        else:
            raise ValueError("Неизвестный режим изменения громкости.")
        ps_script = r"""
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    int GetDevice(string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, out IAudioEndpointVolume endpoint);
    int OpenPropertyStore(int stgm, out IntPtr properties);
    int GetId(out IntPtr id);
    int GetState(out int state);
}
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr notify);
    int UnregisterControlChangeNotify(IntPtr notify);
    int GetChannelCount(out uint count);
    int SetMasterVolumeLevel(float level, ref Guid eventContext);
    int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
    int GetMasterVolumeLevel(out float level);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint channel, float level, ref Guid eventContext);
    int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
    int GetChannelVolumeLevel(uint channel, out float level);
    int GetChannelVolumeLevelScalar(uint channel, out float level);
    int SetMute(bool mute, ref Guid eventContext);
    int GetMute(out bool mute);
    int GetVolumeStepInfo(out uint step, out uint stepCount);
    int VolumeStepUp(ref Guid eventContext);
    int VolumeStepDown(ref Guid eventContext);
    int QueryHardwareSupport(out uint hardwareSupportMask);
    int GetVolumeRange(out float min, out float max, out float increment);
}
public static class NexusVolume {
    private static IAudioEndpointVolume GetEndpoint() {
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        IMMDevice device;
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        IAudioEndpointVolume volume;
        Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out volume));
        return volume;
    }
    public static float Get() {
        float scalar;
        Marshal.ThrowExceptionForHR(GetEndpoint().GetMasterVolumeLevelScalar(out scalar));
        return scalar;
    }
    public static void Set(float scalar) {
        Guid eventGuid = Guid.Empty;
        Marshal.ThrowExceptionForHR(GetEndpoint().SetMasterVolumeLevelScalar(scalar, ref eventGuid));
    }
}
'@
$current = [NexusVolume]::Get()
$mode = '__MODE__'
$value = __VALUE__
if ($mode -eq 'set') { $target = $value / 100.0 }
elseif ($mode -eq 'up') { $target = [Math]::Min(1.0, $current + ($value / 100.0)) }
else { $target = [Math]::Max(0.0, $current - ($value / 100.0)) }
[NexusVolume]::Set([float]$target)
Write-Output ('NEXUS_VOLUME_RESULT=' + [Math]::Round($target * 100))
""".replace("__MODE__", mode).replace("__VALUE__", str(value))
        powershell = __import__("shutil").which("powershell.exe") or __import__("shutil").which("powershell")
        if not powershell:
            raise RuntimeError("Не найден Windows PowerShell.")
        proc = subprocess.run([powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps_script],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20, shell=False)
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "неизвестная ошибка").strip()[-700:]
            raise RuntimeError("Не удалось изменить системную громкость: " + detail)
        import re
        match = re.search(r"NEXUS_VOLUME_RESULT=(\d+)", proc.stdout or "")
        actual = int(match.group(1)) if match else (value if mode == "set" else None)
        if actual is None:
            return {"result": "Громкость Windows изменена."}
        return {"result": "Громкость Windows: " + str(actual) + "%."}
    if action in ("shutdown_pc", "restart_pc", "sleep_pc", "lock_pc"):
        if action == "shutdown_pc":
            subprocess.Popen(["shutdown.exe", "/s", "/t", "0"], shell=False)
            return {"result": "Компьютер выключается."}
        if action == "restart_pc":
            subprocess.Popen(["shutdown.exe", "/r", "/t", "0"], shell=False)
            return {"result": "Компьютер перезагружается."}
        if action == "sleep_pc":
            import ctypes
            ctypes.windll.powrprof.SetSuspendState(False, True, False)
            return {"result": "Компьютер переводится в спящий режим."}
        import ctypes
        if not ctypes.windll.user32.LockWorkStation():
            raise OSError("Windows не смогла заблокировать компьютер.")
        return {"result": "Компьютер заблокирован."}
    if action == "install_app":
        app_name = str(args.get("query", "")).strip()
        if not app_name or len(app_name) > 80 or any(ch in app_name for ch in '\\/:*?"<>|'):
            raise ValueError("Недопустимое название приложения для установки.")
        winget = __import__("shutil").which("winget")
        if not winget:
            raise RuntimeError("Не найден winget (Установщик приложений).")
        try:
            proc = subprocess.run([winget, "install", "--name", app_name, "--exact", "--source", "winget",
                "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity"],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900, shell=False)
        except subprocess.TimeoutExpired:
            raise RuntimeError("Установка «" + app_name + "» превысила лимит 15 минут.")
        output = ((proc.stdout or "") + "\\n" + (proc.stderr or "")).strip()
        if proc.returncode != 0:
            raise RuntimeError("Не удалось установить «" + app_name + "». " + (output[-1000:] if output else "winget завершился с кодом " + str(proc.returncode)))
        return {"result": "Приложение «" + app_name + "» установлено через winget."}
    if action == "uninstall_app":
        app_name = str(args.get("app", "")).strip()
        if not app_name or len(app_name) > 80 or any(ch in app_name for ch in '\\/:*?"<>|'):
            raise ValueError("Недопустимое название приложения для удаления.")
        winget = __import__("shutil").which("winget")
        if not winget:
            raise RuntimeError("Не найден winget (Установщик приложений).")
        proc = subprocess.run([winget, "uninstall", "--name", app_name, "--exact",
            "--accept-source-agreements", "--disable-interactivity"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900, shell=False)
        output = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
        if proc.returncode != 0:
            raise RuntimeError("Не удалось удалить «" + app_name + "». " + (output[-1000:] if output else "winget завершился с кодом " + str(proc.returncode)))
        return {"result": "Команда удаления приложения «" + app_name + "» выполнена."}
    if action == "open_folder":
        folders = {
            "downloads": "Downloads",
            "desktop": "Desktop",
            "documents": "Documents",
            "pictures": "Pictures",
            "videos": "Videos",
            "music": "Music",
        }
        name = str(args.get("folder", "")).lower()
        if name not in folders:
            raise ValueError("Folder not allowed")
        folder_path = Path.home() / folders[name]
        if not folder_path.is_dir():
            raise ValueError("Папка не найдена: " + str(folder_path))
        os.startfile(str(folder_path))
        return {"result": "Открыта папка: " + folders[name]}

    if action == "open_store":
        subprocess.Popen(["explorer.exe", "ms-windows-store://home"], shell=False)
        return {"result": "Открыт Microsoft Store."}
    if action == "open_store_search":
        query = str(args.get("query", "")).strip()
        if not query or len(query) > 80 or any(ch in query for ch in '\\\\/:*?"<>|'):
            raise ValueError("Недопустимое название приложения для Microsoft Store.")
        from urllib.parse import quote
        store_uri = "ms-windows-store://search/?query=" + quote(query)
        subprocess.Popen(["explorer.exe", store_uri], shell=False)
        return {"result": "Microsoft Store открыт. Поиск приложения: " + query + ". Нажми «Получить» или «Установить» в самом Store."}
    if action == "install_store_app":
        app_name = str(args.get("query", "")).strip()
        if not app_name or len(app_name) > 80 or any(ch in app_name for ch in '\\\\/:*?"<>|'):
            raise ValueError("Недопустимое название приложения.")
        winget = __import__("shutil").which("winget")
        if not winget:
            raise RuntimeError("На компьютере не найден winget. Обнови или установи «Установщик приложений» (App Installer) из Microsoft Store.")
        print("Поиск точного приложения в Microsoft Store через winget:", app_name)
        try:
            proc = subprocess.run(
                [winget, "install", "--name", app_name, "--source", "msstore", "--exact",
                 "--accept-source-agreements", "--accept-package-agreements"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=900, shell=False
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError("Установка не завершилась за 15 минут. Проверь Microsoft Store и подключение к интернету.")
        output = ((proc.stdout or "") + "\\n" + (proc.stderr or "")).strip()
        if proc.returncode != 0:
            detail = output[-1200:] if output else "winget завершился с кодом " + str(proc.returncode)
            raise RuntimeError("Не удалось установить «" + app_name + "» из Microsoft Store. " + detail)
        print("Установка завершена. Ищу ярлык приложения для запуска:", app_name)
        roots = [
            Path.home() / "AppData/Roaming/Microsoft/Windows/Start Menu/Programs",
            Path(os.environ.get("PROGRAMDATA", r"C:\\ProgramData")) / "Microsoft/Windows/Start Menu/Programs",
        ]
        shortcuts = []
        for root in roots:
            if root.is_dir():
                try:
                    shortcuts.extend(p for p in root.rglob("*.lnk") if p.is_file())
                except OSError:
                    pass
        exact = [p for p in shortcuts if p.stem.casefold() == app_name.casefold()]
        partial = [p for p in shortcuts if app_name.casefold() in p.stem.casefold()]
        matches = exact or partial
        if len(matches) == 1:
            os.startfile(str(matches[0]))
            return {"result": "Приложение «" + app_name + "» установлено и запущено."}
        if len(matches) > 1:
            return {"result": "Приложение «" + app_name + "» установлено, но найдено несколько ярлыков. Открой его через меню «Пуск»."}
        return {"result": "Приложение «" + app_name + "» установлено. Ярлык для автоматического запуска не найден — открой его через меню «Пуск»."}
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
    if action == "telegram_send_message":
        recipient = str(args.get("recipient", "")).strip()
        message = str(args.get("text", "")).strip()
        if not recipient or len(recipient) > 80 or not message or len(message) > 1000:
            raise ValueError("Некорректный контакт или текст сообщения Telegram")
        # Строгая проверка активного окна: не отправлять сообщение в другой чат.
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        title_buf = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, title_buf, 512)
        window_title = title_buf.value
        if not window_title or recipient.casefold() not in window_title.casefold():
            raise RuntimeError("Открыт не тот чат Telegram. Ожидался контакт «" + recipient + "», активное окно: " + (window_title or "не определено") + ". Открой нужный чат и повтори.")
        # Находим именно поле «Сообщение...» средствами UI Automation, не используем догаданные координаты.
        ps = r"""
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NexusForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$hwnd = [NexusForegroundWindow]::GetForegroundWindow()
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
if ($null -eq $root) { exit 3 }
$items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$found = $null
for ($i=0; $i -lt $items.Count; $i++) {
  $el = $items.Item($i)
  try {
    if ([string]$el.Current.ControlType.ProgrammaticName -eq "ControlType.Edit" -and [string]$el.Current.Name -eq "Сообщение..." -and -not $el.Current.IsOffscreen -and $el.Current.IsEnabled) {
      $r = $el.Current.BoundingRectangle
      if ($r.Width -gt 0 -and $r.Height -gt 0) { $found = $el; break }
    }
  } catch {}
}
if ($null -eq $found) { Write-Output "Поле ввода Telegram «Сообщение...» не найдено."; exit 4 }
try { $found.SetFocus() } catch {}
$r = $found.Current.BoundingRectangle
Write-Output ("{0},{1},{2},{3}" -f [int]$r.X,[int]$r.Y,[int]$r.Width,[int]$r.Height)
"""
        try:
            proc = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15, shell=False)
        except subprocess.TimeoutExpired:
            raise RuntimeError("Поиск поля Telegram превысил 15 секунд.")
        raw = (proc.stdout or "").strip()
        if proc.returncode != 0:
            raise RuntimeError(raw or "Не удалось безопасно найти поле ввода Telegram.")
        try:
            x, y, w, h = [int(v) for v in raw.splitlines()[-1].split(",")]
        except Exception:
            raise RuntimeError("Windows вернула некорректные координаты поля Telegram.")
        import pyautogui
        pyautogui.FAILSAFE = True
        pyautogui.PAUSE = 0
        pyautogui.click(x + max(2, min(w - 2, 12)), y + h // 2)
        # Unicode-ввод через SendInput; после полного ввода отправляем Enter.
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
        encoded = message.encode("utf-16-le")
        inputs = []
        for i in range(0, len(encoded), 2):
            code = int.from_bytes(encoded[i:i+2], "little")
            down, up = INPUT(), INPUT()
            down.type = up.type = INPUT_KEYBOARD
            down.union.ki = KEYBDINPUT(0, code, KEYEVENTF_UNICODE, 0, 0)
            up.union.ki = KEYBDINPUT(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0)
            inputs.extend((down, up))
        array_type = INPUT * len(inputs)
        input_array = array_type(*inputs)
        user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
        user32.SendInput.restype = wintypes.UINT
        sent = user32.SendInput(len(inputs), input_array, ctypes.sizeof(INPUT))
        if sent != len(inputs):
            error_code = ctypes.get_last_error()
            raise OSError("Windows SendInput ввёл " + str(sent) + " из " + str(len(inputs)) +
                          " событий (код ошибки " + str(error_code) + "). Сообщение НЕ отправлено.")
        pyautogui.press("enter")
        return {"result": "Сообщение отправлено в Telegram контакту «" + recipient + "»."}
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
                            allowed = {"w","a","s","d","space","shift","ctrl","alt","e","q","f","r","g","b","1","2","3","4","5","6","7","8","9","escape","tab","enter"}
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
                            # Use PyAutoGUI's Windows mouse backend for game clicks.
                            # Keep held state so touch controls support continuous fire/hold.
                            if kind == "game-click":
                                pyautogui.click(button=button)
                                print("Игровая мышь: клик", button)
                            elif data.get("state") == "down":
                                if button not in held_buttons:
                                    pyautogui.mouseDown(button=button)
                                    held_buttons.add(button)
                                    print("Игровая мышь: нажата", button)
                            elif data.get("state") == "up" and button in held_buttons:
                                pyautogui.mouseUp(button=button)
                                held_buttons.discard(button)
                                print("Игровая мышь: отпущена", button)
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



def local_voice_command(text):
    """Small, allowlisted Russian command interpreter for the local wake-word listener."""
    import re
    s = str(text or "").casefold().replace("ё","е").strip()
    s = re.sub(r"[^a-zа-я0-9% ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^(?:а\s+)?(?:астра|астро|ас тра|astra)\s*", "", s).strip()
    if not s: return None
    s = re.sub(r"^(?:пожалуйста|ну|давай|ка|бы)\s+", "", s)
    if any(x in s for x in ("скриншот","снимок экрана","сфотографируй экран")):
        return {"action":"screenshot","args":{}}
    if any(x in s for x in ("сколько батареи","заряд батареи","батарея","информация о компьютере","информация о пк","сколько оперативки","свободное место")):
        return {"action":"pc_info","args":{}}
    if any(x in s for x in ("покажи рабочий стол","сверни все окна","свернуть все окна")):
        return {"action":"show_desktop","args":{}}
    if any(x in s for x in ("пауза","продолжи видео","воспроизведение","включи видео")):
        return {"action":"media_control","args":{"command":"play_pause"}}
    if "следующ" in s and any(x in s for x in ("трек","песн","видео")):
        return {"action":"media_control","args":{"command":"next"}}
    if any(x in s for x in ("предыдущ","прошл")) and any(x in s for x in ("трек","песн","видео")):
        return {"action":"media_control","args":{"command":"previous"}}
    vol = re.search(r"(?:громкост|звук).{0,25}?(?:на|до)\s*(\d{1,3})\s*%?", s)
    if not vol: vol = re.search(r"(?:установи|поставь|сделай).{0,20}?(\d{1,3})\s*%?", s)
    if vol:
        n=int(vol.group(1))
        if 0<=n<=100: return {"action":"set_volume","args":{"mode":"set","percent":n}}
    for verb in ("открой","запусти","включи"):
        if s.startswith(verb+" "):
            app=s[len(verb):].strip()
            app=re.sub(r"^(?:приложение|программу|браузер)\s+","",app)
            if app: return {"action":"open_app","args":{"app":app}}
    if s.startswith("закрой "):
        app=s[6:].strip()
        if app: return {"action":"close_app","args":{"app":app}}
    if any(x in s for x in ("выключи компьютер","заверши работу")): return {"action":"shutdown_pc","args":{}}
    if any(x in s for x in ("перезагрузи компьютер","перезагрузка")): return {"action":"restart_pc","args":{}}
    if any(x in s for x in ("усыпи компьютер","спящий режим","отправь компьютер спать")): return {"action":"sleep_pc","args":{}}
    if any(x in s for x in ("заблокируй компьютер","блокировка компьютера")): return {"action":"lock_pc","args":{}}
    return None

def start_local_wake_listener():
    """Use Windows built-in SAPI speech recognition; no audio is sent to Telegram/Render."""
    ps = r"""
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $engine.SetInputToDefaultAudioDevice()
  $grammar = New-Object System.Speech.Recognition.DictationGrammar
  $engine.LoadGrammar($grammar)
  $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(10)
  $engine.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.2)
  $engine.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromSeconds(1.8)
  $engine.BabbleTimeout = [TimeSpan]::FromSeconds(4)
  $engine.SpeechRecognized.Add({
    param($sender, $event)
    $phrase = [string]$event.Result.Text
    if ($phrase) { [Console]::Out.WriteLine("РАСПОЗНАНО: " + $phrase); [Console]::Out.Flush() }
  })
  $engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  while ($true) { Start-Sleep -Seconds 1 }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }
"""
    def worker():
        try:
            proc = subprocess.Popen(["powershell.exe","-NoProfile","-NonInteractive","-Command",ps],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", bufsize=1)
            print("Голосовая активация: скажи «Астра» и команду. Микрофон обрабатывается локально.")
            for line in proc.stdout:
                phrase = line.strip()
                if not phrase: continue
                if phrase.startswith("РАСПОЗНАНО: "): phrase = phrase[len("РАСПОЗНАНО: "):].strip()
                print("Астра услышала:", phrase)
                command = local_voice_command(phrase)
                if not command:
                    continue
                print("Локальная голосовая команда:", phrase, "->", command["action"])
                try:
                    result = execute(command)
                    print("NEXUS:", result.get("result","Готово"))
                except Exception as exc:
                    print("NEXUS: команда не выполнена:", str(exc)[:300])
        except Exception as exc:
            print("Голосовой режим не запустился:", repr(exc))
            print("Проверь, установлен ли в Windows русский пакет распознавания речи.")
    threading.Thread(target=worker, daemon=True).start()

def main():
    cfg = load_config()
    print("NEXUS Agent", AGENT_VERSION, "| файл:", __file__)
    print("NEXUS Agent подключается к", cfg["server"])
    print("Остановка: Ctrl+C. Агент не принимает произвольные shell-команды.")
    threading.Thread(target=webrtc_offer_listener, args=(cfg,), daemon=True).start()
    start_local_wake_listener()
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
