# Extensions that go with this fork

Three extensions for Pi's interactive mode, each one file. The fork does not load them by itself: copy the ones you want into Pi's user extensions and restart Pi (or run `/reload`).

```sh
mkdir -p ~/.pi/agent/extensions
cp extensions/keep-scrollback.ts extensions/quiet-transcript.ts extensions/clock-timestamps.ts ~/.pi/agent/extensions/
```

## clock-timestamps.ts: single-row clock toolbar with think/tools state and per-event timestamps

Replaces Pi's default footer with one compact row showing the live clock, session cost, context %, `think:{expanded,collapsed} • tools:{expanded,collapsed}`, and model/thinking level, and stamps user/assistant/summary messages with timestamps (`/timestamps` toggles message timestamps).

- Caches session cost and `ctx.getContextUsage()` by `(sessionId, leafId, entryCount, model)` so scrolling and the 1-second clock tick stay O(1) instead of rescanning the session on every frame.
- Reads live thinking visibility via `ctx.ui.getThinkingExpanded()` on `johnservil/pi` (with an mtime-gated fallback to `settings.json` on stock Pi).

## keep-scrollback.ts: the transcript stays in view across compactions

Pi clears the transcript when a session is compacted, and after a restart it shows only what follows the latest compaction. With this extension:

- A compaction leaves the earlier messages where they are. Its summary appears in place, where it happened.
- On startup, `/reload` or a rebuild, Pi shows the last 10 compactions' worth of the session (about 5,000 entries of a long working session).
- `/scrollback N` changes the depth at once, and `/scrollback all` shows the whole session. `PI_KEEP_SCROLLBACK_COMPACTIONS` sets the default (0 means all).

Only what the terminal shows changes. The model's context is what Pi makes it.

## quiet-transcript.ts: short markers for hidden thinking and collapsed tools

A hidden thinking block shows as `[think...]` and a collapsed tool call as `[tool...]`, each where its block would be. Neighbouring markers share a row. Ctrl+T and Ctrl+O toggle them (Pi's default bindings), and in fullscreen mode a click opens or closes one block.

In `~/.pi/agent/settings.json`, set `"hideThinkingBlock": true` and `"terminal": { "showImages": false }`.

A long transcript costs little to draw again: the extension keeps its rows from one frame to the next and lays out again only from the first block that changed. It tells Pi where each block is in the way Pi 1.4 and Pi 1.6 each expect, so a wheel event or a click does not make Pi draw the transcript again to find the block under the pointer. When rows above the reader change (a tool opens, thinking shows), the row the reader had on top stays on top.

## What to know

Pi's extension API has no call for either layout. While a session is open, each extension replaces a few methods of Pi's interactive mode. It puts them back when the session closes, and takes itself out with a notice if its own code throws. Check them after a Pi upgrade.

Each has a test, which passes against this fork (1.6.0) and against stock Pi 1.4.0:

```sh
node extensions/test-keep-scrollback.mjs                                    # this repository's build
node extensions/test-quiet-transcript.mjs
node extensions/test-clock-timestamps.mjs
PI_PACKAGE_DIR=/path/to/pi-coding-agent node extensions/test-quiet-transcript.mjs   # another Pi
```
