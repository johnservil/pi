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

This copy has a fast path for expanded tool calls and compaction summaries. It goes with this fork's cached `Ctrl+O` (commit `09d8e3c`); an older copy of the extension keeps part of the old slowness.

## What to know

Pi's extension API has no call for either layout. While a session is open, each extension replaces a few methods of Pi's interactive mode. It puts them back when the session closes, and takes itself out with a notice if its own code throws. Check them after a Pi upgrade.

`keep-scrollback.ts` has a test, which passes against this fork (1.6.0) and against stock Pi 1.4.0:

```sh
node extensions/test-keep-scrollback.mjs                                    # this repository's build
PI_PACKAGE_DIR=/path/to/pi-coding-agent node extensions/test-keep-scrollback.mjs   # another Pi
```

`quiet-transcript.ts` has no test of its own. It is in daily use on this fork.
