# Telegram bridge attribution

The Telegram bridge is based on [`badlogic/pi-telegram`](https://github.com/badlogic/pi-telegram), created by Mario Zechner.

The upstream package declares the MIT license. Its Telegram functionality is adapted into pi-tools' standalone daemon; Pi-specific integration lives separately in `src/bot/`. The daemon uses pi-tools' shared Whisper executor.
