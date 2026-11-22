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
// Pi's extension API has no call for this layout. While a session is open
// the extension replaces three of Pi's methods (see `install`) and puts them
// back when the session closes. If its own code throws, it puts them back
// at once and says so. Check it after a Pi upgrade.
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

type Mouse = { type: string; button: string; x: number; y: number; height: number };
type Pointed = Component & { handleMouse?(event: Mouse): unknown };
/** A marker: one collapsed block, and how a click opens it. */
type Marker = { text: string; width: number; owner: Component; open(event: Mouse): unknown };
/** Where each child of a transcript begins among its rows. */
type Layout = { tops: Map<Component, number>; thinks: Map<Component, number>; height: number };
/** The row a reader has at the top of the screen, as a place in one child. */
type Place = { child: Component; above: number; below: number; thinks: number };

/** Consecutive rows of one child, as the pointer sees them. */
class Rows {
  height = 1;
  constructor(readonly child: Pointed, readonly first: number, readonly total: number) {}
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

export default function (pi: ExtensionAPI) {
  const render = Container.prototype.render;
  const updateLayout = ScrollView.prototype.updateLayout;
  const footerRender = FooterComponent.prototype.render;
  const mode = InteractiveMode.prototype as unknown as {
    showStatus(message: string): void;
    hideThinkingBlock?: boolean;
    toolOutputExpanded?: boolean;
  };
  const showStatus = mode.showStatus;
  const layouts = new WeakMap<Component, Layout>();
  const places = new WeakMap<ScrollView, { top: number; place?: Place }>();
  let ui: ExtensionContext["ui"] | undefined;
  let thinkingHidden: boolean | undefined;
  let toolsExpanded: boolean | undefined;

  const toolMarker = (tool: ToolExecutionComponent): Marker => {
    const state = tool as unknown as { isPartial: boolean; result?: { isError?: boolean } };
    const shade = state.isPartial ? "toolPendingBg" : state.result?.isError ? "toolErrorBg" : "toolSuccessBg";
    return {
      text: ui ? ui.theme.bg(shade, ui.theme.fg("toolTitle", TOOL)) : TOOL,
      width: TOOL.length,
      owner: tool,
      open: () => {
        tool.setExpanded(true);
        return { handled: true };
      },
    };
  };

  // Pi styled the label; a click on the marker goes to the label's own row.
  const thinkMarker = (child: Pointed, label: string, row: number, total: number): Marker => {
    const text = label.replace(TAG, "").trim();
    return {
      text,
      width: visibleWidth(text),
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

  /**
   * A transcript's rows, with collapsed blocks drawn as markers.
   * Between two rows of content, markers replace the blank rows beside them.
   */
  const flow = (transcript: Container, width: number): string[] => {
    const out: string[] = [];
    const parts: (Rows | MarkerRows)[] = [];
    const layout: Layout = { tops: new Map(), thinks: new Map(), height: 0 };
    type Blank = { line: string; mark: string; child: Pointed; row: number; total: number };
    let waiting: (Blank | { marker: Marker; mark: string })[] = [];

    const put = (line: string, child: Pointed, row: number, total: number) => {
      if (!layout.tops.has(child)) layout.tops.set(child, out.length);
      out.push(line);
      const last = parts[parts.length - 1];
      if (last instanceof Rows && last.child === child && last.first + last.height === row) last.height++;
      else parts.push(new Rows(child, row, total));
    };
    const settle = () => {
      const markers = waiting.flatMap(item => ("marker" in item ? [item.marker] : []));
      if (markers.length === 0) {
        for (const item of waiting) if ("line" in item) put(item.line, item.child, item.row, item.total);
      } else {
        const rows = wrap(markers, width - 2 * PAD.length);
        const marks = waiting.map(item => item.mark).join("");
        rows.forEach((row, index) => {
          for (const marker of row) if (!layout.tops.has(marker.owner)) layout.tops.set(marker.owner, out.length);
          out.push((index === 0 ? marks : "") + PAD + row.map(marker => marker.text).join(" "));
        });
        parts.push(new MarkerRows(rows));
      }
      waiting = [];
    };

    for (const child of transcript.children as Pointed[]) {
      if (child instanceof AssistantMessageComponent) {
        thinkingHidden = (child as unknown as { hideThinkingBlock: boolean }).hideThinkingBlock;
      }
      if (child instanceof ToolExecutionComponent) {
        const tool = child as unknown as { expanded: boolean; hideComponent: boolean };
        if (!tool.expanded && !tool.hideComponent) {
          waiting.push({ marker: toolMarker(child), mark: "" });
          continue;
        }
        // Fast path for expanded ToolExecutionComponent or CompactionSummaryMessageComponent:
        // neither contains hidden-thinking TAGs or OSC 133 ZONE marks. Any leading blank
        // rows feed `waiting`, and the remaining body rows go straight into `out` in one
        // contiguous `Rows` span without per-line regexes.
        const lines = child.render(width);
        if (lines.length === 0) continue;
        let firstBody = 0;
        while (firstBody < lines.length && lines[firstBody] === "") {
          waiting.push({ line: "", mark: "", child, row: firstBody, total: lines.length });
          firstBody++;
        }
        if (firstBody < lines.length) {
          settle();
          if (!layout.tops.has(child)) layout.tops.set(child, out.length);
          for (let row = firstBody; row < lines.length; row++) out.push(lines[row]);
          const span = new Rows(child, firstBody, lines.length);
          span.height = lines.length - firstBody;
          parts.push(span);
        }
        continue;
      }
      if (child instanceof CompactionSummaryMessageComponent) {
        const lines = child.render(width);
        if (lines.length === 0) continue;
        settle();
        if (!layout.tops.has(child)) layout.tops.set(child, out.length);
        for (let row = 0; row < lines.length; row++) out.push(lines[row]);
        const span = new Rows(child, 0, lines.length);
        span.height = lines.length;
        parts.push(span);
        continue;
      }
      const lines = child.render(width);
      for (let row = 0; row < lines.length; row++) {
        const line = lines[row];
        const mark = ZONE.exec(line)?.[0] ?? "";
        const body = mark ? line.slice(mark.length) : line;
        if (body.includes(TAG)) {
          layout.thinks.set(child, (layout.thinks.get(child) ?? 0) + 1);
          waiting.push({ marker: thinkMarker(child, body, row, lines.length), mark });
        } else if (!/\S/.test(body)) {
          waiting.push({ line, mark, child, row, total: lines.length });
        } else {
          settle();
          put(line, child, row, lines.length);
        }
      }
    }
    settle();
    layout.height = out.length;
    layouts.set(transcript, layout);
    (transcript as unknown as { mouseLayout: unknown }).mouseLayout = {
      width,
      children: parts.map(part => ({ component: part, height: part.height })),
    };
    return out;
  };

  /** The transcript in a scroll view's content, and the row it starts on. */
  const transcriptIn = (content: Component): { layout: Layout; offset: number } | undefined => {
    const own = layouts.get(content);
    if (own) return { layout: own, offset: 0 };
    const drawn = (content as unknown as { mouseLayout?: { children: { component: Component; height: number }[] } })
      .mouseLayout;
    let offset = 0;
    for (const { component, height } of drawn?.children ?? []) {
      const layout = layouts.get(component);
      if (layout) return { layout, offset };
      offset += height;
    }
    return undefined;
  };

  /** The child that holds row `top`, and how far `top` is into that child. */
  const placeAt = ({ layout, offset }: { layout: Layout; offset: number }, top: number): Place | undefined => {
    const order = [...layout.tops];
    let index = -1;
    while (index + 1 < order.length && offset + order[index + 1][1] <= top) index++;
    if (index < 0) return undefined;
    // Markers that share the top row: take the first.
    while (index > 0 && offset + order[index][1] === top && order[index - 1][1] === order[index][1]) index--;
    const [child, start] = order[index];
    const end = index + 1 < order.length ? order[index + 1][1] : layout.height;
    return { child, above: top - offset - start, below: offset + end - top, thinks: layout.thinks.get(child) ?? 0 };
  };

  /** The row to scroll to so that `place` is on top again. */
  const rowOf = (place: Place, { layout, offset }: { layout: Layout; offset: number }): number | undefined => {
    const order = [...layout.tops];
    const index = order.findIndex(([child]) => child === place.child);
    if (index < 0) return undefined;
    const start = order[index][1];
    const end = index + 1 < order.length ? order[index + 1][1] : layout.height;
    // Thinking opened or closed above the reader: keep the rows below it still.
    if ((layout.thinks.get(place.child) ?? 0) !== place.thinks) {
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

  function quietRender(this: Container, width: number): string[] {
    const transcript =
      width >= 2 * PAD.length + THINK.length &&
      this.children.some(child => child instanceof AssistantMessageComponent || child instanceof ToolExecutionComponent);
    if (transcript) {
      try {
        return flow(this, width);
      } catch (error) {
        fail(error);
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
      // The place holds until the reader scrolls or asks to follow new output.
      const held = places.get(this);
      let place = !following && held?.top === before ? held.place : undefined;
      const row = place && rowOf(place, found);
      if (row === undefined) place = undefined;
      else this.scrollTo(row, { disableFollow: true });
      if (!place && !this.isFollowingEnd) place = placeAt(found, this.scrollTop);
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
  function quietFooter(this: FooterComponent, width: number): string[] {
    const lines = footerRender.call(this, width);
    if (lines.length < 2) return lines;
    const think = thinkingHidden === undefined ? undefined : thinkingHidden ? "think:collapsed" : "think:expanded";
    const tools = (toolsExpanded ?? ui?.getToolsExpanded()) ? "tools:expanded" : "tools:collapsed";
    const badge = [think, tools].filter(Boolean).join(" • ");
    if (!badge) return lines;
    const plain = `  ${badge}  `;
    // Match the run of padding spaces between the left stats and right model name.
    const match = / {4,}/.exec(lines[1]);
    if (!match || match[0].length < plain.length) return lines;
    const padLeft = Math.floor((match[0].length - plain.length) / 2);
    const padRight = match[0].length - plain.length - padLeft;
    const styled = ui ? ui.theme.fg("dim", plain) : plain;
    lines[1] =
      lines[1].slice(0, match.index) +
      " ".repeat(padLeft) +
      styled +
      " ".repeat(padRight) +
      lines[1].slice(match.index + match[0].length);
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
