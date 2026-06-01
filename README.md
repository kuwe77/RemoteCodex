# RemoteCodex

A Codex-only Telegram bridge for controlling a local project from your phone. This fork keeps the workflow focused on Codex CLI, Telegram, image-aware prompts, session resume, clean Telegram replies, and optional Codex Desktop mirroring.

![RemoteCodex dashboard](docs/screenshot.png)

## What this fork focuses on

- Codex runtime only: new Telegram sessions are routed to Codex CLI.
- Telegram bot control: send plain messages, `/new`, `/sessions`, `/resume`, and `/cancel` from Telegram.
- Project-folder binding: configure the bot to run Codex inside a specific workspace such as `C:\LinkTreeZakwan`.
- Image prompts: Telegram photos are downloaded locally and forwarded to Codex as image inputs.
- Clean Telegram replies: local file references are formatted as `file.ext (line N)` instead of full Windows paths.
- Stable streaming: worker progress is sent in order, duplicate final replies are suppressed, and cancelled runs ignore late output.
- Session resume: list recent sessions and resume a specific Codex conversation from Telegram.
- Codex Desktop bridge: Telegram-started sessions can be mirrored into Codex Desktop-visible threads.
- Windows reliability scripts: start, stop, supervise, and optionally autostart the service.

## Quick start

Requirements:

- Node.js 24 or newer
- Codex CLI installed and logged in
- A Telegram bot token from BotFather

Install dependencies:

```powershell
npm install
```

Configure Telegram for a project folder:

```powershell
scripts\configure-telegram.cmd -BotToken <telegram-bot-token> -WorkingDirectory C:\YourProject
```

Start the gateway in the background:

```powershell
scripts\start-remotecodex.cmd -Background
```

Open the dashboard:

```text
http://localhost:8081
```

Stop the gateway:

```powershell
scripts\stop-remotecodex.cmd
```

## Telegram commands

- `/new <task>` starts a fresh Codex session.
- Plain messages continue the active session.
- `/sessions` lists resumable sessions.
- `/resume latest <task>` continues the newest session.
- `/resume <session-id> <task>` continues a specific session.
- `/cancel` cancels the active run and prevents late noisy output.

## Notes for safe publishing

Bot tokens, runtime data, logs, temporary app servers, and local session files are ignored by Git. Keep real destination links, phone numbers, and private project paths out of committed examples unless you intentionally want them public.

## Development checks

Run syntax checks for the RemoteCodex service entry points:

```powershell
npm run check
```

## License

AGPL-3.0. This is a focused fork built for a Codex and Telegram workflow.

