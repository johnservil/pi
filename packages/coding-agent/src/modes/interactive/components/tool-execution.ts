import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	MouseRegion,
	Spacer,
	Text,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext, ToolRenderers } from "../../../core/extensions/types.ts";

/** What this component needs from a tool: how to draw it, without executing it. */
export type { ToolRenderers };

import { formatToolCallWithArgs, getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { ensurePngTranscoder } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { keyHint, keyText } from "./keybinding-hints.ts";

const FALLBACK_PREVIEW_LINES = 10;

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	outputPad?: number;
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private contentTextRegion: MouseRegion;
	private selfRenderContainer: Container;
	private selfRenderHeight = 0;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	/** Inputs of imageComponents, so updateDisplay can reuse images and keep their converted PNG data. */
	private imageSources: Array<{ data: string; mimeType: string; widthCells: number }> = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private outputPad: number;
	private isPartial = true;
	private toolDefinition?: ToolRenderers;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	/** `updateArgs()` ran since the last display update; the next render applies it. */
	private argsPending = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
		durationMs?: number;
	};
	private hideComponent = false;
	/** Monotonic counter bumped whenever inputs/theme/layout options change. */
	private stateVersion = 0;
	/** Which `expanded` value the current child tree reflects (`undefined` = needs `updateDisplay()`). */
	private displayedExpanded: boolean | undefined = undefined;
	/** Per-mode rendered line caches keyed by `(width, stateVersion)` so C-o toggles reuse prior work. */
	private collapsedRenderCache?: {
		width: number;
		version: number;
		lines: readonly string[];
		hideComponent: boolean;
		selfRenderHeight: number;
	};
	private expandedRenderCache?: {
		width: number;
		version: number;
		lines: readonly string[];
		hideComponent: boolean;
		selfRenderHeight: number;
	};
	/** Cached O(1) line-count estimate for deferred off-screen expanded rendering. */
	private estimatedExpandedLinesCache?: { version: number; width: number; count: number };
	/** When true, `render()` returns lightweight placeholder lines instead of building the full expanded view. */
	private deferredPlaceholder = false;
	/** Cached placeholder array (only allocated while `deferredPlaceholder` is active). */
	private placeholderCache?: { count: number; lines: readonly string[] };

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolRenderers | ToolDefinition<any, any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.outputPad = options.outputPad ?? 1;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentTextRegion = this.createResultRegion(this.contentText);
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentTextRegion);
		}

		this.markDisplayDirty();
	}

	private markDisplayDirty(): void {
		this.stateVersion += 1;
		this.displayedExpanded = undefined;
		this.collapsedRenderCache = undefined;
		this.expandedRenderCache = undefined;
		this.estimatedExpandedLinesCache = undefined;
		this.placeholderCache = undefined;
		this.deferredPlaceholder = false;
	}

	/** True while this component returned placeholder lines instead of its real expanded render. */
	isDeferredPlaceholder(): boolean {
		return this.expanded && this.deferredPlaceholder && !this.isPartial && this.result !== undefined;
	}

	/** Whether this component has cached rendered lines for its current `expanded` state at `width`. */
	hasCachedRender(width: number): boolean {
		if (this.argsPending) return false;
		const cache = this.expanded ? this.expandedRenderCache : this.collapsedRenderCache;
		return cache !== undefined && cache.width === width && cache.version === this.stateVersion;
	}

	/**
	 * Request lightweight placeholder rendering when expanded and off-screen, or materialize the real view.
	 * Only affects uncached expanded tools; once rendered for real, cached lines are always returned.
	 */
	setDeferredPlaceholder(deferred: boolean): void {
		this.deferredPlaceholder = deferred;
		if (!deferred) this.placeholderCache = undefined;
	}

	/** Fast O(N_bytes) line-count estimate for an unrendered expanded tool at `width` (no syntax highlighting or wrapping). */
	estimateExpandedHeight(width: number): number {
		const cached = this.estimatedExpandedLinesCache;
		if (cached && cached.version === this.stateVersion && cached.width === width) {
			return cached.count;
		}
		const contentWidth = Math.max(1, width - this.outputPad * 2);
		let lines = 4; // spacer + header + top/bottom box padding
		const result = this.result;
		if (result?.content) {
			for (const block of result.content) {
				if (block.type === "text" && block.text) {
					const text = block.text;
					let lineStart = 0;
					for (let i = 0; i < text.length; i++) {
						if (text.charCodeAt(i) === 10) {
							const len = i - lineStart;
							lines += len > contentWidth ? Math.ceil(len / contentWidth) : 1;
							lineStart = i + 1;
						}
					}
					const tail = text.length - lineStart;
					lines += tail > contentWidth ? Math.ceil(tail / contentWidth) : 1;
				}
			}
		}
		if (result?.details?.diff && typeof result.details.diff === "string") {
			const diff = result.details.diff as string;
			for (let i = 0; i < diff.length; i++) {
				if (diff.charCodeAt(i) === 10) lines++;
			}
			lines += 2;
		}
		const count = Math.max(4, lines);
		this.estimatedExpandedLinesCache = { version: this.stateVersion, width, count };
		return count;
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		return this.toolDefinition?.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		return this.toolDefinition?.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		return this.toolDefinition?.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
			durationMs: this.isPartial ? undefined : this.result?.durationMs,
			outputPad: this.outputPad,
			keyText,
			keyHint,
		};
	}

	private createCallFallback(): Component {
		return new Text(formatToolCallWithArgs(this.toolName, this.args, theme, this.expanded), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}

		const lines = output.split("\n");
		const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		const remaining = lines.length - displayLines.length;
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		return new Text(text, 0, 0);
	}

	private createResultRegion(component: Component): MouseRegion {
		return new MouseRegion(component, (event) => {
			if (!this.result || event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(!this.expanded);
			return { handled: true };
		});
	}

	/**
	 * Show new partial arguments. Applied at the next render, so a call streaming many argument deltas between two
	 * frames runs its renderer once per frame, not once per delta (#9265).
	 */
	updateArgs(args: any): void {
		this.args = args;
		this.argsPending = true;
		this.markDisplayDirty();
		this.ui.requestRender();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.markDisplayDirty();
		// Run updateDisplay() immediately so bash/shell call renderers start their live elapsed timer
		// when execution begins rather than waiting until the first render call.
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.markDisplayDirty();
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
			/** Execution time of a final result. */
			durationMs?: number;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.markDisplayDirty();
		// Stop live timers or trigger async image transcoding promptly on result updates,
		// except when constructing/hydrating completed historical tools? No — updateResult
		// is called once per tool result (2,500 tools took only ~15 ms total during startup).
		// Keep updateDisplay() here when partial or when a live timer/image is present!
		if (isPartial || this.executionStarted || result.content.some((c) => c.type === "image")) {
			this.updateDisplay();
		}
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		// Do not rebuild synchronously: toggling C-o across thousands of tools would eagerly run
		// every tool's renderer/syntax highlighter even for off-screen tools. `render()` / `handleMouse()`
		// will hit the per-mode cache or call `updateDisplay()` on demand.
		if (!expanded) {
			this.deferredPlaceholder = false;
			this.placeholderCache = undefined;
		}
	}

	setOutputPad(outputPad: number): void {
		if (this.outputPad === outputPad) return;
		this.outputPad = outputPad;
		this.markDisplayDirty();
	}

	setShowImages(show: boolean): void {
		if (this.showImages === show) return;
		this.showImages = show;
		this.markDisplayDirty();
	}

	setImageWidthCells(width: number): void {
		const next = Math.max(1, Math.floor(width));
		if (this.imageWidthCells === next) return;
		this.imageWidthCells = next;
		this.markDisplayDirty();
	}

	override invalidate(): void {
		super.invalidate();
		this.markDisplayDirty();
	}

	override render(width: number): readonly string[] {
		const cached = this.expanded ? this.expandedRenderCache : this.collapsedRenderCache;
		if (!this.argsPending && cached && cached.width === width && cached.version === this.stateVersion) {
			this.hideComponent = cached.hideComponent;
			this.selfRenderHeight = cached.selfRenderHeight;
			this.deferredPlaceholder = false;
			this.placeholderCache = undefined;
			return cached.lines;
		}

		if (this.expanded && this.deferredPlaceholder && !this.isPartial && this.result) {
			const count = this.estimateExpandedHeight(width);
			if (!this.placeholderCache || this.placeholderCache.count !== count) {
				const lines = new Array<string>(count);
				lines[0] = "";
				// Non-blank marker (dim ellipsis on line 1, single-space reset on rest) so quiet-transcript
				// never collapses placeholder rows into blank lines; off-screen tools materialize before paint.
				const fill = "\x1b[0m";
				for (let i = 1; i < count; i++) lines[i] = fill;
				this.placeholderCache = { count, lines };
			}
			return this.placeholderCache.lines;
		}

		if (this.argsPending || this.displayedExpanded !== this.expanded) {
			this.updateDisplay();
		}
		if (this.hideComponent) {
			const empty: readonly string[] = [];
			const entry = { width, version: this.stateVersion, lines: empty, hideComponent: true, selfRenderHeight: 0 };
			if (this.expanded) this.expandedRenderCache = entry;
			else this.collapsedRenderCache = entry;
			return empty;
		}

		let rendered: readonly string[];
		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			this.selfRenderHeight = contentLines.length;
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				rendered = [];
			} else {
				const lines: string[] = [];
				if (contentLines.length > 0) {
					lines.push("");
					// Append in a loop: spreading hundreds of thousands of wrapped lines exceeds V8's argument limit.
					for (const line of contentLines) lines.push(line);
				}
				for (let i = 0; i < this.imageComponents.length; i++) {
					const spacer = this.imageSpacers[i];
					if (spacer) {
						lines.push(...spacer.render(width));
					}
					const imageComponent = this.imageComponents[i];
					if (imageComponent) {
						lines.push(...imageComponent.render(width));
					}
				}
				rendered = lines;
			}
		} else {
			rendered = super.render(width);
		}

		const entry = {
			width,
			version: this.stateVersion,
			lines: rendered,
			hideComponent: this.hideComponent,
			selfRenderHeight: this.selfRenderHeight,
		};
		if (this.expanded) {
			this.expandedRenderCache = entry;
			this.deferredPlaceholder = false;
			this.placeholderCache = undefined;
		} else {
			this.collapsedRenderCache = entry;
		}
		return rendered;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (this.argsPending || this.displayedExpanded !== this.expanded) {
			this.updateDisplay();
		}
		if (!this.hasRendererDefinition() || this.getRenderShell() !== "self") return super.handleMouse(event);
		if (event.y <= 0 || event.y > this.selfRenderHeight) return undefined;
		return this.selfRenderContainer.handleMouse({
			...event,
			y: event.y - 1,
			height: this.selfRenderHeight,
		});
	}

	private updateDisplay(): void {
		this.argsPending = false;
		this.displayedExpanded = this.expanded;
		const previousImages = this.imageComponents;
		const previousSources = this.imageSources;
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
				renderContainer.setPaddingX(this.outputPad);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(this.createResultRegion(component));
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(this.createResultRegion(component));
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(this.createResultRegion(component));
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(this.createResultRegion(component));
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setPaddingX(this.outputPad);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		// Remove duplicate declaration below; reuse previousImages / previousSources captured at start.
		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		this.imageSources = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (const img of imageBlocks) {
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const source = { data: img.data, mimeType: img.mimeType, widthCells: this.imageWidthCells };
					const index = this.imageComponents.length;
					const previous = previousSources[index];
					const imageComponent =
						previous?.data === source.data &&
						previous.mimeType === source.mimeType &&
						previous.widthCells === source.widthCells
							? previousImages[index]
							: new Image(
									source.data,
									source.mimeType,
									{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
									{ maxWidthCells: source.widthCells },
								);
					if (source.mimeType !== "image/png") {
						ensurePngTranscoder(() => {
							this.invalidate();
							this.ui.requestRender();
						});
					}
					this.imageComponents.push(imageComponent);
					this.imageSources.push(source);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
