# NEXUS Agent for Windows
# Python 3.10+; standard library only.
# Set PC_AGENT_TOKEN in the Windows environment before starting this agent.

import json
import os
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

def execute(action, args):
    args = args or {}
    if action == "open_app":
        return open_app(args.get("app", ""))
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
    if action in ("install_app", "uninstall_app", "close_all_apps"):
        raise RuntimeError("Это действие пока отключено в Windows-агенте из соображений безопасности.")
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
