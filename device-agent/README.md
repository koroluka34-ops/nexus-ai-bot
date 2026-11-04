# NEXUS Windows Agent

Локальный агент для безопасного управления Windows-компьютером через Telegram-бота NEXUS.

## Подготовка
1. В Render добавьте переменную окружения `PC_AGENT_TOKEN` — случайный секрет длиной минимум 32 символа.
2. Установите Python 3.10+ на Windows.
3. Откройте PowerShell в этой папке и выполните:
   `py -m pip install pyautogui pillow pyperclip`
4. Запустите:
   `py nexus_agent.py`
5. При первом запуске укажите HTTPS URL NEXUS и тот же PC_AGENT_TOKEN. Секрет сохранится локально в agent-config.json. Не отправляйте этот файл никому.
6. В Telegram используйте /pc status, затем /pc help.

## Поддерживаемые команды
- /pc status
- /pc screen
- /pc open https://example.com
- /pc launch notepad|calculator|paint|explorer
- /pc type текст

Каждое действие подтверждается в Telegram. Произвольные команды оболочки не принимаются. Агент работает только пока запущен на компьютере. Для скриншотов и печати текста требуются pyautogui, Pillow и pyperclip.

## Отключение
Нажмите Ctrl+C в окне агента или закройте его. Затем выполните /pcdisconnect в Telegram.
