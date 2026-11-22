// Unit tests for keep-scrollback.ts (selectBranchEntries, compaction_end without
// clearing chatContainer, entry_appended compaction keeping history + rendering
// post-compaction entries, renderInitialMessages depth window, /scrollback cmd,
// and clean uninstall).
//
//   node test-keep-scrollback.mjs
//
// Which Pi it runs against: PI_PACKAGE_DIR (a package root, the directory that
// holds dist/index.js), else the build of the repository this file is in
// (johnservil/pi: ../packages/coding-agent), else an npm install in one of the
// usual places.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const piRoot = [
  process.env.PI_PACKAGE_DIR,
  path.join(here, "../packages/coding-agent"),
  path.join(os.homedir(), ".local/node/lib/node_modules/@earendil-works/pi-coding-agent"),
  path.join(os.homedir(), ".local/lib/node_modules/@earendil-works/pi-coding-agent"),
  "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
  "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent",
].find((root) => root && fs.existsSync(path.join(root, "dist/index.js")));
assert.ok(piRoot, "could not find @earendil-works/pi-coding-agent (a directory with dist/index.js); set PI_PACKAGE_DIR");

// Load through jiti with Pi's module resolution, the same way Pi loads extensions.
const require = createRequire(path.join(piRoot, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(path.join(piRoot, "dist/index.js"), {
  alias: { "@earendil-works/pi-coding-agent": path.join(piRoot, "dist/index.js") },
});
const piMod = await jiti.import(path.join(piRoot, "dist/index.js"));
const { InteractiveMode } = piMod;

const extPath = path.join(here, "keep-scrollback.ts");
const extMod = await jiti.import(extPath);
const { selectBranchEntries, makeCompactionSummaryMessage, default: setup } = extMod;

// 1. selectBranchEntries
{
  const branch = [];
  for (let c = 1; c <= 12; c++) {
    branch.push({ type: "message", id: `m${c}a` });
    branch.push({ type: "message", id: `m${c}b` });
    branch.push({ type: "compaction", id: `c${c}`, summary: `s${c}`, tokensBefore: 1000 * c });
  }
  branch.push({ type: "message", id: "after" });

  // maxCompactions = 3 -> starts at c10 (includes c10, c11, c12, and "after")
  const last3 = selectBranchEntries(branch, 3);
  assert.equal(last3[0].id, "c10");
  assert.equal(last3[last3.length - 1].id, "after");
  assert.equal(last3.filter((e) => e.type === "compaction").length, 3);

  // maxCompactions = 0 -> whole branch
  const all = selectBranchEntries(branch, 0);
  assert.equal(all.length, branch.length);
  assert.equal(all[0].id, "m1a");

  // maxCompactions >= total -> whole branch
  const plenty = selectBranchEntries(branch, 50);
  assert.equal(plenty.length, branch.length);
}

// 2. Patching InteractiveMode.prototype & live compaction_end / entry_appended / /scrollback
{
  const proto = InteractiveMode.prototype;
  const savedRenderInitial = proto.renderInitialMessages;
  const savedRebuild = proto.rebuildChatFromMessages;
  const savedHandleEvent = proto.handleEvent;
  const savedShowStatus = proto.showStatus;

  const handlers = new Map();
  const commands = new Map();
  const fakePi = {
    on(name, fn) {
      handlers.set(name, fn);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
  };

  setup(fakePi);

  const notifications = [];
  const fakeCtx = {
    mode: "tui",
    ui: {
      notify(msg, kind) {
        notifications.push({ msg, kind });
      },
    },
  };

  // Start session -> patches installed
  handlers.get("session_start")({ reason: "startup" }, fakeCtx);
  assert.notEqual(proto.renderInitialMessages, savedRenderInitial);
  assert.notEqual(proto.handleEvent, savedHandleEvent);

  // Build a fake InteractiveMode instance with prototype = InteractiveMode.prototype
  const branch = [
    { type: "message", id: "u1" },
    { type: "compaction", id: "c1", summary: "sum1", tokensBefore: 500000, timestamp: "2026-11-22T10:00:00Z" },
    { type: "message", id: "u2" },
    { type: "compaction", id: "c2", summary: "sum2", tokensBefore: 600000, timestamp: "2026-11-22T12:00:00Z" },
    { type: "message", id: "u3" },
  ];
  const fakeMode = Object.create(proto);
  const renderedLog = [];
  const addedMessages = [];
  const statusLog = [];
  let clears = 0;
  let rendersRequested = 0;
  let footerInvalidated = 0;

  const smObj = {
    getBranch: () => branch,
    getEntries: () => branch,
    buildContextEntries: () => [branch[3], branch[4]],
  };
  Object.defineProperty(fakeMode, "sessionManager", { value: smObj, configurable: true });
  Object.defineProperty(fakeMode, "settingsManager", {
    value: {
      getShowTerminalProgress: () => true,
      getShowCacheMissNotices: () => false,
    },
    configurable: true,
  });
  fakeMode.chatContainer = {
    children: ["existing-1", "existing-2"],
    clear() {
      clears += 1;
      this.children = [];
    },
  };
  fakeMode.entriesRenderedByBoundaryCompaction = new Set();
  fakeMode.footer = { invalidate() { footerInvalidated += 1; } };
  fakeMode.ui = { requestRender() { rendersRequested += 1; } };
  fakeMode.renderSessionEntries = (entries) => {
    renderedLog.push(entries.map((e) => e.id));
  };
  fakeMode.renderProjectTrustWarningIfNeeded = () => {};
  fakeMode.showStatus = (msg) => {
    statusLog.push(msg);
  };
  fakeMode.addMessageToChat = (msg) => {
    addedMessages.push(msg);
  };
  fakeMode.addCompactionCostNotice = () => {};

  // 2a. renderInitialMessages renders the whole chronological branch (2 compactions <= 10)
  proto.renderInitialMessages.call(fakeMode);
  assert.deepEqual(renderedLog, [["u1", "c1", "u2", "c2", "u3"]]);
  assert.equal(statusLog.length, 1);
  assert.match(statusLog[0], /Session compacted 2 times/);

  // 2b. entry_appended compaction does NOT clear chatContainer, appends summary + renders post-compaction
  renderedLog.length = 0;
  addedMessages.length = 0;
  clears = 0;
  await proto.handleEvent.call(fakeMode, { type: "entry_appended", entry: branch[3] });
  assert.equal(clears, 0, "entry_appended compaction must not clear chatContainer");
  assert.equal(fakeMode.chatContainer.children.length, 2, "existing children preserved");
  assert.equal(addedMessages.length, 1);
  assert.equal(addedMessages[0].role, "compactionSummary");
  assert.equal(addedMessages[0].summary, "sum2");
  assert.deepEqual(renderedLog, [["u3"]]);
  assert.ok(fakeMode.entriesRenderedByBoundaryCompaction.has("u3"));

  // 2c. /scrollback 1 narrows to 1 compaction and rebuilds
  renderedLog.length = 0;
  clears = 0;
  await commands.get("scrollback").handler("1", fakeCtx);
  assert.equal(clears, 1);
  assert.deepEqual(renderedLog, [["c2", "u3"]]);

  // 2d. /scrollback all restores entire branch
  renderedLog.length = 0;
  clears = 0;
  await commands.get("scrollback").handler("all", fakeCtx);
  assert.equal(clears, 1);
  assert.deepEqual(renderedLog, [["u1", "c1", "u2", "c2", "u3"]]);

  // 2e. compaction_end keeps chatContainer intact while letting Pi's own cleanup
  //     and summary append run! Verify directly against InteractiveMode.prototype.handleEvent.
  fakeMode.chatContainer.children = ["existing-1", "existing-2"];
  renderedLog.length = 0;
  addedMessages.length = 0;
  clears = 0;
  let clearedStatusIndicator = false;
  let flushedQueue = false;
  let progressSet = null;
  let restoredEscape = false;
  fakeMode.isInitialized = true;
  fakeMode.programStatus = { handleEvent() {} };
  fakeMode.ui = {
    requestRender() { rendersRequested += 1; },
    terminal: { setProgress(v) { progressSet = v; } },
  };
  fakeMode.autoCompactionEscapeHandler = () => { restoredEscape = true; };
  fakeMode.defaultEditor = { onEscape: null };
  fakeMode.clearStatusIndicator = () => { clearedStatusIndicator = true; };
  fakeMode.flushCompactionQueue = async () => { flushedQueue = true; };
  await proto.handleEvent.call(fakeMode, {
    type: "compaction_end",
    aborted: false,
    willRetry: false,
    result: { summary: "live summary", tokensBefore: 667000 },
  });
  assert.equal(clears, 0, "compaction_end must NOT clear chatContainer");
  assert.equal(fakeMode.chatContainer.children.length, 2, "existing children preserved on compaction_end");
  assert.equal(renderedLog.length, 0, "compaction_end must NOT re-render entries.slice(1) into existing chat");
  assert.equal(addedMessages.length, 1, "compaction summary appended once");
  assert.equal(addedMessages[0].role, "compactionSummary");
  assert.equal(addedMessages[0].summary, "live summary");
  assert.equal(clearedStatusIndicator, true, "Pi's status indicator cleanup still ran");
  assert.equal(flushedQueue, true, "Pi's compaction queue flush still ran");
  assert.equal(progressSet, false, "Pi's terminal progress cleared");
  assert.ok(fakeMode.defaultEditor.onEscape, "Pi's escape handler restored");

  // Test makeCompactionSummaryMessage
  const sm = makeCompactionSummaryMessage("hello", 666666, "2026-11-22T15:00:00Z");
  assert.equal(sm.role, "compactionSummary");
  assert.equal(sm.tokensBefore, 666666);
  assert.equal(sm.timestamp, Date.parse("2026-11-22T15:00:00Z"));

  // 2f. session_shutdown restores all original prototype methods
  handlers.get("session_shutdown")();
  assert.equal(proto.renderInitialMessages, savedRenderInitial);
  assert.equal(proto.rebuildChatFromMessages, savedRebuild);
  assert.equal(proto.handleEvent, savedHandleEvent);
  assert.equal(proto.showStatus, savedShowStatus);
}

const piVersion = JSON.parse(fs.readFileSync(path.join(piRoot, "package.json"), "utf8")).version;
console.log(`keep-scrollback: every check passes (Pi ${piVersion} at ${piRoot})`);
