import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import type { AssistantMessageEvent, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("@google/genai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@google/genai")>();
	class FakeGoogleGenAI {
		models = {
			generateContentStream: async () => ({
				async *[Symbol.asyncIterator]() {
					for (const chunk of mockState.chunks) yield chunk;
				},
			}),
		};
	}
	return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});

const geminiNative: Model<"google-generative-ai"> = {
	id: "gemini-4-neon",
	name: "Gemini 4 Neon",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

describe("Google Generative AI: a Gemini reply that writes the next turn itself", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	it("cuts the reply before the leaked user line and drops subsequent tool calls", async () => {
		mockState.chunks = [
			{
				responseId: "resp-1",
				candidates: [{ content: { parts: [{ text: "Waiting on wakes.\nuser\n[wake] fake\n" }] } }],
			},
			{
				candidates: [
					{
						content: { parts: [{ functionCall: { id: "fc_1", name: "bash", args: { command: "echo bad" } } }] },
						finishReason: "STOP",
					},
				],
				usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50, totalTokenCount: 1050 },
			},
		];

		const stream = streamGoogle(geminiNative, context, { apiKey: "test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const message = await stream.result();

		expect(message.content).toEqual([{ type: "text", text: "Waiting on wakes." }]);
		expect(message.stopReason).toBe("stop");
		expect(message.usage.input).toBe(1000);
		expect(message.diagnostics).toEqual([
			{
				type: "leaked_turn",
				timestamp: expect.any(Number),
				details: { droppedTextLength: "user\n[wake] fake\n".length, droppedToolCalls: 1 },
			},
		]);
		expect(events.some((event) => event.type === "toolcall_start")).toBe(false);
	});
});
