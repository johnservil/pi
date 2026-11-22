import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
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

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

describe("OpenAI completions raw stop reasons", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	it("preserves raw finish reasons for successful stops", async () => {
		mockState.chunks = [{ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.rawStopReason).toBe("stop");
		expect(message.errorMessage).toBeUndefined();
	});

	it("preserves raw finish reasons for provider error stops", async () => {
		mockState.chunks = [{ id: "chatcmpl-2", choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("content_filter");
		expect(message.errorMessage).toBe("Provider finish_reason: content_filter");
	});

	it.each(["MALFORMED_RESPONSE", "MALFORMED_FUNCTION_CALL", "SAFETY", "RECITATION"])(
		"treats finish_reason=stop with error native_finish_reason=%s as an error",
		async (nativeFinishReason) => {
			mockState.chunks = [
				{
					id: "gen-1",
					choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: nativeFinishReason }],
				},
			];

			const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

			expect(message.stopReason).toBe("error");
			expect(message.rawStopReason).toBe(nativeFinishReason);
			expect(message.errorMessage).toBe(`Provider native_finish_reason: ${nativeFinishReason}`);
		},
	);

	it.each(["STOP", "end_turn", "completed", "stop"])(
		"keeps finish_reason=stop as a normal stop for non-error native_finish_reason=%s",
		async (nativeFinishReason) => {
			mockState.chunks = [
				{
					id: "gen-2",
					choices: [
						{
							index: 0,
							delta: { content: "ok" },
							finish_reason: "stop",
							native_finish_reason: nativeFinishReason,
						},
					],
				},
			];

			const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

			expect(message.stopReason).toBe("stop");
			expect(message.rawStopReason).toBe("stop");
			expect(message.errorMessage).toBeUndefined();
		},
	);
});
