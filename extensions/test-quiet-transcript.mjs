// Tests for quiet-transcript.ts, on Pi's own components: the rows it lays out, that a frame lays
// out again only what changed and gives the same rows as laying everything out, clicks on markers,
// the reader's place, and that it puts Pi's methods back.
//
//   node test-quiet-transcript.mjs
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
const tuiPath = require.resolve("@earendil-works/pi-tui");
const { createJiti } = require("jiti");
const jiti = createJiti(path.join(piRoot, "dist/index.js"), {
  alias: { "@earendil-works/pi-coding-agent": path.join(piRoot, "dist/index.js"), "@earendil-works/pi-tui": tuiPath },
});
const pi = await import(path.join(piRoot, "dist/index.js"));
const tui = await import(tuiPath);
const { theme } = await import(path.join(piRoot, "dist/modes/interactive/theme/theme.js"));
const { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, FooterComponent, InteractiveMode } = pi;
const { Container, ScrollView, Spacer, Text } = tui;
pi.initTheme("dark");

const stock = {
  render: Container.prototype.render,
  updateLayout: ScrollView.prototype.updateLayout,
  footer: FooterComponent.prototype.render,
  showStatus: InteractiveMode.prototype.showStatus,
};
const handlers = {};
(await jiti.import(path.join(here, "quiet-transcript.ts"))).default({ on(name, fn) { handlers[name] = fn; } });
let label = "Thinking...";
const notes = [];
const ui = {
  theme,
  getToolsExpanded: () => false,
  setHiddenThinkingLabel: (text) => { label = text ?? "Thinking..."; },
  notify: (message) => { notes.push(String(message)); },
};
handlers.session_start({}, { mode: "tui", ui });
assert.notEqual(Container.prototype.render, stock.render);
assert.match(label, /^\[think\.\.\.\]/);

const WIDTH = 60;
// A row as a reader sees it: no colours, no marks, no spaces at the end.
const plain = (line) =>
  line.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07|\x1b_[^\x1b]*\x1b\\|\x1b\]133;[ABC](?:\x07|\x1b\\)/g, "").trimEnd();
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (content) => ({ role: "assistant", content, api: "x", provider: "x", model: "x", usage, stopReason: "stop", timestamp: 1 });
const fakeUi = { requestRender() {}, terminal: { rows: 40, columns: WIDTH } };
const assistant = (content) => new AssistantMessageComponent(message(content), true, pi.getMarkdownTheme(), label, 1);
const user = (text) => new UserMessageComponent(text, pi.getMarkdownTheme(), 1);
let toolId = 0;
const tool = (name, args, output) => {
  const id = `t${++toolId}`;
  const component = new ToolExecutionComponent(name, id, args, { showImages: false, outputPad: 1 }, undefined, fakeUi, "/tmp");
  component.setExpanded(false);
  if (output !== undefined) {
    component.updateResult({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: output }], isError: false, timestamp: 1 });
  }
  return component;
};
const thinking = (text) => ({ type: "thinking", thinking: text });
const text = (words) => ({ type: "text", text: words });
// What the pointer finds under each row, without the extension's own classes.
const parts = (container) =>
  container.mouseLayout.children.map((part) =>
    part.rows
      ? { markers: part.rows.map((row) => row.map((marker) => [plain(marker.text), container.children.indexOf(marker.owner)])), height: part.height }
      : { child: container.children.indexOf(part.child), first: part.first, total: part.total, height: part.height },
  );
const click = (x, y, height) => ({ type: "click", button: "left", x, y, width: WIDTH, height, screenX: x, screenY: y, shift: false, alt: false, ctrl: false });

// 1. The rows: neighbouring markers share a row, and it takes the place of the blank rows.
{
  const chat = new Container();
  const read = tool("read", { path: "a.txt" }, "alpha\nbeta");
  const count = tool("bash", { command: "wc -l a.txt" }, "2 a.txt");
  chat.addChild(new Spacer(1));
  chat.addChild(user("What is in the file?"));
  chat.addChild(assistant([thinking("I should read it.")]));
  chat.addChild(read);
  chat.addChild(count);
  chat.addChild(assistant([thinking("Two lines."), text("It has two lines: alpha and beta.")]));
  assert.deepEqual(chat.render(WIDTH).map(plain), [
    "",
    "",
    " What is in the file?",
    "",
    " [think...] [tool...] [tool...] [think...]",
    " It has two lines: alpha and beta.",
  ]);

  // A click on the first tool's marker opens that tool, through Pi's own search for the block
  // under the pointer.
  const rows = chat.render(WIDTH);
  const at = plain(rows[4]).indexOf("[tool...]");
  assert.ok(chat.handleMouse(click(at + 1, 4, rows.length)), "the click was not taken");
  assert.equal(read.expanded, true);
  assert.equal(count.expanded, false);
  assert.deepEqual(chat.render(WIDTH).map(plain), [
    "",
    "",
    " What is in the file?",
    "",
    " [think...]",
    "",
    " read",
    "",
    " {",
    '   "path": "a.txt"',
    " }",
    " alpha",
    " beta",
    "",
    " [tool...] [think...]",
    " It has two lines: alpha and beta.",
  ]);

  // A click on a thinking marker shows that message's thinking, and no other's.
  const open = chat.render(WIDTH);
  assert.ok(chat.handleMouse(click(2, 4, open.length)), "the click was not taken");
  const shown = chat.render(WIDTH).map(plain);
  assert.ok(shown.includes(" I should read it."), "the thinking under the marker is not shown");
  assert.ok(!shown.includes(" Two lines."), "another message's thinking is shown");
  assert.equal(shown.at(-2), " [tool...] [think...]");
  assert.equal(notes.length, 0, notes[0]);
}

// 2. A frame with nothing new gives the very array it gave; a frame with something new gives a new
//    one and leaves the old one as it was, because Pi may still hold it.
{
  const chat = new Container();
  chat.addChild(user("hello"));
  chat.addChild(assistant([text("first answer")]));
  const before = chat.render(WIDTH);
  assert.equal(chat.render(WIDTH), before);
  const copy = [...before];
  const firstPart = chat.mouseLayout.children[0];
  chat.addChild(tool("bash", { command: "true" }, "ok"));
  chat.addChild(assistant([text("second answer")]));
  const after = chat.render(WIDTH);
  assert.notEqual(after, before);
  assert.deepEqual(before, copy);
  assert.equal(after.length, before.length + 2);
  // Only the end was laid out again: the part for the first rows is the one it was.
  assert.equal(chat.mouseLayout.children[0], firstPart);
  assert.equal(chat.render(WIDTH), after);
}

// 3. Laying out only what changed gives what laying out everything gives, through a long run of
//    the changes a session makes. `kept` draws frame after frame; a new container each time holds
//    the same children and has nothing to go by.
{
  let seed = 20261123;
  const random = () => {
    seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    return seed / 0x100000000;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const words = "the quick brown fox jumps over the lazy dog and reads every row again".split(" ");
  const sentence = (n) => Array.from({ length: n }, () => pick(words)).join(" ");
  const kept = new Container();
  const tools = [];
  const answers = [];
  const add = {
    answer: () => {
      const component = assistant([...(random() < 0.7 ? [thinking(sentence(20))] : []), ...(random() < 0.6 ? [text(`${sentence(8)}\n\n${sentence(30)}`)] : [])]);
      answers.push(component);
      kept.addChild(component);
    },
    tool: () => {
      const component = tool(pick(["bash", "read"]), { command: sentence(3) }, random() < 0.7 ? `${sentence(6)}\n${sentence(6)}` : undefined);
      tools.push(component);
      kept.addChild(component);
    },
    question: () => { kept.addChild(new Spacer(1)); kept.addChild(user(sentence(12))); },
    note: () => { kept.addChild(new Spacer(1 + Math.floor(random() * 2))); kept.addChild(new Text(sentence(5), 1, 0)); },
  };
  const change = {
    ...add,
    "the last answer grows": () => answers.at(-1)?.updateContent(message([thinking(sentence(10)), text(sentence(20 + Math.floor(random() * 40)))])),
    "a tool ends": () => {
      const component = pick(tools);
      component?.updateResult({ role: "toolResult", toolCallId: "x", toolName: "bash", content: [{ type: "text", text: sentence(9) }], isError: random() < 0.3, timestamp: 1 });
    },
    "a tool opens or closes": () => { const component = pick(tools); component?.setExpanded(!component.expanded); },
    "thinking shows or hides": () => { const component = pick(answers); component?.setHideThinkingBlock(!component.hideThinkingBlock); },
    "every tool opens": () => { for (const component of tools) component.setExpanded(true); },
    "every tool closes": () => { for (const component of tools) component.setExpanded(false); },
    "the last children go": () => { for (let n = 1 + Math.floor(random() * 3); n > 0 && kept.children.length > 2; n--) kept.removeChild(kept.children.at(-1)); },
    "a child in the middle goes": () => { if (kept.children.length > 4) kept.removeChild(kept.children[Math.floor(random() * kept.children.length)]); },
    "a child comes in the middle": () => { kept.children.splice(Math.floor(random() * kept.children.length), 0, new Text(sentence(4), 1, 0)); },
  };
  const often = ["answer", "tool", "tool", "question", "note", "the last answer grows", "the last answer grows", "a tool ends", "a tool opens or closes", "thinking shows or hides"];
  const seldom = ["every tool opens", "every tool closes", "the last children go", "a child in the middle goes", "a child comes in the middle"];
  for (let n = 0; n < 40; n++) add[pick(["answer", "tool", "tool", "question"])]();
  let width = WIDTH;
  for (let step = 0; step < 400; step++) {
    const name = random() < 0.85 ? pick(often) : pick(seldom);
    change[name]();
    if (random() < 0.03) width = pick([40, 60, 100]);
    const got = kept.render(width);
    const fresh = new Container();
    fresh.children = kept.children;
    const want = fresh.render(width);
    assert.deepEqual(got, want, `step ${step} (${name}): the rows differ`);
    assert.deepEqual(parts(kept), parts(fresh), `step ${step} (${name}): the parts under the pointer differ`);
    assert.equal(kept.render(width), got, `step ${step} (${name}): an unchanged frame gave a new array`);
  }
  assert.equal(notes.length, 0, notes[0]);
}

// 4. The reader's place. Fullscreen mode keeps a scroll position in rows; when rows above it
//    change, the row the reader had on top stays on top.
{
  const chat = new Container();
  const early = tool("read", { path: "early.txt" }, Array.from({ length: 30 }, (_, n) => `early line ${n}`).join("\n"));
  const other = tool("read", { path: "other.txt" }, Array.from({ length: 12 }, (_, n) => `other line ${n}`).join("\n"));
  chat.addChild(user("first question"));
  chat.addChild(assistant([text("first answer")]));
  chat.addChild(early);
  chat.addChild(other);
  for (let n = 0; n < 40; n++) chat.addChild(assistant([text(`answer number ${n}`)]));
  const header = new Container();
  header.addChild(new Text("header\nof two rows", 0, 0));
  const document = new Container();
  document.addChild(header);
  document.addChild(chat);
  const view = new ScrollView(document, { follow: "end", primary: true });
  const VIEWPORT = 10;
  const frame = () => {
    const rows = document.render(WIDTH);
    view.updateLayout(rows.length, VIEWPORT, () => {});
    return rows;
  };
  const top = () => plain(frame()[view.scrollTop]);

  frame();
  assert.equal(view.isFollowingEnd, true);
  early.setExpanded(true);
  frame();
  assert.equal(view.isFollowingEnd, true, "rows above the end changed, and the view stopped following it");
  early.setExpanded(false);

  // The reader goes to "answer number 20". A tool above opens, then closes: the answer stays on top.
  let rows = frame();
  view.scrollTo(rows.map(plain).indexOf(" answer number 20"), { disableFollow: true });
  assert.equal(top(), " answer number 20");
  const closed = view.scrollTop;
  early.setExpanded(true);
  assert.equal(top(), " answer number 20");
  assert.ok(view.scrollTop > closed + 20, "the tool's rows did not come in above the reader");
  early.setExpanded(false);
  assert.equal(top(), " answer number 20");
  assert.equal(view.scrollTop, closed);

  // The reader scrolls in the very frame in which rows above change: the row scrolled to is one
  // of the rows as they were drawn, and that row is on top afterwards.
  // (Each answer is a blank row and a row of text.)
  view.scrollBy(2);
  other.setExpanded(true);
  assert.equal(top(), " answer number 21");
  view.scrollBy(-2);
  other.setExpanded(false);
  early.setExpanded(true);
  assert.equal(top(), " answer number 20");
  assert.equal(notes.length, 0, notes[0]);
}

// 5. A container with no message of the assistant and no tool call is left to Pi.
{
  const plainContainer = new Container();
  plainContainer.addChild(new Text("one", 0, 0));
  plainContainer.addChild(new Spacer(1));
  plainContainer.addChild(new Text("two", 0, 0));
  assert.deepEqual(plainContainer.render(WIDTH).map(plain), ["one", "", "two"]);
}

// 6. If its own code throws, the extension puts Pi's methods back at once and says so.
{
  const chat = new Container();
  chat.addChild(assistant([text("an answer")]));
  let fails = 1;
  const flaky = new Text("a row", 0, 0);
  const render = flaky.render.bind(flaky);
  flaky.render = (width) => {
    if (fails-- > 0) throw new Error("this child fails once");
    return render(width);
  };
  chat.addChild(flaky);
  const rows = chat.render(WIDTH).map(plain);
  assert.ok(rows.includes("a row") && rows.includes(" an answer"), "Pi's own rows were not drawn");
  assert.equal(Container.prototype.render, stock.render);
  assert.equal(ScrollView.prototype.updateLayout, stock.updateLayout);
  assert.equal(FooterComponent.prototype.render, stock.footer);
  assert.equal(InteractiveMode.prototype.showStatus, stock.showStatus);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /quiet-transcript turned itself off: Error: this child fails once/);
  assert.equal(label, "Thinking...");
}

// 7. A session's end puts the methods back, and a new session takes them again.
{
  handlers.session_start({}, { mode: "tui", ui });
  assert.notEqual(Container.prototype.render, stock.render);
  handlers.session_shutdown();
  assert.equal(Container.prototype.render, stock.render);
  assert.equal(ScrollView.prototype.updateLayout, stock.updateLayout);
  assert.equal(FooterComponent.prototype.render, stock.footer);
  assert.equal(InteractiveMode.prototype.showStatus, stock.showStatus);
}

const piVersion = JSON.parse(fs.readFileSync(path.join(piRoot, "package.json"), "utf8")).version;
console.log(`quiet-transcript: every check passes (Pi ${piVersion} at ${piRoot})`);
