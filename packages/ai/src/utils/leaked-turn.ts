// Finds where a Gemini or Gemma reply starts to write the next turn itself.
//
// These models name their turns `user` and `model`. Now and then one ends its reply and, in place of
// stopping, goes on as plain text: a line `user`, a user message it invents, a line `model`, and its answer
// to that message, tool calls included. Seen with google/gemini-4-neon through OpenRouter: 25 replies of one
// long session, each with more than 530,000 tokens of context, and none of that model's 443 replies with
// less. The line `user` is where the model's own turn ended.

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

/**
 * Reads the complete lines of `text` that `scan` has not read, and returns the offset of the first that is
 * exactly `user` outside fenced code, or undefined when there is none. A reply's text is passed again each
 * time it grows; the last line is read once its line break has arrived.
 *
 * A fence opens with three or more backticks at the left margin and closes with a run at least as long.
 * A fence that opens indented (in a list item, as a rule) opens nothing here: its lines are indented with
 * it, so a line that is exactly `user` is none of them, and where such a fence is never closed the list
 * item ends at the first line at the margin.
 */
export function findLeakedTurn(text: string, scan: LeakedTurnScan): number | undefined {
	for (let end = text.indexOf("\n", scan.lineStart); end !== -1; end = text.indexOf("\n", scan.lineStart)) {
		const start = scan.lineStart;
		const line = text.slice(start, end);
		scan.lineStart = end + 1;
		if (scan.fence > 0) {
			const closing = /^ {0,3}(`{3,})[ \t]*$/.exec(line);
			if (closing && closing[1].length >= scan.fence) scan.fence = 0;
		} else if (line === "user") {
			return start;
		} else {
			scan.fence = /^(`{3,})[^`]*$/.exec(line)?.[1].length ?? 0;
		}
	}
	return undefined;
}
