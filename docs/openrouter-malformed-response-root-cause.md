# Root Cause: Silent Empty Mid-Stream Stops with Gemini via OpenRouter (`MALFORMED_RESPONSE`)

- **Upstream Pi issue:** [earendil-works/pi#12407](https://github.com/earendil-works/pi/issues/12407)
- **Fix commit (this fork, branch `fix/openrouter-native-finish-reason`):** [`9ce43c3`](https://github.com/johnservil/pi/commit/9ce43c392dc75d618986fed32d991c957a74c3ec)

## Symptom

When running Google Gemini models (such as `google/gemini-4-neon` and `google/gemini-4-argon`) through OpenRouter in Pi, turns occasionally stop silently mid-task with an empty assistant message (sometimes after thinking/reasoning output) and **never auto-retry**.

## Root Cause: A Three-Way Mismatch (Google → OpenRouter → Pi)

Inspecting OpenRouter's generation metadata (`GET /api/v1/generation?id=<generation-id>`) across **9 out of 9** silent empty stops observed in real sessions — together with a live OpenRouter SSE stream capture and Pi's `packages/ai` source — revealed the exact same mechanism in every single case:

1. **Google (upstream provider)** generated reasoning tokens (typically ~170–320 tokens), hit an internal malformed output condition (0 non-reasoning completion tokens, empty visible content), and ended the stream with:
   - `native_finish_reason: "MALFORMED_RESPONSE"`
   *(Normal completions return `native_finish_reason: "STOP"`.)*

2. **OpenRouter** normalized Google's `"MALFORMED_RESPONSE"` into the OpenAI-compatible `finish_reason: "stop"` — while still forwarding `native_finish_reason: "MALFORMED_RESPONSE"` alongside it on the streamed SSE choice object (`choice` fields: `index`, `delta`, `finish_reason`, `native_finish_reason`).

3. **Pi (`packages/ai/src/api/openai-completions.ts`)** read only `choice.finish_reason` and ignored `choice.native_finish_reason`. Seeing `finish_reason: "stop"`, Pi classified the failed generation as a normal end-of-turn (`stopReason: "stop"`), accepted the empty response, stopped the agent loop silently, and never invoked auto-retry.
   - By contrast, Pi's direct Google adapter (`packages/ai/src/api/google-shared.ts`) already maps `MALFORMED_FUNCTION_CALL` and other non-`STOP`/`MAX_TOKENS` finish reasons to `stopReason: "error"`.

## Where Each Fix Belongs

- **Google:** model/serving-side cause emitting `MALFORMED_RESPONSE` after reasoning tokens.
- **OpenRouter:** should not normalize an upstream error (`MALFORMED_RESPONSE`) into `finish_reason: "stop"`.
- **Pi (`earendil-works/pi#12407`):** `openai-completions.ts` should inspect `choice.native_finish_reason` when `finish_reason` is `"stop"`/`"end"` and treat transient malformed-response stops as retryable errors.

## Fix in This Fork (`9ce43c3`)

Implemented on clean upstream-ready branch [`fix/openrouter-native-finish-reason`](https://github.com/johnservil/pi/tree/fix/openrouter-native-finish-reason) and merged into `main`:

1. **`packages/ai/src/api/openai-completions.ts`:** When `finish_reason` is `"stop"` or `"end"`, checks `choice.native_finish_reason` against known upstream error finish reasons (`MALFORMED_RESPONSE`, `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`, `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_*`, `LANGUAGE`, `NO_IMAGE`). When matched, maps the turn to `stopReason: "error"`, preserves `rawStopReason` as the native reason, and sets `errorMessage` to `Provider native_finish_reason: <reason>`.
2. **`packages/ai/src/utils/retry.ts`:** Treats `malformed_response` and `malformed_function_call` (whether via OpenRouter's `native_finish_reason` or direct Google adapters) as retryable transient provider errors, while keeping safety/policy refusals non-retryable.
3. **Tests:** Added regression tests in `packages/ai/test/openai-completions-raw-stop-reason.test.ts` and `packages/ai/test/retry.test.ts`.

See the top of [`README.md`](../README.md) for building and installing this fork locally.
