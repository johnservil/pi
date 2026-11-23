// Finds where a Gemini or Gemma reply starts to write the next turn itself.
//
// These models name their turns `user` and `model`. Now and then one ends its reply and, in place of
// stopping, goes on as plain text: a line `user`, a user message it invents, a line `model`, and its answer
// to that message, tool calls included. Seen with google/gemini-4-neon through OpenRouter: 25 replies of one
// long session, each with more than 530,000 tokens of context, and none of that model's 443 replies with
// less. The line `user` is where the model's own turn ended.

import type { AssistantMessage } from "../types.ts";
import { appendAssistantMessageDiagnostic } from "./diagnostics.ts";

/** Whether `modelId` names a model whose chat template calls its turns `user` and `model`. */
export function namesTurnsUserAndModel(modelId: string): boolean {
	return /gemini|gemma/i.test(modelId);
}

/** How far a reply's text has been read for a leaked turn. Starts as `{ lineStart: 0, fence: 0 }`. */
export interface LeakedTurnScan {
	/** Offset of the first line not read yet. */
	lineStart: number;
	/** Length of the backtick run that opened the fence the next line is in; 0 outside a fence. */
	fence: number;
}

/** Counts recorded in a `leaked_turn` diagnostic when an invented turn is cut. */
export interface LeakedTurnDrop {
	droppedTextLength: number;
	droppedToolCalls: number;
}

function isLeakedTurnLine(line: string): boolean {
	return line === "user" || line === "<|turn>user" || line === "<start_of_turn>user";
}

/**
 * Reads the complete lines of `text` that `scan` has not read, and returns the offset of the first that is
 * a Gemini/Gemma turn boundary (`user`, `<|turn>user`, or `<start_of_turn>user`) outside fenced code, or
 * undefined when there is none. A reply's text is passed again each time it grows; the last line is read
 * once its line break has arrived, or when `final` is true (before a tool call or at end of stream).
 *
 * A fence opens with three or more backticks at the left margin and closes with a run at least as long.
 * A fence that opens indented (in a list item, as a rule) opens nothing here: its lines are indented with
 * it, so a line that is a turn boundary is none of them, and where such a fence is never closed the list
 * item ends at the first line at the margin.
 */
export function findLeakedTurn(text: string, scan: LeakedTurnScan, final = false): number | undefined {
	for (let end = text.indexOf("\n", scan.lineStart); end !== -1; end = text.indexOf("\n", scan.lineStart)) {
		const start = scan.lineStart;
		const lineEnd = end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
		const line = text.slice(start, lineEnd);
		scan.lineStart = end + 1;
		if (scan.fence > 0) {
			const closing = /^ {0,3}(`{3,})[ \t]*$/.exec(line);
			if (closing && closing[1].length >= scan.fence) scan.fence = 0;
		} else if (isLeakedTurnLine(line)) {
			return start;
		} else {
			scan.fence = /^(`{3,})[^`]*$/.exec(line)?.[1].length ?? 0;
		}
	}
	if (final && scan.lineStart < text.length && scan.fence === 0) {
		const start = scan.lineStart;
		const lineEnd = text.charCodeAt(text.length - 1) === 13 ? text.length - 1 : text.length;
		const line = text.slice(start, lineEnd);
		if (isLeakedTurnLine(line)) {
			scan.lineStart = text.length;
			return start;
		}
	}
	return undefined;
}

/**
 * Finalize `output` when an invented turn was cut: attach the `leaked_turn` diagnostic and
 * set `stopReason` based on what arrived before the cut (or a retryable error if nothing did).
 */
export function finalizeLeakedTurn(output: AssistantMessage, leakedTurn: LeakedTurnDrop): void {
	appendAssistantMessageDiagnostic(output, {
		type: "leaked_turn",
		timestamp: Date.now(),
		details: {
			droppedTextLength: leakedTurn.droppedTextLength,
			droppedToolCalls: leakedTurn.droppedToolCalls,
		},
	});
	const calledTool = output.content.some((block) => block.type === "toolCall");
	if (calledTool || output.content.some((block) => block.type === "text" && block.text.length > 0)) {
		output.stopReason = calledTool ? "toolUse" : "stop";
		delete output.errorMessage;
	} else {
		output.stopReason = "error";
		output.errorMessage = "Provider wrote the next turn in place of a reply";
	}
}
