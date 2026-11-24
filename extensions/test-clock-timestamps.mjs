// Tests for extensions/clock-timestamps.ts:
//   1. Renders `think:{expanded,collapsed} • tools:{expanded,collapsed}` via ctx.ui.getThinkingExpanded().
//   2. Caches ctx.getContextUsage() and sessionManager.getEntries() across repeated renders (scroll frames).
//   3. Invalidates cache immediately when leafId / entryCount / model changes.
//   4. Gracefully narrows to `tools:...` when width is tight, and falls back to settings.json on stock Pi.
//   5. Stamps markdown messages with timestamps.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const codingAgentDir = process.env.PI_PACKAGE_DIR || join(repoRoot, "packages", "coding-agent");
const require = createRequire(join(codingAgentDir, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-tui": join(repoRoot, "packages", "tui", "dist", "index.js"),
    "@earendil-works/pi-ai": join(repoRoot, "packages", "ai", "dist", "index.js"),
    "@earendil-works/pi-coding-agent": join(codingAgentDir, "dist", "index.js"),
  },
});

const mod = await jiti.import(join(__dirname, "clock-timestamps.ts"));
const extensionFactory = mod.default;
assert.equal(typeof extensionFactory, "function");

function harness({ hasGetThinkingExpanded = true, initialThinkingExpanded = true, initialToolsExpanded = false } = {}) {
  const handlers = new Map();
  let markdownTransformer;
  let footerFactory;
  let thinkingExpanded = initialThinkingExpanded;
  let toolsExpanded = initialToolsExpanded;
  let leafId = "leaf-1";
  let entries = [
    { type: "message", message: { role: "assistant", usage: { cost: { total: 1.25 } } } },
    { type: "compaction", usage: { cost: { total: 0.5 } } },
  ];
  let model = { provider: "openrouter", id: "google/gemini-4-neon", contextWindow: 1_000_000, reasoning: true };
  let getEntriesCalls = 0;
  let getContextUsageCalls = 0;
  let branchCb;

  const pi = {
    on(event, fn) {
      handlers.set(event, fn);
    },
    registerMarkdownTransformer(fn) {
      markdownTransformer = fn;
    },
    registerCommand() {},
    getThinkingLevel() {
      return "xhigh";
    },
  };

  extensionFactory(pi);

  const ui = {
    setStatus() {},
    setFooter(factory) {
      footerFactory = factory;
    },
    getToolsExpanded: () => toolsExpanded,
    notify() {},
  };
  if (hasGetThinkingExpanded) {
    ui.getThinkingExpanded = () => thinkingExpanded;
  }

  const ctx = {
    mode: "tui",
    ui,
    get model() {
      return model;
    },
    getContextUsage() {
      getContextUsageCalls++;
      return { tokens: 250_000, contextWindow: model.contextWindow, percent: 25.0 };
    },
    sessionManager: {
      getSessionId: () => "sess-1",
      getLeafId: () => leafId,
      getEntryCount: () => entries.length,
      getEntries() {
        getEntriesCalls++;
        return entries;
      },
    },
  };

  handlers.get("session_start")({}, ctx);
  assert.ok(footerFactory, "session_start should register footer");

  const theme = { fg: (_c, s) => s };
  const footerData = {
    onBranchChange(cb) {
      branchCb = cb;
      return () => {};
    },
    getExtensionStatuses: () => new Map(),
  };
  const tui = { requestRender() {} };
  const footer = footerFactory(tui, theme, footerData);

  return {
    footer,
    markdownTransformer,
    setThinkingExpanded: (v) => (thinkingExpanded = v),
    setToolsExpanded: (v) => (toolsExpanded = v),
    appendEntry: (e, nextLeaf) => {
      entries = [...entries, e];
      leafId = nextLeaf;
    },
    setModel: (m) => (model = m),
    triggerBranchChange: () => branchCb?.(),
    counts: () => ({ getEntriesCalls, getContextUsageCalls }),
    dispose: () => {
      footer.dispose();
      handlers.get("session_shutdown")?.();
    },
  };
}

// Test 1: think + tools badges + caching across 100 scroll frames
{
  const h = harness({ hasGetThinkingExpanded: true, initialThinkingExpanded: true, initialToolsExpanded: false });
  try {
    let row = h.footer.render(140)[0];
    assert.match(row, /\$1\.750/, `expected summed cost $1.750 in: ${row}`);
    assert.match(row, /25\.0%\/1\.0M/, `expected context % in: ${row}`);
    assert.match(row, /think:expanded • tools:collapsed/, `expected think+tools badge in: ${row}`);
    assert.match(row, /google\/gemini-4-neon • xhigh/, `expected model+thinking in: ${row}`);

    // Simulate 100 scroll frames with no session changes: must stay O(1) (1 call total!)
    for (let i = 0; i < 100; i++) {
      h.footer.render(140);
    }
    assert.deepEqual(h.counts(), { getEntriesCalls: 1, getContextUsageCalls: 1 });

    // Toggle thinking & tools live — updates immediately without re-scanning session!
    h.setThinkingExpanded(false);
    h.setToolsExpanded(true);
    row = h.footer.render(140)[0];
    assert.match(row, /think:collapsed • tools:expanded/, `expected live toggle in: ${row}`);
    assert.deepEqual(h.counts(), { getEntriesCalls: 1, getContextUsageCalls: 1 });

    // Narrow width gracefully falls back to tools badge alone
    const narrow = h.footer.render(92)[0];
    assert.match(narrow, /tools:expanded/, `expected compact tools badge in: ${narrow}`);
    assert.doesNotMatch(narrow, /think:collapsed/);

    // Appending an entry invalidates both cost & context usage once
    h.appendEntry({ type: "message", message: { role: "assistant", usage: { cost: { total: 0.25 } } } }, "leaf-2");
    row = h.footer.render(140)[0];
    assert.match(row, /\$2\.000/, `expected updated cost $2.000 in: ${row}`);
    assert.deepEqual(h.counts(), { getEntriesCalls: 2, getContextUsageCalls: 2 });

    // Model switch refreshes contextUsage without re-scanning cost entries
    h.setModel({ provider: "anthropic", id: "claude-fable", contextWindow: 200_000, reasoning: false });
    row = h.footer.render(140)[0];
    assert.match(row, /25\.0%\/200k/, `expected updated context window in: ${row}`);
    assert.deepEqual(h.counts(), { getEntriesCalls: 2, getContextUsageCalls: 3 });

    // Markdown transformer stamps message
    const stamped = h.markdownTransformer("hello world", { messageType: "user", timestamp: "2026-11-24T18:30:00Z", isStreaming: false });
    assert.match(stamped, /^\*.*\* hello world$/);
  } finally {
    h.dispose();
  }
}

// Test 2: stock-Pi fallback reads hideThinkingBlock from settings.json
{
  const tmp = mkdtempSync(join(tmpdir(), "pi-clock-test-"));
  const prevDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmp;
  try {
    writeFileSync(join(tmp, "settings.json"), JSON.stringify({ hideThinkingBlock: true }));
    const h = harness({ hasGetThinkingExpanded: false });
    try {
      const row = h.footer.render(140)[0];
      assert.match(row, /think:collapsed • tools:collapsed/, `expected settings.json fallback in: ${row}`);
    } finally {
      h.dispose();
    }
  } finally {
    if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevDir;
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("test-clock-timestamps: all tests passed");
