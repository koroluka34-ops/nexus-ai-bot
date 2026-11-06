# NEXUS Agent for Windows
# Python 3.10+; standard library only.
# Set PC_AGENT_TOKEN in the Windows environment before starting this agent.

import json
import os
import shutil
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

BASE_URL = os.environ.get("NEXUS_URL", "https://nexus-ai-bot-kt4w.onrender.com").rstrip("/")
TOKEN = os.environ.get("PC_AGENT_TOKEN", "").strip()
POLL_URL = BASE_URL + "/device/poll"
RESULT_URL = BASE_URL + "/device/result"

APP_COMMANDS = {
    "telegram": ["cmd", "/c", "start", "", "tg://"],
    "discord": ["cmd", "/c", "start", "", "discord://"],
    "steam": ["cmd", "/c", "start", "", "steam://open/main"],
    "opera": ["cmd", "/c", "start", "", "opera"],
    "opera gx": ["cmd", "/c", "start", "", "opera"],
    "chrome": ["cmd", "/c", "start", "", "chrome"],
    "google chrome": ["cmd", "/c", "start", "", "chrome"],
    "проводник": ["explorer.exe"],
    "explorer": ["explorer.exe"],
    "калькулятор": ["calc.exe"],
    "calculator": ["calc.exe"],
    "блокнот": ["notepad.exe"],
    "notepad": ["notepad.exe"],
    "paint": ["mspaint.exe"],
    "паинт": ["mspaint.exe"],
}
APP_PROCESSES = {
    "telegram": "Telegram.exe",
    "discord": "Discord.exe",
    "steam": "steam.exe",
    "opera": "opera.exe",
    "opera gx": "opera.exe",
    "chrome": "chrome.exe",
    "google chrome": "chrome.exe",
    "проводник": "explorer.exe",
    "explorer": "explorer.exe",
    "калькулятор": "CalculatorApp.exe",
    "calculator": "CalculatorApp.exe",
    "блокнот": "notepad.exe",
    "notepad": "notepad.exe",
    "paint": "mspaint.exe",
    "паинт": "mspaint.exe",
}
FOLDERS = {
    "downloads": "Downloads",
    "desktop": "Desktop",
    "documents": "Documents",
    "pictures": "Pictures",
    "videos": "Videos",
    "music": "Music",
}

def request_json(url, method="GET", data=None, timeout=25):
    headers = {"Authorization": "Bearer " + TOKEN, "Accept": "application/json"}
    body = None
    if data is not None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read().decode("utf-8", errors="replace")
        return json.loads(raw) if raw else {}

def report(command_id, message):
    try:
        request_json(RESULT_URL, "POST", {"id": command_id, "result": str(message)[:2500]}, timeout=20)
    except Exception as exc:
        print("Не удалось отправить результат в NEXUS:", exc)

def open_app(name):
    key = str(name or "").strip().lower()
    if key in ("tiktok", "тик ток", "тикток"):
        webbrowser.open("https://www.tiktok.com")
        return "Открыл TikTok в браузере."
    command = APP_COMMANDS.get(key)
    if not command:
        raise ValueError("Приложение пока не входит в список запуска: " + str(name))
    subprocess.Popen(command, shell=False)
    return "Команда запуска отправлена: " + str(name)

def close_app(name):
    key = str(name or "").strip().lower()
    process = APP_PROCESSES.get(key)
    if not process:
        raise ValueError("Закрытие этого приложения пока не разрешено: " + str(name))
    result = subprocess.run(
        ["taskkill", "/IM", process, "/T", "/F"],
        capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if result.returncode == 0:
        return "Приложение закрыто: " + str(name)
    return "Процесс не найден или уже закрыт: " + str(name)

def open_microsoft_store(query=None):
    """Open the real Microsoft Store UI, optionally on its search results."""
    if query:
        query = str(query).strip()
        if not query or len(query) > 80 or not re.fullmatch(r"[\\wА-Яа-яЁё ._()+-]+", query, re.UNICODE):
            raise ValueError("Название приложения для Microsoft Store некорректно.")
        target = "ms-windows-store://search/?query=" + urllib.parse.quote(query)
        os.startfile(target)
        return ("Открыл Microsoft Store и поиск: " + query +
                ". На странице приложения нажми «Получить/Установить». " +
                "Пока Windows Store не подтвердит установку, я не буду считать приложение установленным.")
    os.startfile("ms-windows-store:")
    return "Открыл Microsoft Store."

def execute(action, args):
    args = args or {}
    if action == "open_store":
        return open_microsoft_store()
    if action == "install_store_app":
        return open_microsoft_store(args.get("query", ""))
    if action == "open_app":
n        return open_app(args.get("app", ""))
    if action == "close_app":
        return close_app(args.get("app", ""))
    if action == "open_folder":
        folder = FOLDERS.get(str(args.get("folder", "")).lower())
        if not folder:
            raise ValueError("Папка не входит в разрешённый список.")
        path = os.path.join(os.path.expanduser("~"), folder)
        os.startfile(path)
        return "Открыл папку " + folder
    if action == "open_google":
        webbrowser.open("https://www.google.com")
        return "Открыл Google."
    if action == "search_google":
        query = urllib.parse.quote_plus(str(args.get("query", "")))
        if not query:
            raise ValueError("Не задан поисковый запрос.")
        webbrowser.open("https://www.google.com/search?q=" + query)
        return "Ищу в Google: " + str(args.get("query"))
    if action == "open_youtube":
        webbrowser.open("https://www.youtube.com")
        return "Открыл YouTube."
    if action == "search_youtube":
        query = urllib.parse.quote_plus(str(args.get("query", "")))
        if not query:
            raise ValueError("Не задан поисковый запрос.")
        webbrowser.open("https://www.youtube.com/results?search_query=" + query)
        return "Ищу на YouTube: " + str(args.get("query"))
    if action == "lock_pc":
        subprocess.Popen(["rundll32.exe", "user32.dll,LockWorkStation"], shell=False)
        return "Компьютер заблокирован."
    if action == "shutdown_pc":
        subprocess.Popen(["shutdown.exe", "/s", "/t", "30"], shell=False)
        return "Выключение запланировано через 30 секунд. Отмена: shutdown /a"
    if action == "restart_pc":
        subprocess.Popen(["shutdown.exe", "/r", "/t", "30"], shell=False)
        return "Перезагрузка запланирована через 30 секунд. Отмена: shutdown /a"
    if action == "sleep_pc":
        subprocess.Popen(["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"], shell=False)
        return "Отправил компьютер в спящий режим."
    if action == "open_settings":
        pages = {
            "bluetooth": "ms-settings:bluetooth",
            "hotspot": "ms-settings:network-mobilehotspot",
            "airplane": "ms-settings:network-airplanemode",
            "night_light": "ms-settings:nightlight",
            "battery": "ms-settings:powersleep",
            "accessibility": "ms-settings:easeofaccess",
            "captions": "ms-settings:easeofaccess-closedcaptioning",
            "display": "ms-settings:display",
            "projection": "ms-settings:connect"
        }
        page = str(args.get("page", "")).lower()
        if page not in pages:
            raise ValueError("Раздел Windows не входит в разрешённый список.")
        os.startfile(pages[page])
        return "Открыл настройки Windows: " + page
    if action == "set_airplane_mode":
        state = str(args.get("state", "")).lower()
        if state not in ("on", "off"):
            raise ValueError("Для авиарежима укажи on или off.")
        # Windows exposes Wi-Fi adapters through NetAdapter and Bluetooth radios
        # as Plug-and-Play devices. This toggles both radios; it is not a firmware
        # airplane-mode switch. Administrator rights may be required.
        ps = r"""
$ErrorActionPreference = 'Stop'
$state = $env:NEXUS_AIRPLANE_STATE
$wifi = Get-NetAdapter -Physical -ErrorAction Stop | Where-Object {
  $_.InterfaceDescription -match 'Wi-Fi|Wireless|802\.11|Беспровод'
}
if (-not $wifi) { throw 'Физический Wi-Fi адаптер не найден.' }
if ($state -eq 'off') {
  $wifi | Enable-NetAdapter -Confirm:$false -ErrorAction Stop
} else {
  $wifi | Disable-NetAdapter -Confirm:$false -ErrorAction Stop
}
$bt = Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | Where-Object {
  $_.FriendlyName -match 'Bluetooth.*(Radio|Adapter)|(Radio|Adapter).*Bluetooth|Qualcomm.*Bluetooth|Intel.*Bluetooth|Realtek.*Bluetooth|MediaTek.*Bluetooth'
}
if ($bt) {
  if ($state -eq 'off') {
    $bt | Enable-PnpDevice -Confirm:$false -ErrorAction Stop
  } else {
    $bt | Disable-PnpDevice -Confirm:$false -ErrorAction Stop
  }
} else {
  Write-Output 'Предупреждение: Bluetooth-радио не найдено; изменён только Wi-Fi.'
}
'Airplane radio state: ' + $state
"""
        env = os.environ.copy()
        env["NEXUS_AIRPLANE_STATE"] = state
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
            capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, timeout=35
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "Не удалось переключить радиомодули.").strip()
            if "access" in detail.lower() or "доступ" in detail.lower() or "administrator" in detail.lower():
                detail += " Запусти NEXUS Agent от имени администратора."
            raise RuntimeError(detail[-1200:])
        return ("Авиарежим включён: Wi-Fi и Bluetooth отключены. " if state == "on" else
                "Авиарежим выключен: Wi-Fi и Bluetooth включены. ") + result.stdout.strip()
    if action == "set_wifi":
        state = str(args.get("state", "")).lower()
        if state not in ("on", "off"):
            raise ValueError("Для Wi-Fi укажи on или off.")
        ps = "$a=Get-NetAdapter -Physical | Where-Object {$_.Name -match 'Wi-Fi|Беспроводная'} | Select-Object -First 1; if(-not $a){throw 'Wi-Fi адаптер не найден'}; if('" + state + "' -eq 'on'){Enable-NetAdapter -Name $a.Name -Confirm:$false -ErrorAction Stop}else{Disable-NetAdapter -Name $a.Name -Confirm:$false -ErrorAction Stop}; $a.Name"
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20)
        if result.returncode != 0:
            raise RuntimeError((result.stderr or result.stdout or "Не удалось изменить Wi-Fi. Возможно, нужны права администратора.").strip()[-900:])
        return "Wi-Fi " + ("включён" if state == "on" else "отключён") + "."
    if action == "get_pc_status":
        ps = "$b=Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue; if($b){'BATTERY=' + [int]$b.EstimatedChargeRemaining; 'STATUS=' + [int]$b.BatteryStatus}else{'BATTERY=unknown'}; 'AC=' + ((Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue).BatteryStatus)"
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15)
        if result.returncode != 0:
            raise RuntimeError((result.stderr or "Не удалось получить состояние батареи.").strip()[-700:])
        return "Состояние ПК: " + result.stdout.strip().replace("\r", "").replace("\n", " · ")
    if action == "set_volume":
        try:
            from ctypes import POINTER, cast
            from comtypes import CLSCTX_ALL
            from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
            devices = AudioUtilities.GetSpeakers()
            # Newer pycaw versions expose EndpointVolume directly on AudioDevice;
            # older versions require Activate() and COM interface casting.
            if hasattr(devices, "EndpointVolume"):
                volume = devices.EndpointVolume
            else:
                interface = devices.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
                volume = cast(interface, POINTER(IAudioEndpointVolume))
            mode = str(args.get("mode", "set")).lower()
            current = int(round(volume.GetMasterVolumeLevelScalar() * 100))
            if mode == "set":
                target = int(args.get("percent", -1))
            elif mode == "up":
                target = current + int(args.get("amount", 10))
            elif mode == "down":
                target = current - int(args.get("amount", 10))
            else:
                raise ValueError("Неизвестный режим громкости.")
            if not 0 <= target <= 100:
                raise ValueError("Громкость должна быть от 0 до 100 процентов.")
            volume.SetMasterVolumeLevelScalar(target / 100.0, None)
            return "Громкость установлена на " + str(target) + "%."
        except ImportError:
            raise RuntimeError("Для управления громкостью установи: py -m pip install pycaw comtypes")
    if action == "set_brightness":
        mode = str(args.get("mode", "set")).lower()
        # Windows WMI controls the built-in display backlight on supported laptops.
        script = r"""
$ErrorActionPreference = 'Stop'
$methods = Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods | Select-Object -First 1
if (-not $methods) { throw 'Windows не обнаружила WMI-управление яркостью встроенного дисплея.' }
$brightness = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -First 1
if (-not $brightness) { throw 'Не удалось прочитать текущую яркость дисплея.' }
$current = [int]$brightness.CurrentBrightness
$mode = $env:NEXUS_BRIGHTNESS_MODE
$amount = [int]$env:NEXUS_BRIGHTNESS_AMOUNT
$percent = [int]$env:NEXUS_BRIGHTNESS_PERCENT
if ($mode -eq 'up') { $target = [Math]::Min(100, $current + $amount) }
elseif ($mode -eq 'down') { $target = [Math]::Max(0, $current - $amount) }
else { $target = $percent }
$result = $methods.WmiSetBrightness([uint32]1, [byte]$target)
if ($result.ReturnValue -ne 0) { throw ('Windows вернула код ошибки яркости: ' + $result.ReturnValue) }
Write-Output $target
"""
        env = os.environ.copy()
        env["NEXUS_BRIGHTNESS_MODE"] = mode
        env["NEXUS_BRIGHTNESS_AMOUNT"] = str(int(args.get("amount", 10)))
        env["NEXUS_BRIGHTNESS_PERCENT"] = str(int(args.get("percent", 50)))
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, timeout=20
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "Неизвестная ошибка PowerShell").strip()
            raise RuntimeError(detail[-1200:])
        target = result.stdout.strip().splitlines()[-1]
        return "Яркость экрана установлена на " + target + "%."
    if action == "install_app":
        query = str(args.get("query", "")).strip()
        if not query or len(query) > 80 or not re.fullmatch(r"[\wА-Яа-яЁё ._()+-]+", query, re.UNICODE):
            raise ValueError("Название приложения для установки некорректно.")
        winget = shutil.which("winget")
        if not winget:
            raise RuntimeError("Windows Package Manager (winget) не найден. Обнови App Installer из Microsoft Store.")
        command = [winget, "install", "--name", query, "--exact", "--silent",
                   "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                                errors="replace", timeout=900)
        output = (result.stdout or "") + "\n" + (result.stderr or "")
        if result.returncode != 0:
            detail = output.strip()[-1400:] or ("winget завершился с кодом " + str(result.returncode))
            raise RuntimeError("Не удалось установить " + query + ": " + detail)
        return "Установка " + query + " завершена.\n" + output.strip()[-700:]
    if action in ("uninstall_app", "close_all_apps"):
        raise RuntimeError("Удаление приложений и закрытие всех программ пока отключены из соображений безопасности.")
    raise RuntimeError("Неизвестное действие: " + str(action))

def main():
    if os.name != "nt":
        raise SystemExit("Этот агент предназначен для Windows.")
    if len(TOKEN) < 32:
        raise SystemExit("Не задан PC_AGENT_TOKEN или он короче 32 символов. Не публикуй токен в чате.")
    print("NEXUS Agent запущен. Ожидаю команды от Telegram...")
    print("Сервер:", BASE_URL)
    while True:
        try:
            payload = request_json(POLL_URL, timeout=30)
            command = payload.get("command")
            if not command:
                time.sleep(max(0.5, min(float(payload.get("pollAfterMs", 1800)) / 1000.0, 5.0)))
                continue
            command_id = str(command.get("id", ""))
            action = str(command.get("action", ""))
            args = command.get("args") or {}
            print("Команда:", action, args)
            try:
                result = execute(action, args)
            except Exception as exc:
                result = "Ошибка выполнения: " + str(exc)
            print(result)
            if command_id:
                report(command_id, result)
        except urllib.error.HTTPError as exc:
            print("Ошибка сервера:", exc.code, exc.reason)
            time.sleep(5)
        except Exception as exc:
            print("Нет связи с NEXUS:", exc)
            time.sleep(5)

if __name__ == "__main__":
    main()
