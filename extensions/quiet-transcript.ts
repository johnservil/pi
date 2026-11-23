// Keep Pi's transcript short: a hidden thinking block shows as "[think...]"
// and a collapsed tool call as "[tool...]", each where its block would be.
//
// Ctrl+T hides or shows thinking and Ctrl+O collapses or expands tools (Pi's
// default bindings). In fullscreen mode a click on a marker opens that one
// block, and a click on an open block closes it.
//
// Neighbouring markers share a row. That row takes the place of the blank
// row Pi puts between blocks, so markers add rows only when they wrap, and
// the text around them keeps its shape whichever way the blocks are shown.
//
// A long transcript costs little to draw again: the rows are kept from one
// frame to the next, and a frame lays out again only from the first block
// that gives other rows than it gave the frame before.
//
// Pi's extension API has no call for this layout. While a session is open
// the extension replaces four of Pi's methods (see `install`) and puts them
// back when the session closes. If its own code throws, it puts them back
// at once and says so. Check it after a Pi upgrade. It runs on Pi 1.4 and
// on Pi 1.6, whose containers keep what they drew under different names.
import {
  AssistantMessageComponent,
  CompactionSummaryMessageComponent,
  FooterComponent,
  InteractiveMode,
  ToolExecutionComponent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, visibleWidth, type Component } from "@earendil-works/pi-tui";

const THINK = "[think...]";
const TOOL = "[tool...]";
const PAD = " ";
// Pi draws the hidden-thinking label; this zero-width tag inside it tells
// that row from a row of text that happens to read "[think...]".
const TAG = "\x1b_quiet-transcript\x1b\\";
// Pi's jump-to-message marks. They sit at the start of a row.
const ZONE = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
// The backgrounds of a tool's marker: running, failed, done.
const SHADES = ["toolPendingBg", "toolErrorBg", "toolSuccessBg"] as const;
// The kinds of block that the layout tells apart.
const OTHER = 0;
const ASSISTANT = 1;
const TOOL_CALL = 2;
const COMPACTION = 3;

type Mouse = { type: string; button: string; x: number; y: number; height: number };
type Pointed = Component & { handleMouse?(event: Mouse): unknown };
type Lines = readonly string[];
/** A marker: one collapsed block, and how a click opens it. */
type Marker = { text: string; width: number; owner: Component; open(event: Mouse): unknown };
/** The row a reader has at the top of the screen, as a place in one child. */
type Place = { child: Component; above: number; below: number; thinks: number };
/** What a tool call shows of its state. */
type ToolState = { expanded: boolean; hideComponent: boolean; isPartial: boolean; result?: { isError?: boolean } };

// Pi finds the block under the pointer in what a container last drew: a list
// of { component, height } in Pi 1.4, the children beside their rows in
// Pi 1.6. A part below answers to both: it is its own `component`, and its
// `length` is its height.

/** Consecutive rows of one child, as the pointer sees them. */
class Rows {
  height = 1;
  constructor(readonly child: Pointed, readonly first: number, readonly total: number) {}
  get component() {
    return this;
  }
  get length() {
    return this.height;
  }
  handleMouse(event: Mouse) {
    return this.child.handleMouse?.({ ...event, y: event.y + this.first, height: this.total });
  }
}

/** The rows that markers share. */
class MarkerRows {
  constructor(readonly rows: Marker[][]) {}
  get height() {
    return this.rows.length;
  }
  get component() {
    return this;
  }
  get length() {
    return this.rows.length;
  }
  handleMouse(event: Mouse) {
    if (event.type !== "click" || event.button !== "left") return undefined;
    let x = PAD.length;
    for (const marker of this.rows[event.y] ?? []) {
      if (event.x >= x && event.x < x + marker.width) return marker.open(event);
      x += marker.width + 1;
    }
    return undefined;
  }
}

type Part = Rows | MarkerRows;

/** A transcript as it was last laid out. */
type Flow = {
  width: number;
  /** The three tool markers as they were drawn. */
  shades: string[];
  /** The children, their kinds, and what each gave: its rows, or a collapsed tool's marker. */
  children: Pointed[];
  kinds: number[];
  gave: (Lines | string)[];
  /** The rows. Pi holds this array between frames, so a change makes a new one. */
  out: string[];
  parts: Part[];
  /** The children that have a first row, in the order of their rows, and those rows. */
  owners: Component[];
  tops: number[];
  at: Map<Component, number>;
  /** How many thinking blocks of a child are hidden. */
  thinks: WeakMap<Component, number>;
  /**
   * The places where laying out can start again: a child before which nothing
   * waited, as four numbers (the child, and how many rows, parts and owners
   * came before it).
   */
  cuts: number[];
  /** Whether a scroll view shows this transcript. Only then is `past` kept. */
  scrolled: boolean;
  /**
   * The owners and first rows that a layout since the last frame replaced, from owner `from` on,
   * and the height then: with the owners before `from` they are the rows as the reader last saw them.
   */
  past?: { from: number; owners: Component[]; tops: number[]; height: number };
};

/** Which child starts on which row. */
type RowMap = { owners: readonly Component[]; tops: readonly number[]; height: number };

/** What a container drew, as Pi 1.4 keeps it and as Pi 1.6 keeps it. */
type Drawn = {
  mouseLayout?: { width: number; children: readonly { component: Component; height: number }[] };
  childLines?: { width: number; children: readonly Component[]; parts: readonly { length: number }[]; lines: Lines };
};

const sameLines = (a: Lines, b: Lines): boolean => {
  if (a.length !== b.length) return false;
  for (let row = 0; row < a.length; row++) if (a[row] !== b[row]) return false;
  return true;
};

export default function (pi: ExtensionAPI) {
  // Pi's loader reaches an imported name through a proxy at each use. These
  // are used for every block of every frame, so they are read once.
  const Assistant = AssistantMessageComponent;
  const Compaction = CompactionSummaryMessageComponent;
  const ToolCall = ToolExecutionComponent;
  const widthOf = visibleWidth;

  const render = Container.prototype.render;
  const updateLayout = ScrollView.prototype.updateLayout;
  const footerRender = FooterComponent.prototype.render;
  const mode = InteractiveMode.prototype as unknown as {
    showStatus(message: string): void;
    hideThinkingBlock?: boolean;
    toolOutputExpanded?: boolean;
  };
  const showStatus = mode.showStatus;
  const flows = new WeakMap<Component, Flow>();
  const places = new WeakMap<ScrollView, { top: number; place?: Place }>();
  let ui: ExtensionContext["ui"] | undefined;
  let thinkingHidden: boolean | undefined;
  let toolsExpanded: boolean | undefined;

  const toolMarker = (tool: ToolExecutionComponent, text: string): Marker => ({
    text,
    width: TOOL.length,
    owner: tool,
    open: () => {
      tool.setExpanded(true);
      return { handled: true };
    },
  });

  // Pi styled the label; a click on the marker goes to the label's own row.
  const thinkMarker = (child: Pointed, label: string, row: number, total: number): Marker => {
    const text = label.replace(TAG, "").trim();
    return {
      text,
      width: widthOf(text),
      owner: child,
      open: event => child.handleMouse?.({ ...event, y: row, height: total }),
    };
  };

  const wrap = (markers: Marker[], room: number): Marker[][] => {
    const rows: Marker[][] = [[]];
    let used = 0;
    for (const marker of markers) {
      const row = rows[rows.length - 1];
      if (row.length > 0 && used + 1 + marker.width > room) {
        rows.push([marker]);
        used = marker.width;
      } else {
        used += (row.length > 0 ? 1 : 0) + marker.width;
        row.push(marker);
      }
    }
    return rows;
  };

  const kindOf = (child: Component): number =>
    child instanceof ToolCall
      ? TOOL_CALL
      : child instanceof Compaction
        ? COMPACTION
        : child instanceof Assistant
          ? ASSISTANT
          : OTHER;

  /** What a child gives to the layout: a collapsed tool its marker, any other child its rows. */
  const give = (child: Pointed, kind: number, width: number, shades: string[]): Lines | string => {
    if (kind === TOOL_CALL) {
      const tool = child as unknown as ToolState;
      if (!tool.expanded && !tool.hideComponent) return shades[tool.isPartial ? 0 : tool.result?.isError ? 1 : 2];
    }
    return child.render(width);
  };

  /**
   * A transcript's rows, with collapsed blocks drawn as markers.
   * Between two rows of content, markers replace the blank rows beside them.
   */
  const flow = (transcript: Container, width: number): Lines => {
    const children = transcript.children as Pointed[];
    const shades = ui ? SHADES.map(shade => ui!.theme.bg(shade, ui!.theme.fg("toolTitle", TOOL))) : [TOOL, TOOL, TOOL];
    let known = flows.get(transcript);
    if (!known || known.width !== width || shades.some((shade, index) => shade !== known!.shades[index])) {
      known = {
        width,
        shades,
        children: [],
        kinds: [],
        gave: [],
        out: [],
        parts: [],
        owners: [],
        tops: [],
        at: new Map(),
        thinks: new WeakMap(),
        cuts: [0, 0, 0, 0],
        scrolled: false,
      };
      flows.set(transcript, known);
    }
    const { kinds, gave, parts, owners, tops, at, thinks, cuts } = known;
    const before = known.children;

    // Ask each child what it gives, up to the first that gives something new.
    let lastAssistant: Pointed | undefined;
    let changed: Lines | string | undefined;
    let first = 0;
    for (const same = Math.min(children.length, before.length); first < same; first++) {
      const child = children[first];
      if (child !== before[first]) break;
      const kind = kinds[first];
      if (kind === ASSISTANT) lastAssistant = child;
      const now = give(child, kind, width, known.shades);
      const then = gave[first];
      if (now !== then) {
        if (typeof now === "string" || typeof then === "string" || !sameLines(now, then)) {
          changed = now;
          break;
        }
        gave[first] = now;
      }
    }
    if (first < children.length || first < before.length) {
      // Lay out again from the last place before that child where nothing waited.
      let cut = cuts.length - 4;
      while (cuts[cut] > first) cut -= 4;
      cuts.length = cut + 4;
      const start = cuts[cut];
      const out = known.out.slice(0, cuts[cut + 1]);
      parts.length = cuts[cut + 2];
      // Keep what the reader last saw from there on: quietLayout() may have to find a row in it.
      const from = cuts[cut + 3];
      const past = known.past;
      if (!known.scrolled) {
        // No scroll view, no reader's place to keep.
      } else if (!past) {
        known.past = { from, owners: owners.slice(from), tops: tops.slice(from), height: known.out.length };
      } else if (from < past.from) {
        past.owners = owners.slice(from, past.from).concat(past.owners);
        past.tops = tops.slice(from, past.from).concat(past.tops);
        past.from = from;
      }
      for (let index = from; index < owners.length; index++) at.delete(owners[index]);
      owners.length = tops.length = from;
      // The parts before the cut are closed: a row is never added to one of them.
      const closed = parts.length;

      type Blank = { line: string; mark: string; child: Pointed; row: number; total: number };
      let waiting: (Blank | { marker: Marker; mark: string })[] = [];

      const top = (child: Component) => {
        if (at.has(child)) return;
        at.set(child, owners.length);
        owners.push(child);
        tops.push(out.length);
      };
      const put = (line: string, child: Pointed, row: number, total: number) => {
        top(child);
        out.push(line);
        const last = parts.length > closed ? parts[parts.length - 1] : undefined;
        if (last instanceof Rows && last.child === child && last.first + last.height === row) last.height++;
        else parts.push(new Rows(child, row, total));
      };
      const span = (lines: Lines, from: number, child: Pointed) => {
        top(child);
        for (let row = from; row < lines.length; row++) out.push(lines[row]);
        const rows = new Rows(child, from, lines.length);
        rows.height = lines.length - from;
        parts.push(rows);
      };
      const settle = () => {
        const markers = waiting.flatMap(item => ("marker" in item ? [item.marker] : []));
        if (markers.length === 0) {
          for (const item of waiting) if ("line" in item) put(item.line, item.child, item.row, item.total);
        } else {
          const rows = wrap(markers, width - 2 * PAD.length);
          const marks = waiting.map(item => item.mark).join("");
          rows.forEach((row, index) => {
            for (const marker of row) top(marker.owner);
            out.push((index === 0 ? marks : "") + PAD + row.map(marker => marker.text).join(" "));
          });
          parts.push(new MarkerRows(rows));
        }
        waiting = [];
      };

      for (let index = start; index < children.length; index++) {
        const child = children[index];
        if (waiting.length === 0 && index > start) cuts.push(index, out.length, parts.length, owners.length);
        let kind: number;
        let given: Lines | string;
        if (index < first) {
          kind = kinds[index];
          given = gave[index];
        } else {
          kind = index < before.length && child === before[index] ? kinds[index] : kindOf(child);
          given = index === first && changed !== undefined ? changed : give(child, kind, width, known.shades);
        }
        before[index] = child;
        kinds[index] = kind;
        gave[index] = given;
        if (kind === ASSISTANT) lastAssistant = child;

        if (typeof given === "string") {
          waiting.push({ marker: toolMarker(child as unknown as ToolExecutionComponent, given), mark: "" });
          continue;
        }
        const lines = given;
        if (kind === TOOL_CALL) {
          // An open tool has no hidden-thinking label and no jump mark. Its blank
          // rows on top wait as any blank row does; the rest goes in as it is.
          if (lines.length === 0) continue;
          let body = 0;
          while (body < lines.length && lines[body] === "") {
            waiting.push({ line: "", mark: "", child, row: body, total: lines.length });
            body++;
          }
          if (body < lines.length) {
            settle();
            span(lines, body, child);
          }
          continue;
        }
        if (kind === COMPACTION) {
          if (lines.length === 0) continue;
          settle();
          span(lines, 0, child);
          continue;
        }
        let hidden = 0;
        for (let row = 0; row < lines.length; row++) {
          const line = lines[row];
          const mark = ZONE.exec(line)?.[0] ?? "";
          const body = mark ? line.slice(mark.length) : line;
          if (body.includes(TAG)) {
            hidden++;
            waiting.push({ marker: thinkMarker(child, body, row, lines.length), mark });
          } else if (!/\S/.test(body)) {
            waiting.push({ line, mark, child, row, total: lines.length });
          } else {
            settle();
            put(line, child, row, lines.length);
          }
        }
        if (hidden) thinks.set(child, hidden);
        else thinks.delete(child);
      }
      if (waiting.length > 0) settle();
      else if (children.length > start) cuts.push(children.length, out.length, parts.length, owners.length);
      before.length = kinds.length = gave.length = children.length;
      known.out = out;
      const drawn = transcript as unknown as Drawn;
      drawn.mouseLayout = { width, children: parts };
      drawn.childLines = { width, children: parts as unknown as Component[], parts, lines: out };
    }
    if (lastAssistant) thinkingHidden = (lastAssistant as unknown as { hideThinkingBlock: boolean }).hideThinkingBlock;
    return known.out;
  };

  type Found = { flow: Flow; offset: number };

  /** The transcript in a scroll view's content, and the row it starts on. */
  const transcriptIn = (content: Component): Found | undefined => {
    const own = flows.get(content);
    if (own) return { flow: own, offset: 0 };
    const drawn = content as unknown as Drawn;
    let offset = 0;
    if (drawn.childLines) {
      const { children, parts } = drawn.childLines;
      for (let index = 0; index < children.length; index++) {
        const found = flows.get(children[index]);
        if (found) return { flow: found, offset };
        offset += parts[index].length;
      }
      return undefined;
    }
    for (const { component, height } of drawn.mouseLayout?.children ?? []) {
      const found = flows.get(component);
      if (found) return { flow: found, offset };
      offset += height;
    }
    return undefined;
  };

  /** The rows as the reader last saw them: before the layouts of this frame, if there were any. */
  const drawn = ({ owners, tops, out, past }: Flow): RowMap =>
    past
      ? {
          owners: owners.slice(0, past.from).concat(past.owners),
          tops: tops.slice(0, past.from).concat(past.tops),
          height: past.height,
        }
      : { owners, tops, height: out.length };

  /** The child that holds row `top`, and how far `top` is into that child. */
  const placeAt = ({ owners, tops, height }: RowMap, { flow, offset }: Found, top: number): Place | undefined => {
    // The last child that starts on `top` or above it.
    let low = 0;
    let high = owners.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (offset + tops[middle] <= top) low = middle + 1;
      else high = middle;
    }
    let index = low - 1;
    if (index < 0) return undefined;
    // Markers that share the top row: take the first.
    while (index > 0 && offset + tops[index] === top && tops[index - 1] === tops[index]) index--;
    const child = owners[index];
    const start = tops[index];
    const end = index + 1 < owners.length ? tops[index + 1] : height;
    return { child, above: top - offset - start, below: offset + end - top, thinks: flow.thinks.get(child) ?? 0 };
  };

  /** The row to scroll to so that `place` is on top again. */
  const rowOf = (place: Place, { flow: { owners, tops, at, out, thinks }, offset }: Found): number | undefined => {
    const index = at.get(place.child);
    if (index === undefined) return undefined;
    const start = tops[index];
    const end = index + 1 < owners.length ? tops[index + 1] : out.length;
    // Thinking opened or closed above the reader: keep the rows below it still.
    if ((thinks.get(place.child) ?? 0) !== place.thinks) {
      return offset + (place.below <= end - start ? end - place.below : start);
    }
    return offset + start + Math.min(place.above, Math.max(0, end - start - 1));
  };

  let installed = false;
  const uninstall = () => {
    installed = false;
    if (Container.prototype.render === quietRender) Container.prototype.render = render;
    if (ScrollView.prototype.updateLayout === quietLayout) ScrollView.prototype.updateLayout = updateLayout;
    if (FooterComponent.prototype.render === quietFooter) FooterComponent.prototype.render = footerRender;
    if (mode.showStatus === quietStatus) mode.showStatus = showStatus;
  };
  const fail = (error: unknown) => {
    if (!installed) return;
    uninstall();
    const held = ui;
    // Outside the frame being drawn: Pi's own label, and one line of news.
    setTimeout(() => {
      held?.setHiddenThinkingLabel();
      held?.notify(`quiet-transcript turned itself off: ${error instanceof Error ? error.stack : error}`, "error");
    }, 0);
  };

  // A transcript is a container that holds a message of the assistant or a
  // tool call. The containers inside its blocks are not asked: every block
  // is one, and there are thousands.
  let laying = false;
  function quietRender(this: Container, width: number): Lines {
    if (!laying) {
      let transcript = false;
      if (width >= 2 * PAD.length + THINK.length) {
        for (const child of this.children) {
          if (child instanceof Assistant || child instanceof ToolCall) {
            transcript = true;
            break;
          }
        }
      }
      if (transcript) {
        laying = true;
        try {
          return flow(this, width);
        } catch (error) {
          flows.delete(this);
          fail(error);
        } finally {
          laying = false;
        }
      } else {
        flows.delete(this);
      }
    }
    return render.call(this, width);
  }

  // Fullscreen mode keeps a scroll position in rows. When rows above it
  // change, keep the reader's top row on top.
  function quietLayout(this: ScrollView, content: number, viewport: number, requestRender: () => void): void {
    const before = this.scrollTop;
    const following = this.isFollowingEnd;
    updateLayout.call(this, content, viewport, requestRender);
    try {
      const found = transcriptIn((this as unknown as { child: Component }).child);
      if (!found) return;
      // The place holds until the reader asks to follow new output, or scrolls: and where the
      // reader scrolled to is a place in the rows as they were drawn then, not as they are now.
      const held = places.get(this);
      let place = following
        ? undefined
        : held?.top === before
          ? held.place
          : found.flow.past && placeAt(drawn(found.flow), found, before);
      found.flow.past = undefined;
      found.flow.scrolled = true;
      const row = place && rowOf(place, found);
      if (row === undefined) place = undefined;
      else this.scrollTo(row, { disableFollow: true });
      if (!place && !this.isFollowingEnd) place = placeAt(drawn(found.flow), found, this.scrollTop);
      places.set(this, { top: this.scrollTop, place });
    } catch (error) {
      fail(error);
    }
  }

  // The transcript itself shows what Ctrl+T and Ctrl+O did.
  function quietStatus(
    this: { ui?: { requestRender(): void }; hideThinkingBlock?: boolean; toolOutputExpanded?: boolean },
    message: string,
  ): void {
    if (/^(Thinking blocks|Tool output): /.test(message)) {
      if (typeof this.hideThinkingBlock === "boolean") thinkingHidden = this.hideThinkingBlock;
      if (typeof this.toolOutputExpanded === "boolean") toolsExpanded = this.toolOutputExpanded;
      this.ui?.requestRender();
    } else {
      showStatus.call(this, message);
    }
  }

  // Place the current think/tool state in the middle of the footer's stats row,
  // where there is spare width, rather than adding a new status line.
  function quietFooter(this: FooterComponent, width: number): Lines {
    const drawn = footerRender.call(this, width);
    if (drawn.length < 2) return drawn;
    const think = thinkingHidden === undefined ? undefined : thinkingHidden ? "think:collapsed" : "think:expanded";
    const tools = (toolsExpanded ?? ui?.getToolsExpanded()) ? "tools:expanded" : "tools:collapsed";
    const badge = [think, tools].filter(Boolean).join(" • ");
    if (!badge) return drawn;
    const plain = `  ${badge}  `;
    // Match the run of padding spaces between the left stats and right model name.
    const match = / {4,}/.exec(drawn[1]);
    if (!match || match[0].length < plain.length) return drawn;
    const padLeft = Math.floor((match[0].length - plain.length) / 2);
    const padRight = match[0].length - plain.length - padLeft;
    const styled = ui ? ui.theme.fg("dim", plain) : plain;
    // The footer's own rows stay as Pi made them.
    const lines = [...drawn];
    lines[1] =
      drawn[1].slice(0, match.index) +
      " ".repeat(padLeft) +
      styled +
      " ".repeat(padRight) +
      drawn[1].slice(match.index + match[0].length);
    return lines;
  }

  const install = () => {
    installed = true;
    Container.prototype.render = quietRender;
    ScrollView.prototype.updateLayout = quietLayout;
    FooterComponent.prototype.render = quietFooter;
    mode.showStatus = quietStatus;
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ui = ctx.ui;
    toolsExpanded = ui.getToolsExpanded();
    install();
    ui.setHiddenThinkingLabel(THINK + TAG);
  });
  pi.on("session_shutdown", () => {
    uninstall();
    ui = undefined;
    thinkingHidden = undefined;
    toolsExpanded = undefined;
  });
}
