# Extensions that go with this fork

Two extensions for Pi's interactive mode, each one file. The fork does not load them by itself: copy the ones you want into Pi's user extensions and restart Pi (or run `/reload`).

```sh
mkdir -p ~/.pi/agent/extensions
cp extensions/keep-scrollback.ts extensions/quiet-transcript.ts ~/.pi/agent/extensions/
```

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

## clock-timestamps.ts: single-row clock footer and inline event timestamps

Replaces the default multi-row footer with a single compact row showing a live clock, session cost, context usage, tool-expansion state, and model/thinking level (dropping the cumulative token and cache counters `↑`, `↓`, `R`, `W`, `CH%`). Prepends compact inline timestamps (`*HH:MM:SS* ` on today's messages, `*YYYY-MM-DD HH:MM:SS* ` on prior days) to user messages, assistant replies, custom messages, and summaries using Pi's `registerMarkdownTransformer` API (no monkey-patching; compatible with `keep-scrollback.ts` and `quiet-transcript.ts`). Toggle transcript timestamps at runtime with `/timestamps`.

## What to know

Pi's extension API has no call for either layout. While a session is open, each extension replaces a few methods of Pi's interactive mode. It puts them back when the session closes, and takes itself out with a notice if its own code throws. Check them after a Pi upgrade.

Each has a test, which passes against this fork (1.6.0) and against stock Pi 1.4.0:

```sh
node extensions/test-keep-scrollback.mjs                                    # this repository's build
node extensions/test-quiet-transcript.mjs
PI_PACKAGE_DIR=/path/to/pi-coding-agent node extensions/test-quiet-transcript.mjs   # another Pi
```
