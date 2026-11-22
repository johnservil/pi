import { Box, Container, Markdown, type MarkdownTheme, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class CompactionSummaryMessageComponent extends Box {
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;
	private markdownTransformers: readonly MarkdownTransformer[];
	private messageId?: string;
	private timestamp?: string;
	private stateVersion = 0;
	private displayedExpanded: boolean | undefined = undefined;
	private collapsedRenderCache?: { width: number; version: number; lines: readonly string[] };
	private expandedRenderCache?: { width: number; version: number; lines: readonly string[] };
	private deferredPlaceholder = false;
	private placeholderCache?: { count: number; lines: readonly string[] };

	constructor(
		message: CompactionSummaryMessage,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		messageId?: string,
		timestamp?: string,
	) {
		super(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;
		this.updateDisplay();
	}

	hasCachedRender(width: number): boolean {
		const cache = this.expanded ? this.expandedRenderCache : this.collapsedRenderCache;
		return cache !== undefined && cache.width === width && cache.version === this.stateVersion;
	}

	isDeferredPlaceholder(): boolean {
		return this.expanded && this.deferredPlaceholder;
	}

	setDeferredPlaceholder(deferred: boolean): void {
		this.deferredPlaceholder = deferred;
		if (!deferred) this.placeholderCache = undefined;
	}

	estimateExpandedHeight(width: number): number {
		const contentWidth = Math.max(1, width - 2);
		const summary = this.message.summary;
		let lines = 6;
		let lineStart = 0;
		for (let i = 0; i < summary.length; i++) {
			if (summary.charCodeAt(i) === 10) {
				const len = i - lineStart;
				lines += len > contentWidth ? Math.ceil(len / contentWidth) : 1;
				lineStart = i + 1;
			}
		}
		const tail = summary.length - lineStart;
		lines += tail > contentWidth ? Math.ceil(tail / contentWidth) : 1;
		return lines;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		if (!expanded) {
			this.deferredPlaceholder = false;
			this.placeholderCache = undefined;
		}
	}

	setOutputPad(outputPad: number): void {
		this.setPaddingX(outputPad);
		this.stateVersion += 1;
		this.collapsedRenderCache = undefined;
		this.expandedRenderCache = undefined;
	}

	override invalidate(): void {
		super.invalidate();
		this.stateVersion += 1;
		this.displayedExpanded = undefined;
		this.collapsedRenderCache = undefined;
		this.expandedRenderCache = undefined;
		this.deferredPlaceholder = false;
		this.placeholderCache = undefined;
	}

	override render(width: number): readonly string[] {
		const cached = this.expanded ? this.expandedRenderCache : this.collapsedRenderCache;
		if (cached && cached.width === width && cached.version === this.stateVersion) {
			this.deferredPlaceholder = false;
			this.placeholderCache = undefined;
			return cached.lines;
		}
		if (this.expanded && this.deferredPlaceholder) {
			const count = this.estimateExpandedHeight(width);
			if (!this.placeholderCache || this.placeholderCache.count !== count) {
				const lines = new Array<string>(count);
				for (let i = 0; i < count; i++) lines[i] = "\x1b[0m";
				this.placeholderCache = { count, lines };
			}
			return this.placeholderCache.lines;
		}
		if (this.displayedExpanded !== this.expanded) {
			this.updateDisplay();
		}
		const lines = super.render(width);
		const entry = { width, version: this.stateVersion, lines };
		if (this.expanded) {
			this.expandedRenderCache = entry;
			this.deferredPlaceholder = false;
			this.placeholderCache = undefined;
		} else {
			this.collapsedRenderCache = entry;
		}
		return lines;
	}

	override handleMouse(event: Parameters<Box["handleMouse"]>[0]): ReturnType<Box["handleMouse"]> {
		if (this.displayedExpanded !== this.expanded) {
			this.updateDisplay();
		}
		return super.handleMouse(event);
	}

	private updateDisplay(): void {
		this.displayedExpanded = this.expanded;
		this.clear();
		const content = new Container();

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const label = theme.fg("customMessageLabel", `\x1b[1m[compaction]\x1b[22m`);
		content.addChild(new Text(label, 0, 0));
		content.addChild(new Spacer(1));

		if (this.expanded) {
			const header = `**Compacted from ${tokenStr} tokens**\n\n`;
			const transform = createMarkdownTransform(
				"summary",
				() => false,
				this.markdownTransformers,
				this.messageId,
				this.timestamp,
			);
			content.addChild(
				new Markdown(
					this.message.summary,
					0,
					0,
					this.markdownTheme,
					{ color: (text: string) => theme.fg("customMessageText", text) },
					// Transformers see only the summary content, not Pi's header.
					{ transform: (markdown, width) => header + transform(markdown, width) },
				),
			);
		} else {
			content.addChild(
				new Text(
					theme.fg("customMessageText", `Compacted from ${tokenStr} tokens (`) +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		}

		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	}
}
