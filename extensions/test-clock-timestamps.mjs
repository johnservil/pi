// Unit tests for clock-timestamps.ts (single-row clock footer without
// token/cache clutter, cost caching per leafId, inline & block-start event
// timestamps for persisted and live streaming messages, /timestamps toggle,
// and clean shutdown/disposal).
//
//   node extensions/test-clock-timestamps.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const tuiCandidates = [
  path.join(repoRoot, "packages/tui/dist/index.js"),
  ...(fs.existsSync(path.join(repoRoot, "node_modules")) ? [path.join(repoRoot, "packages/tui/src/index.ts")] : []),
];
const tuiEntry = tuiCandidates.find((p) => fs.existsSync(p));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-tui") {
      if (tuiEntry) {
        return { url: pathToFileURL(tuiEntry).href, shortCircuit: true };
      }
      return { url: "pi-tui-stub:", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "pi-tui-stub:") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const strip = (s) => s.replace(/\\x1b\\[[0-9;]*m/g, "");
          export const visibleWidth = (s) => strip(s).length;
          export const truncateToWidth = (s, w, ell = "...") => {
            const plain = strip(s);
            if (plain.length <= w) return plain;
            const keep = Math.max(0, w - ell.length);
            return plain.slice(0, keep) + ell.slice(0, w - keep);
          };
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { default: extension } = await import(pathToFileURL(path.join(here, "clock-timestamps.ts")).href);

const handlers = new Map();
const commands = new Map();
let transformer = null;
let transformerOpts = null;
let footerFactory = null;

const pi = {
  on(event, fn) {
    handlers.set(event, fn);
  },
  registerMarkdownTransformer(fn, opts) {
    transformer = fn;
    transformerOpts = opts;
  },
  registerCommand(name, def) {
    commands.set(name, def);
  },
  getThinkingLevel() {
    return "low";
  },
};

extension(pi);
assert.ok(transformer, "markdown transformer registered");
assert.deepEqual(transformerOpts.messageTypes, ["user", "assistant", "custom", "summary"]);

let entriesCalls = 0;
const statuses = [];
const notices = [];
const ctx = {
  mode: "tui",
  model: { id: "claude-opus-4-6", reasoning: true, contextWindow: 1_000_000 },
  getContextUsage() {
    return { tokens: 123_400, contextWindow: 1_000_000, percent: 12.34 };
  },
  sessionManager: {
    getLeafId() {
      return "leaf-1";
    },
    getEntries() {
      entriesCalls++;
      return [{ type: "message", message: { role: "assistant", usage: { cost: { total: 1.234 } } } }];
    },
  },
  ui: {
    setStatus(key, text) {
      statuses.push([key, text]);
    },
    setFooter(factory) {
      footerFactory = factory;
    },
    getToolsExpanded() {
      return false;
    },
    notify(msg, level) {
      notices.push([msg, level]);
    },
    theme: {
      fg(_color, text) {
        return text;
      },
    },
  },
};

// 1. Single-row clock footer removes token/cache clutter and caches cost per leaf.
handlers.get("session_start")({}, ctx);
assert.ok(footerFactory, "setFooter called");
const comp = footerFactory(
  { requestRender() {} },
  ctx.ui.theme,
  {
    onBranchChange() {
      return () => {};
    },
    getExtensionStatuses() {
      return new Map();
    },
  },
);

const lines120 = comp.render(120);
assert.equal(lines120.length, 1, "footer stays 1 row");
assert.equal(lines120[0].length, 120, "footer fills 120 cols");
assert.ok(!/[↑↓]|CH\d/.test(lines120[0]), "no token/cache counters");
assert.ok(lines120[0].includes("$1.234"));
assert.ok(lines120[0].includes("12.3%/1.0M"));
assert.ok(lines120[0].includes("tools:collapsed"));
assert.ok(lines120[0].includes("claude-opus-4-6 • low"));

assert.equal(comp.render(80).length, 1, "footer stays 1 row at 80 cols");
assert.equal(comp.render(40).length, 1, "footer stays 1 row at 40 cols");
assert.equal(entriesCalls, 1, "session cost cached across renders on same leaf");

// 2. Inline timestamps on normal messages, single newline on block-level starts.
const nowIso = new Date().toISOString();
const inline = transformer("Hello world", {
  messageType: "user",
  isStreaming: false,
  availableWidth: 80,
  timestamp: nowIso,
});
assert.match(inline, /^\*\d{2}:\d{2}:\d{2}\* Hello world$/);

const heading = transformer("## Section\ntext", {
  messageType: "assistant",
  isStreaming: false,
  availableWidth: 80,
  timestamp: nowIso,
});
assert.match(heading, /^\*\d{2}:\d{2}:\d{2}\*\n## Section\ntext$/);

const priorDay = transformer("Earlier", {
  messageType: "user",
  isStreaming: false,
  availableWidth: 80,
  timestamp: "2025-01-15T08:09:10.000Z",
});
assert.equal(priorDay, "*2025-01-15 08:09:10* Earlier");

// 3. Live streaming assistant message freezes its timestamp across stream updates & resizes.
const t0 = Date.UTC(2025, 4, 1, 12, 34, 56);
handlers.get("message_start")({ message: { role: "assistant", timestamp: t0 } }, ctx);
const s1 = transformer("Part 1", { messageType: "assistant", isStreaming: true, availableWidth: 80 });
const s2 = transformer("Part 1 + 2", { messageType: "assistant", isStreaming: false, availableWidth: 80 });
handlers.get("message_end")({ message: { role: "assistant" } }, ctx);
handlers.get("message_start")({ message: { role: "assistant", timestamp: t0 + 60_000 } }, ctx);
const s2Resized = transformer("Part 1 + 2", { messageType: "assistant", isStreaming: false, availableWidth: 100 });
assert.equal(s1, "*2025-05-01 12:34:56* Part 1");
assert.equal(s2, s2Resized, "resize preserves original live timestamp");

// 4. Empty markdown untouched.
assert.equal(transformer("   ", { messageType: "user", isStreaming: false, availableWidth: 80 }), "   ");

// 5. /timestamps toggles cleanly.
await commands.get("timestamps").handler("", ctx);
assert.equal(transformer("Plain", { messageType: "user", isStreaming: false, availableWidth: 80 }), "Plain");
await commands.get("timestamps").handler("", ctx);
assert.match(transformer("Plain", { messageType: "user", isStreaming: false, availableWidth: 80 }), /^\*\d{2}:\d{2}:\d{2}\* Plain$/);

comp.dispose();
handlers.get("session_shutdown")({}, ctx);
console.log("test-clock-timestamps: all tests passed");
