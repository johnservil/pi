// Single-row status bar with live clock (replacing token/cache clutter) and
// per-event timestamps for Pi's TUI.
//
// - Replaces the default footer via `ctx.ui.setFooter(...)` with one compact
//   row: live clock, session cost, context %, tools state, and model/thinking
//   (removing ↑input, ↓output, R cache-read, W cache-write, and CH cache-hit%).
// - Stamps user messages, assistant replies, custom messages, and summaries
//   via Pi's official `registerMarkdownTransformer` API (zero monkey-patching;
//   compatible with `quiet-transcript.ts` and `keep-scrollback.ts`).
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MAX_LIVE_CACHE = 512;

const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

function tzLabel(d: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(d);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "UTC";
  } catch {
    return "UTC";
  }
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatClock(d: Date): string {
  return `${formatDate(d)} ${formatTime(d)} ${tzLabel(d)}`;
}

function formatEventStamp(d: Date, now: Date): string {
  if (formatDate(d) === formatDate(now)) {
    return formatTime(d);
  }
  return `${formatDate(d)} ${formatTime(d)}`;
}

// Block-level Markdown constructs whose opening syntax must stay at column 0.
const BLOCK_START = /^(?: {0,3}(?:#{1,6}(?:\s|$)|>|[-*+]\s|\d+[.)]\s|```|~~~|(?:\* *){3,}$|(?:_ *){3,}$|(?:- *){3,}$)|\|)/;

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function parseTimestamp(raw: string | number | undefined): Date | undefined {
  if (raw === undefined) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default function (pi: ExtensionAPI) {
  let timestampsEnabled = true;

  // Timestamps captured from live `message_start` events (epoch ms).
  const latestByRole = new Map<string, number>();
  // Frozen timestamp for the currently streaming assistant message.
  let streamingAssistantTs: number | undefined;
  // Frozen timestamps for live messages across terminal resizes (until persisted/reloaded).
  const liveCache = new Map<string, number>();

  function rememberLive(key: string, ts: number): void {
    if (liveCache.size >= MAX_LIVE_CACHE) {
      const oldest = liveCache.keys().next().value;
      if (oldest !== undefined) liveCache.delete(oldest);
    }
    liveCache.set(key, ts);
  }

  function cacheKey(context: MarkdownTransformContext, markdown: string): string {
    return `${context.messageType}\0${markdown.length}\0${markdown.slice(0, 160)}`;
  }

  function resolveTimestamp(context: MarkdownTransformContext, markdown: string): Date {
    const persisted = parseTimestamp(context.timestamp);
    if (persisted) return persisted;

    if (context.messageType === "assistant" && context.isStreaming) {
      if (streamingAssistantTs === undefined) {
        streamingAssistantTs = latestByRole.get("assistant") ?? Date.now();
      }
      return new Date(streamingAssistantTs);
    }

    const key = cacheKey(context, markdown);
    const cached = liveCache.get(key);
    if (cached !== undefined) return new Date(cached);

    let ts: number;
    if (context.messageType === "assistant" && streamingAssistantTs !== undefined) {
      ts = streamingAssistantTs;
      streamingAssistantTs = undefined;
    } else {
      ts = latestByRole.get(context.messageType) ?? Date.now();
    }
    rememberLive(key, ts);
    return new Date(ts);
  }

  function installFooter(ctx: ExtensionContext): void {
    ctx.ui.setFooter((tui, theme, footerData) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cachedLeaf: string | null | undefined = undefined;
      let cachedCost = 0;

      const scheduleTick = () => {
        const delay = Math.max(50, 1000 - (Date.now() % 1000));
        timer = setTimeout(() => {
          tui.requestRender();
          scheduleTick();
        }, delay);
        if (typeof timer === "object" && "unref" in timer) {
          timer.unref();
        }
      };
      scheduleTick();

      const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

      function sessionCost(): number {
        const leaf = ctx.sessionManager.getLeafId();
        if (leaf === cachedLeaf) return cachedCost;
        let total = 0;
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            const msg = entry.message as AssistantMessage;
            total += msg.usage?.cost?.total ?? 0;
          }
        }
        cachedLeaf = leaf;
        cachedCost = total;
        return total;
      }

      return {
        dispose() {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          unsubBranch();
        },
        invalidate() {},
        render(width: number): string[] {
          const clock = formatClock(new Date());
          const cost = sessionCost();
          const usage = ctx.getContextUsage();
          const ctxWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const pctVal = usage?.percent ?? 0;
          const pctLabel =
            usage && usage.percent !== null
              ? `${pctVal.toFixed(1)}%/${formatTokens(ctxWindow)}`
              : `?/${formatTokens(ctxWindow)}`;
          const pctStyled =
            pctVal > 90
              ? theme.fg("error", pctLabel)
              : pctVal > 70
                ? theme.fg("warning", pctLabel)
                : theme.fg("dim", pctLabel);

          const leftParts = [theme.fg("dim", clock)];
          if (cost > 0) leftParts.push(theme.fg("dim", `$${cost.toFixed(3)}`));
          leftParts.push(pctStyled);
          let left = leftParts.join("  ");
          if (visibleWidth(left) > width) {
            left = truncateToWidth(left, width, "...");
          }

          const modelId = ctx.model?.id || "no-model";
          let rightText = modelId;
          if (ctx.model?.reasoning) {
            const level = pi.getThinkingLevel() || "off";
            rightText = level === "off" ? `${modelId} • thinking off` : `${modelId} • ${level}`;
          }
          const right = theme.fg("dim", rightText);

          const leftW = visibleWidth(left);
          const rightW = visibleWidth(right);
          const gap = width - leftW - rightW;

          let row: string;
          if (gap >= 2) {
            const toolsBadge = ctx.ui.getToolsExpanded() ? "tools:expanded" : "tools:collapsed";
            const middlePlain = `  ${toolsBadge}  `;
            if (gap >= middlePlain.length) {
              const padL = Math.floor((gap - middlePlain.length) / 2);
              const padR = gap - middlePlain.length - padL;
              row = left + " ".repeat(padL) + theme.fg("dim", middlePlain) + " ".repeat(padR) + right;
            } else {
              row = left + " ".repeat(gap) + right;
            }
          } else {
            const avail = width - leftW - 2;
            if (avail > 0) {
              const truncRight = truncateToWidth(right, avail, "");
              const pad = " ".repeat(Math.max(0, width - leftW - visibleWidth(truncRight)));
              row = left + pad + truncRight;
            } else {
              row = left;
            }
          }

          const lines = [row];
          const statuses = footerData.getExtensionStatuses();
          if (statuses.size > 0) {
            const statusText = Array.from(statuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => text.replace(/[\r\n\t]+/g, " ").trim())
              .filter(Boolean)
              .join(" ");
            if (statusText) {
              lines.push(truncateToWidth(statusText, width, theme.fg("dim", "...")));
            }
          }
          return lines;
        },
      };
    });
  }

  pi.registerMarkdownTransformer(
    (markdown, context) => {
      if (!timestampsEnabled || !markdown.trim()) return markdown;
      const d = resolveTimestamp(context, markdown);
      const stamp = formatEventStamp(d, new Date());
      const trimmed = markdown.trimStart();
      if (BLOCK_START.test(trimmed)) {
        return `*${stamp}*\n${markdown}`;
      }
      return `*${stamp}* ${markdown}`;
    },
    { messageTypes: ["user", "assistant", "custom", "summary"] },
  );

  pi.on("message_start", (event) => {
    const msg = event.message as { role?: string; timestamp?: number } | undefined;
    if (!msg?.role) return;
    const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
    latestByRole.set(msg.role, ts);
    if (msg.role === "assistant") {
      streamingAssistantTs = ts;
    }
  });

  pi.on("message_end", (event) => {
    const msg = event.message as { role?: string } | undefined;
    if (msg?.role === "assistant") {
      streamingAssistantTs = undefined;
    }
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus("clock", undefined);
    installFooter(ctx);
  });

  pi.on("session_shutdown", () => {
    latestByRole.clear();
    liveCache.clear();
    streamingAssistantTs = undefined;
  });

  pi.registerCommand("timestamps", {
    description: "Toggle event timestamps in the transcript (on/off)",
    handler: async (_args, ctx) => {
      timestampsEnabled = !timestampsEnabled;
      ctx.ui.notify(`Event timestamps: ${timestampsEnabled ? "on" : "off"}`, "info");
    },
  });
}
