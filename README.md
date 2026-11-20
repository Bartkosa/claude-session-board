# Session Board

A side panel for the **Claude Code desktop app** that shows all your sessions at a glance, so you
can run several of them in parallel without clicking through each one to see how it is doing.

Sessions are grouped by what they need from you:

| Section | What it means |
|---|---|
| **Working** | The session is in the middle of a turn. The badge shows how long the turn has run; a bar shows progress through the session's task list, and `⏳ background` marks a turn waiting on a background task (a CI run, a long build). |
| **Stalled mid-turn** | The session is mid-turn but nothing has happened for 5+ minutes. |
| **Needs you** | The session asked you something, is waiting for a permission, or finished after you last opened it. The badge turns from orange to red after 15 minutes. |
| **Recent** | Finished sessions you have already looked at. Only the last 5 hours are shown; older ones are behind *Show older*. |
| **Done** | Sessions you marked with ✓. Collapsed by default. A done session comes back on its own as soon as a new message appears in it. ↺ brings it back by hand. |

A session started by another session (or forked from one) is listed right under its parent with a
`↳` when both are in the same section. When the parent is in another section, the sub-session
stays where its own state puts it, with a `↳ from …` line naming the parent.

Click a session's title to jump to it. The session you are in is highlighted.
The panel refreshes every 5 seconds and covers sessions active in the last 24 hours.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-board --marketplace Bartkosa/claude-session-board
```

Answer `y` to add the marketplace, then pick the user scope (Enter). Or from a shell:

```
claude plugin install session-board --marketplace Bartkosa/claude-session-board
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then
**Plugins**, **Add marketplace** with `Bartkosa/claude-session-board`, then **Add plugin**.

Installed at the user scope, the panel opens by itself in every new session. Type `/sessions` to
open it again after closing it.

## Requirements and limits

- **Node.js** on your `PATH`: the panel runs a small Node script to read session transcripts.
- **Jumping to a session works on Windows only** for now (it opens the session's `claude://` link
  through `explorer.exe`). On macOS and Linux the panel still works, clicking a title just does nothing.
- The panel reads files the desktop app keeps for itself (session titles, when you last opened a
  session). They are not a documented interface, so an app update may break parts of the panel.
- *Needs you* for a permission prompt is a guess: a tool call with no result for 90 seconds.
  A slow command that is not marked as long-running can show up there for a moment.

## How it works

- `scripts/scan.mjs` reads the tail of each transcript in `~/.claude/projects/*/*.jsonl` changed in
  the last 24 hours and works out each session's state: the last turn's end, pending tool calls,
  background tasks, the task list (`update_plan`) and the end-of-turn summary (`wrap_up`).
- It joins them with the desktop app's session files (under `%LOCALAPPDATA%\Claude-Data`) for
  titles, the `claude://` link and when you last opened each session.
- `hooks/register.tsx` is the mod: it runs the scan every 5 seconds and draws the panel.
- Your ✓ marks are kept in `~/.claude/session-board-done.json`, shared by every session's panel.

## License

MIT
