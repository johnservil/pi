// keep-scrollback: keep the transcript across compactions, so that the usual
// workflow (Ctrl+T to collapse thinking, Ctrl+O to collapse tools, then scroll
// back to earlier prompts and answers) works without losing history whenever
// autocompaction runs.
//
// Why Pi loses scrollback on compaction:
//   InteractiveMode.handleEvent() calls `this.chatContainer.clear()` and
//   re-renders only `sessionManager.buildContextEntries()` (which drops
//   everything summarized before the latest compaction). Likewise
//   `renderInitialMessages()` and `rebuildChatFromMessages()` render only
//   `buildContextEntries()`.
//
// What this extension does:
//   1. When a compaction completes during a live session (`compaction_end` or
//      `entry_appended` with type `"compaction"`), it does NOT clear
//      `chatContainer`. Instead it simply appends the compaction summary
//      message (and cost notice, if any) in chronological place, so earlier
//      messages stay in the scroll view and the compaction itself is clearly
//      visible where it happened.
//   2. On startup / reload / rebuild (`renderInitialMessages` and
//      `rebuildChatFromMessages`), instead of only `buildContextEntries()`
//      (post-latest-compaction), it renders the last `MAX_COMPACTIONS`
//      compactions' worth of branch entries in chronological order (with every
//      compaction summary visible in place). Default: 10 compactions (~5,000
//      entries, several days of work), configurable via
//      `PI_KEEP_SCROLLBACK_COMPACTIONS` (0 = entire branch).
//   3. Adds `/scrollback [N|all]` so the user can change the depth on the fly
//      and immediately rebuild the transcript without restarting Pi.
//
// Same safety contract as quiet-transcript.ts: replaces methods on
// InteractiveMode.prototype while a TUI session is active, restores them on
// shutdown, and automatically uninstalls itself and notifies on any error.
// Check it after a Pi upgrade.
import {
  InteractiveMode,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_COMPACTIONS = Number(process.env.PI_KEEP_SCROLLBACK_COMPACTIONS ?? 10);

type SessionEntry = {
  type: string;
  id?: string;
  summary?: string;
  tokensBefore?: number;
  timestamp?: string;
  usage?: unknown;
  [key: string]: unknown;
};

type InteractiveModeInternals = {
  sessionManager: {
    getBranch(): SessionEntry[];
    getEntries(): SessionEntry[];
    buildContextEntries(): SessionEntry[];
  };
  chatContainer: {
    clear(): void;
    children: unknown[];
  };
  entriesRenderedByBoundaryCompaction?: Set<string>;
  footer: { invalidate(): void };
  ui: { requestRender(): void };
  renderInitialMessages(): void;
  rebuildChatFromMessages(): void;
  renderSessionEntries(entries: SessionEntry[], options?: Record<string, unknown>): void;
  renderProjectTrustWarningIfNeeded(): void;
  showStatus(message: string): void;
  addMessageToChat(message: unknown, options?: Record<string, unknown>): void;
  addCompactionCostNotice(notice: { type: "compaction_cost"; kind: "compaction"; usage: unknown }): void;
  flushCompactionQueue(options: { willRetry: boolean }): Promise<void>;
  handleEvent(event: Record<string, unknown>): Promise<void>;
};

/**
 * Slice a branch chronologically so it includes everything from the Nth-to-last
 * compaction onward (or the entire branch if maxCompactions <= 0 or fewer than
 * maxCompactions compactions exist).
 *
 * When a slice starts at a compaction boundary, include the compaction summary
 * entry itself so the reader sees where the window starts, plus all subsequent
 * messages and later compaction summaries in exact chronological order.
 */
export function selectBranchEntries(branch: SessionEntry[], maxCompactions: number): SessionEntry[] {
  if (maxCompactions <= 0 || branch.length === 0) return branch;
  const compactionIndices: number[] = [];
  for (let i = 0; i < branch.length; i++) {
    if (branch[i]?.type === "compaction") compactionIndices.push(i);
  }
  if (compactionIndices.length <= maxCompactions) return branch;
  const startIndex = compactionIndices[compactionIndices.length - maxCompactions];
  return branch.slice(startIndex);
}

/**
 * Format a compaction summary message matching Pi's createCompactionSummaryMessage
 * shape (defined in core/messages.js, not exported on the top-level barrel).
 */
export function makeCompactionSummaryMessage(summary: string, tokensBefore: number, timestamp: string | number) {
  return {
    role: "compactionSummary" as const,
    summary,
    tokensBefore,
    timestamp: typeof timestamp === "string" ? Date.parse(timestamp) || Date.now() : timestamp,
  };
}

export default function (pi: ExtensionAPI) {
  const proto = InteractiveMode.prototype as unknown as InteractiveModeInternals;
  let installed = false;
  let ui: ExtensionContext["ui"] | undefined;
  let maxCompactions = Number.isFinite(DEFAULT_COMPACTIONS) ? DEFAULT_COMPACTIONS : 10;
  let activeMode: InteractiveModeInternals | undefined;
  let needsInitialBackfill = false;

  // Capture prototype methods lazily at install() time rather than module load
  // time, so chaining with other extensions (e.g. quiet-transcript's showStatus
  // wrapper) stays clean across /reload regardless of load order.
  let origRenderInitial: InteractiveModeInternals["renderInitialMessages"] | undefined;
  let origRebuildChat: InteractiveModeInternals["rebuildChatFromMessages"] | undefined;
  let origHandleEvent: InteractiveModeInternals["handleEvent"] | undefined;
  let origShowStatus: InteractiveModeInternals["showStatus"] | undefined;

  const uninstall = () => {
    installed = false;
    if (origRenderInitial && proto.renderInitialMessages === keepRenderInitial) proto.renderInitialMessages = origRenderInitial;
    if (origRebuildChat && proto.rebuildChatFromMessages === keepRebuildChat) proto.rebuildChatFromMessages = origRebuildChat;
    if (origHandleEvent && proto.handleEvent === keepHandleEvent) proto.handleEvent = origHandleEvent;
    if (origShowStatus && proto.showStatus === captureShowStatus) proto.showStatus = origShowStatus;
  };

  const fail = (error: unknown) => {
    if (!installed) return;
    uninstall();
    const held = ui;
    setTimeout(() => {
      held?.notify(
        `keep-scrollback turned itself off: ${error instanceof Error ? error.stack : String(error)}`,
        "error",
      );
    }, 0);
  };

  function getChronologicalEntries(mode: InteractiveModeInternals): SessionEntry[] {
    const branch = mode.sessionManager.getBranch();
    return selectBranchEntries(branch, maxCompactions);
  }

  function keepRenderInitial(this: InteractiveModeInternals): void {
    activeMode = this;
    try {
      const entries = getChronologicalEntries(this);
      this.renderSessionEntries(entries, {
        updateFooter: true,
        populateHistory: true,
      });
      this.renderProjectTrustWarningIfNeeded();
      const allEntries = this.sessionManager.getEntries();
      const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
      if (compactionCount > 0) {
        const shown = entries.filter((e) => e.type === "compaction").length;
        const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
        const scope = shown < compactionCount ? ` (showing last ${shown} in scrollback; /scrollback all for more)` : "";
        this.showStatus(`Session compacted ${times}${scope}`);
      }
    } catch (error) {
      fail(error);
      origRenderInitial?.call(this);
    }
  }

  function keepRebuildChat(this: InteractiveModeInternals): void {
    activeMode = this;
    try {
      this.chatContainer.clear();
      this.renderSessionEntries(getChronologicalEntries(this));
    } catch (error) {
      fail(error);
      origRebuildChat?.call(this);
    }
  }

  async function keepHandleEvent(this: InteractiveModeInternals, event: Record<string, unknown>): Promise<void> {
    activeMode = this;
    try {
      // 1. Live auto/manual compaction completion: append the compaction
      //    summary in place without clearing chatContainer!
      if (event.type === "compaction_end" && !event.aborted && event.result) {
        const origClear = this.chatContainer.clear;
        const origRender = this.renderSessionEntries;
        let suppressed = false;
        this.chatContainer.clear = () => {
          suppressed = true;
        };
        this.renderSessionEntries = ((...args: [SessionEntry[], Record<string, unknown>?]) => {
          if (suppressed) return;
          return origRender.apply(this, args);
        }) as typeof this.renderSessionEntries;
        try {
          await origHandleEvent?.call(this, event);
        } finally {
          this.chatContainer.clear = origClear;
          this.renderSessionEntries = origRender;
        }
        return;
      }

      // 2. Boundary compaction via entry_appended (type === "compaction"):
      //    Keep existing chatContainer contents, append the compaction summary,
      //    and render only any entries appended AFTER the compaction boundary.
      if (event.type === "entry_appended") {
        const entry = event.entry as SessionEntry | undefined;
        if (entry?.type === "compaction") {
          const entries = this.sessionManager.buildContextEntries();
          if (entries[0]?.id !== entry.id) return;
          const branch = this.sessionManager.getBranch();
          const compactionIndex = branch.findIndex((e) => e.id === entry.id);
          const afterCompaction = compactionIndex >= 0 ? branch.slice(compactionIndex + 1) : [];
          this.addMessageToChat(
            makeCompactionSummaryMessage(
              String(entry.summary ?? ""),
              Number(entry.tokensBefore ?? 0),
              entry.timestamp ?? new Date().toISOString(),
            ),
          );
          if (entry.usage) {
            this.addCompactionCostNotice({
              type: "compaction_cost",
              kind: "compaction",
              usage: entry.usage,
            });
          }
          if (afterCompaction.length > 0) {
            this.renderSessionEntries(afterCompaction);
            for (const after of afterCompaction) {
              if (after.id) this.entriesRenderedByBoundaryCompaction?.add(after.id);
            }
          }
          this.footer.invalidate();
          this.ui.requestRender();
          return;
        }
      }
    } catch (error) {
      fail(error);
    }
    return origHandleEvent?.call(this, event);
  }

  function captureShowStatus(this: InteractiveModeInternals, message: string): void {
    activeMode = this;
    origShowStatus?.call(this, message);
    if (needsInitialBackfill) {
      needsInitialBackfill = false;
      // Rebuild once right after /reload so pre-compaction messages appear in
      // scrollback immediately (without having to run /scrollback).
      setTimeout(() => {
        if (installed && activeMode) {
          keepRebuildChat.call(activeMode);
          origShowStatus?.call(activeMode, message);
        }
      }, 0);
    }
  }

  const install = () => {
    if (installed) return;
    origRenderInitial = proto.renderInitialMessages;
    origRebuildChat = proto.rebuildChatFromMessages;
    origHandleEvent = proto.handleEvent;
    origShowStatus = proto.showStatus;
    installed = true;
    proto.renderInitialMessages = keepRenderInitial;
    proto.rebuildChatFromMessages = keepRebuildChat;
    proto.handleEvent = keepHandleEvent;
    proto.showStatus = captureShowStatus;
  };

  pi.registerCommand("scrollback", {
    description: "Set how many compactions to keep in scrollback (e.g. /scrollback 10, /scrollback all)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (!arg) {
        const label = maxCompactions <= 0 ? "all" : `last ${maxCompactions} compactions`;
        ctx.ui.notify(`keep-scrollback: showing ${label} (usage: /scrollback <N|all>)`, "info");
        return;
      }
      if (arg === "all" || arg === "0") {
        maxCompactions = 0;
      } else {
        const parsed = Number.parseInt(arg, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          ctx.ui.notify(`keep-scrollback: expected a positive number or "all", got "${arg}"`, "error");
          return;
        }
        maxCompactions = parsed;
      }
      if (activeMode) {
        keepRebuildChat.call(activeMode);
        const label = maxCompactions <= 0 ? "all compactions" : `last ${maxCompactions} compactions`;
        ctx.ui.notify(`keep-scrollback: rebuilt transcript (${label})`, "info");
      } else {
        ctx.ui.notify(`keep-scrollback: set to ${maxCompactions <= 0 ? "all" : maxCompactions}; takes effect on next render`, "info");
      }
    },
  });

  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    ui = ctx.ui;
    needsInitialBackfill = event.reason === "reload";
    install();
  });

  // Also notice InteractiveMode on its very next render after /reload:
  // quiet-transcript wraps Container.render, while here captureShowStatus and
  // keepHandleEvent capture activeMode automatically on the first event or
  // status message (including /reload's "Reloaded ...").
  pi.on("session_shutdown", () => {
    uninstall();
    ui = undefined;
    activeMode = undefined;
  });
}
