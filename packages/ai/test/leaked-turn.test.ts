import { describe, expect, it } from "vitest";
import { findLeakedTurn, namesTurnsUserAndModel } from "../src/utils/leaked-turn.ts";

const find = (text: string) => findLeakedTurn(text, { lineStart: 0, fence: 0 });

describe("findLeakedTurn", () => {
	it("finds the line that is exactly `user`", () => {
		const text = "CI is running; I wait for it.\n\nuser\nCI passed.\nmodel\nMerging.\n";
		expect(find(text)).toBe(text.indexOf("user\n"));
	});

	it("takes a line that holds more than the word for the reply's text", () => {
		for (const line of ["user says hello", " user", "user ", "User", "the user", "> user"]) {
			expect(find(`Before.\n${line}\nAfter.\n`)).toBeUndefined();
		}
	});

	it("leaves a transcript inside a fence alone, and reads on once the fence has closed", () => {
		const fenced = "A chat looks like this:\n```\nuser\nhello\nmodel\nhi\n```\n";
		expect(find(fenced)).toBeUndefined();
		expect(find(`${fenced}\nuser\ninvented\n`)).toBe(fenced.length + 1);
	});

	it("closes a fence with a run of backticks at least as long as the one that opened it, and nothing else", () => {
		expect(find("````md\n```\nuser\n```\n````\n")).toBeUndefined();
		expect(find("```\n```text\nuser\n```\n")).toBeUndefined();
		const closedIndented = "```\ncode\n   ```  \nuser\ninvented\n";
		expect(find(closedIndented)).toBe(closedIndented.indexOf("user\n"));
	});

	it("does not take a fence opened in an indented list item for an open fence", () => {
		// Never closed: the list item, and its code with it, ends at the first line at the margin.
		const text = "1. Build it:\n    ```sh\n    make\n\nuser\ninvented\nmodel\n";
		expect(find(text)).toBe(text.indexOf("user\n"));
	});

	it("reads a growing text once, and a line when its line break has arrived", () => {
		const scan = { lineStart: 0, fence: 0 };
		expect(findLeakedTurn("Done.\nus", scan)).toBeUndefined();
		expect(findLeakedTurn("Done.\nuser", scan)).toBeUndefined();
		expect(findLeakedTurn("Done.\nuser\n", scan)).toBe(6);
		expect(scan.lineStart).toBe(11);
	});

	it("remembers an open fence from one reading to the next", () => {
		const scan = { lineStart: 0, fence: 0 };
		expect(findLeakedTurn("```\n", scan)).toBeUndefined();
		expect(findLeakedTurn("```\nuser\n", scan)).toBeUndefined();
		expect(findLeakedTurn("```\nuser\n```\nuser\n", scan)).toBe(13);
	});
});

describe("namesTurnsUserAndModel", () => {
	it("is true of Gemini and Gemma under any host's name for them", () => {
		for (const id of [
			"google/gemini-4-neon",
			"gemini-3.1-pro-preview",
			"randomprefix-gemini-4-argon",
			"gemma4-27b",
		]) {
			expect(namesTurnsUserAndModel(id)).toBe(true);
		}
		for (const id of ["anthropic/claude-fable-5.2", "gpt-5.5", "mistral-large"]) {
			expect(namesTurnsUserAndModel(id)).toBe(false);
		}
	});
});
