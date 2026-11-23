import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessageEvent, Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const gemini: Model<"openai-completions"> = {
	id: "google/gemini-4-neon",
	name: "Gemini 4 Neon",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

// The chunks OpenRouter streams for a Gemini response.
const delta = (fields: Record<string, unknown>) => ({ id: "gen-1", choices: [{ index: 0, delta: fields }] });
const text = (content: string) => delta({ content });
const reasoning = (words: string) => delta({ reasoning: words });
const call = (index: number, id: string, command: string) => ({
	index,
	id,
	type: "function",
	function: { name: "bash", arguments: JSON.stringify({ command }) },
});
const toolCall = (index: number, id: string, command: string) => delta({ tool_calls: [call(index, id, command)] });
const finish = (finishReason: string, nativeFinishReason: string) => ({
	id: "gen-1",
	choices: [{ index: 0, delta: {}, finish_reason: finishReason, native_finish_reason: nativeFinishReason }],
	usage: { prompt_tokens: 600_000, completion_tokens: 300 },
});

// A reply, then the turn the model invents and its answer to it: reasoning, text and a tool call.
const leakedAfterReply = [
	reasoning("CI has not finished."),
	text("CI is still running; I wait for it.\n\n"),
	text("user\n[notice] CI passed.\nmodel\n"),
	reasoning("It passed, so I merge."),
	text("Merging now."),
	toolCall(0, "call_1", "merge"),
	finish("tool_calls", "STOP"),
];

async function respond(model: Model<"openai-completions">, chunks: unknown[]) {
	mockState.chunks = chunks;
	const stream = streamOpenAICompletions(model, context, { apiKey: "test" });
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { message: await stream.result(), events };
}

describe("OpenAI completions: a Gemini reply that writes the next turn itself", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	it("keeps what came before the invented turn and leaves out what came after", async () => {
		const { message, events } = await respond(gemini, leakedAfterReply);

		expect(message.content).toEqual([
			{ type: "thinking", thinking: "CI has not finished.", thinkingSignature: "reasoning" },
			{ type: "text", text: "CI is still running; I wait for it." },
		]);
		expect(message.stopReason).toBe("stop");
		expect(message.errorMessage).toBeUndefined();
		expect(message.diagnostics).toEqual([
			{
				type: "leaked_turn",
				timestamp: expect.any(Number),
				details: {
					droppedTextLength: "user\n[notice] CI passed.\nmodel\nMerging now.".length,
					droppedToolCalls: 1,
				},
			},
		]);
		// The stream was read to its end: the usage arrives last.
		expect(message.usage.input).toBe(600_000);

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"text_start",
			"text_delta",
			"thinking_end",
			"text_end",
			"done",
		]);
		expect(events.find((event) => event.type === "text_end")).toMatchObject({
			content: "CI is still running; I wait for it.",
		});
	});

	it("keeps a tool call made before the invented turn, and ends in tool use", async () => {
		const { message } = await respond(gemini, [
			text("I check the run.\n"),
			toolCall(0, "call_1", "status"),
			text("user\n[notice] The run failed.\nmodel\n"),
			toolCall(1, "call_2", "revert"),
			finish("tool_calls", "STOP"),
		]);

		expect(message.content).toHaveLength(2);
		expect(message.content).toMatchObject([
			{ type: "text", text: "I check the run." },
			{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "status" } },
		]);
		expect(message.stopReason).toBe("toolUse");
	});

	it("leaves out a tool call that arrives in one delta with the invented turn's first line", async () => {
		const { message } = await respond(gemini, [
			text("Done.\n"),
			delta({ content: "user\n[notice] Go on.\nmodel\n", tool_calls: [call(0, "call_1", "merge")] }),
			finish("tool_calls", "STOP"),
		]);

		expect(message.content).toEqual([{ type: "text", text: "Done." }]);
		expect(message.stopReason).toBe("stop");
	});

	it("ends as a reply does when the provider calls the invented turn malformed", async () => {
		const { message } = await respond(gemini, [
			text("Done.\nuser\n[notice] One more thing.\nmodel\n"),
			finish("stop", "MALFORMED_RESPONSE"),
		]);

		expect(message.content).toEqual([{ type: "text", text: "Done." }]);
		expect(message.stopReason).toBe("stop");
		expect(message.rawStopReason).toBe("MALFORMED_RESPONSE");
		expect(message.errorMessage).toBeUndefined();
	});

	it("finds a line that arrives in two deltas", async () => {
		const { message, events } = await respond(gemini, [
			text("Done.\nus"),
			text("er\n[notice] One more thing.\n"),
			finish("stop", "STOP"),
		]);

		expect(message.content).toEqual([{ type: "text", text: "Done." }]);
		// The first delta had gone out; the second brings nothing that stays.
		expect(events.filter((event) => event.type === "text_delta")).toHaveLength(1);
		expect(events.find((event) => event.type === "text_end")).toMatchObject({ content: "Done." });
	});

	it("reports a response that begins with the invented turn as an error to retry", async () => {
		const { message, events } = await respond(gemini, [
			text("user\n[notice] CI passed.\nmodel\nMerging now."),
			toolCall(0, "call_1", "merge"),
			finish("tool_calls", "STOP"),
		]);

		expect(message.content).toEqual([{ type: "text", text: "" }]);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Provider wrote the next turn in place of a reply");
		expect(isRetryableAssistantError(message)).toBe(true);
		expect(events.at(-1)?.type).toBe("error");
	});

	it("leaves a transcript inside a fence in the reply", async () => {
		const quoted = "A chat looks like this:\n```\nuser\nhello\nmodel\nhi\n```\n";
		const { message } = await respond(gemini, [text(quoted), finish("stop", "STOP")]);

		expect(message.content).toEqual([{ type: "text", text: quoted }]);
		expect(message.diagnostics).toBeUndefined();
	});

	it("leaves the reply of a model with other turn names as it is", async () => {
		const { message } = await respond({ ...gemini, id: "anthropic/claude-fable-5.2" }, leakedAfterReply);

		expect(message.content).toHaveLength(3);
		expect(message.content).toMatchObject([
			{ type: "thinking", thinking: "CI has not finished.It passed, so I merge.", thinkingSignature: "reasoning" },
			{
				type: "text",
				text: "CI is still running; I wait for it.\n\nuser\n[notice] CI passed.\nmodel\nMerging now.",
			},
			{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "merge" } },
		]);
		expect(message.stopReason).toBe("toolUse");
		expect(message.diagnostics).toBeUndefined();
	});

	it("cuts an unterminated trailing user line before a tool call or at end of stream", async () => {
		const beforeTool = await respond(gemini, [
			text("Waiting on wakes.\nuser"),
			toolCall(0, "call_1", "merge"),
			finish("tool_calls", "STOP"),
		]);
		expect(beforeTool.message.content).toEqual([{ type: "text", text: "Waiting on wakes." }]);
		expect(beforeTool.message.stopReason).toBe("stop");
		expect(beforeTool.message.diagnostics).toEqual([
			{
				type: "leaked_turn",
				timestamp: expect.any(Number),
				details: { droppedTextLength: 4, droppedToolCalls: 1 },
			},
		]);

		const atEof = await respond(gemini, [text("Waiting on wakes.\n<|turn>user"), finish("stop", "STOP")]);
		expect(atEof.message.content).toEqual([{ type: "text", text: "Waiting on wakes." }]);
		expect(atEof.message.stopReason).toBe("stop");
		expect(atEof.message.diagnostics).toEqual([
			{
				type: "leaked_turn",
				timestamp: expect.any(Number),
				details: { droppedTextLength: "<|turn>user".length, droppedToolCalls: 0 },
			},
		]);
	});
});
