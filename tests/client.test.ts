import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import {
	buildCompletionContext,
	type CompletionBackend,
	completeSnapshot,
	MAX_PREFIX_CHARS,
	MAX_SUFFIX_CHARS,
	normalizeCompletionText,
	SYSTEM_PROMPT,
} from "../src/client";

const idleSignal = new AbortController().signal;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function reply(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "google-gemini-cli",
		provider: "google-antigravity",
		model: "gemini-3.1-flash-lite",
		stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: Date.now(),
		...extra,
	} as AssistantMessage;
}

function recording(result: AssistantMessage | Error): { backend: CompletionBackend; calls: Array<{ context: Context; signal: AbortSignal }> } {
	const calls: Array<{ context: Context; signal: AbortSignal }> = [];
	const backend: CompletionBackend = async (context, signal) => {
		calls.push({ context, signal });
		if (result instanceof Error) throw result;
		return result;
	};
	return { backend, calls };
}

function draftOf(context: Context): { prefix: string; suffix: string } {
	const [message] = context.messages;
	if (message.role !== "user" || typeof message.content !== "string") throw new Error("expected one text user message");
	const draft = /(?:^|\n)Draft: (.*)$/.exec(message.content)?.[1];
	if (!draft) throw new Error("expected a Draft line");
	return JSON.parse(draft);
}

async function errorOf(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(`non-Error rejection: ${String(error)}`);
	}
	throw new Error("expected rejection");
}

describe("buildCompletionContext", () => {
	test("sends the system instruction and the draft as one JSON user turn", () => {
		const context = buildCompletionContext({ prefix: "hello wo", suffix: "\n" });
		expect(context.systemPrompt).toEqual([SYSTEM_PROMPT]);
		expect(context.messages.length).toBe(1);
		expect(context.tools).toBeUndefined();
		expect(draftOf(context)).toEqual({ prefix: "hello wo", suffix: "\n" });
	});

	test("bounds the draft to the tail of the prefix and head of the suffix without splitting pairs", () => {
		const prefix = `${"p".repeat(MAX_PREFIX_CHARS - 1)}\u{1F600}${"q".repeat(10)}`;
		const suffix = `${"s".repeat(MAX_SUFFIX_CHARS - 1)}\u{1F600}${"t".repeat(10)}`;
		const draft = draftOf(buildCompletionContext({ prefix, suffix }));
		expect(draft.prefix.length).toBeLessThanOrEqual(MAX_PREFIX_CHARS);
		expect(draft.prefix.endsWith("q".repeat(10))).toBe(true);
		expect(draft.suffix.length).toBeLessThanOrEqual(MAX_SUFFIX_CHARS);
		expect(draft.suffix.startsWith("s".repeat(10))).toBe(true);
		expect(LONE_SURROGATE.test(draft.prefix)).toBe(false);
		expect(LONE_SURROGATE.test(draft.suffix)).toBe(false);
	});

	test("the few-shot examples use the ins wrapper and read as coherent triples", () => {
		const lines = SYSTEM_PROMPT.split("\n");
		const inputs = lines.filter(line => line.startsWith("Draft: "));
		const outputs = lines.filter(line => line.startsWith("Output: "));
		expect(inputs.length).toBeGreaterThanOrEqual(3);
		expect(outputs.length).toBe(inputs.length);
		for (const [index, input] of inputs.entries()) {
			const { prefix, suffix } = JSON.parse(input.slice("Draft: ".length));
			const continuation = /^Output: <ins>(.*)<\/ins>$/.exec(outputs[index])?.[1];
			expect(continuation).toBeDefined();
			expect(`${prefix}${continuation}${suffix}`).toMatch(/^[A-Za-z].*[.;?)]$/);
		}
	});
});

describe("completeSnapshot", () => {
	test("returns the normalised text of the reply", async () => {
		const { backend, calls } = recording(reply("rld\nignored"));
		const text = await completeSnapshot(backend, { prefix: "hello wo", suffix: "" }, idleSignal);
		expect(text).toBe("rld");
		expect(calls.length).toBe(1);
		expect(draftOf(calls[0].context)).toEqual({ prefix: "hello wo", suffix: "" });
	});

	test("concatenates text blocks and ignores thinking", async () => {
		const { backend } = recording(
			reply("", { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "r" }, { type: "text", text: "ld" }] } as Partial<AssistantMessage>),
		);
		expect(await completeSnapshot(backend, { prefix: "wo", suffix: "" }, idleSignal)).toBe("rld");
	});

	test("an empty or whitespace reply yields null", async () => {
		expect(await completeSnapshot(recording(reply("")).backend, { prefix: "x", suffix: "" }, idleSignal)).toBeNull();
		expect(await completeSnapshot(recording(reply("  \n")).backend, { prefix: "x", suffix: "" }, idleSignal)).toBeNull();
	});

	test("throws an AbortError when the caller aborts, before or during the request", async () => {
		const aborted = new AbortController();
		aborted.abort();
		const { backend, calls } = recording(reply("never"));
		expect((await errorOf(completeSnapshot(backend, { prefix: "x", suffix: "" }, aborted.signal))).name).toBe("AbortError");
		expect(calls.length).toBe(0);

		const controller = new AbortController();
		const slow: CompletionBackend = (_context, signal) => {
			const { promise, reject } = Promise.withResolvers<AssistantMessage>();
			signal.addEventListener("abort", () => reject(new Error("socket closed")), { once: true });
			return promise;
		};
		const pending = completeSnapshot(slow, { prefix: "x", suffix: "" }, controller.signal);
		controller.abort();
		expect((await errorOf(pending)).name).toBe("AbortError");
	});

	test("the request signal follows the caller's signal", async () => {
		const controller = new AbortController();
		const { backend, calls } = recording(reply("ok"));
		await completeSnapshot(backend, { prefix: "x", suffix: "" }, controller.signal);
		expect(calls[0].signal.aborted).toBe(false);
		controller.abort();
		expect(calls[0].signal.aborted).toBe(true);
	});

	test("a reply that arrives after the caller aborted is discarded as an abort", async () => {
		const controller = new AbortController();
		const backend: CompletionBackend = async () => {
			controller.abort();
			return reply("late");
		};
		expect((await errorOf(completeSnapshot(backend, { prefix: "x", suffix: "" }, controller.signal))).name).toBe("AbortError");
	});

	test("a deadline yields null instead of an error, whether the backend rejects or reports aborted", async () => {
		const rejecting: CompletionBackend = (_context, signal) => {
			const { promise, reject } = Promise.withResolvers<AssistantMessage>();
			signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
			return promise;
		};
		expect(await completeSnapshot(rejecting, { prefix: "x", suffix: "" }, idleSignal, { deadlineMs: 5 })).toBeNull();

		const reporting: CompletionBackend = (_context, signal) => {
			const { promise, resolve } = Promise.withResolvers<AssistantMessage>();
			signal.addEventListener("abort", () => resolve(reply("", { stopReason: "aborted" })), { once: true });
			return promise;
		};
		expect(await completeSnapshot(reporting, { prefix: "x", suffix: "" }, idleSignal, { deadlineMs: 5 })).toBeNull();
	});

	test("provider errors surface as a one-line error without the draft", async () => {
		const { backend } = recording(reply("", { stopReason: "error", errorMessage: "401 unauthorized\nbody: SECRET DRAFT" }));
		const error = await errorOf(completeSnapshot(backend, { prefix: "SECRET DRAFT", suffix: "" }, idleSignal));
		expect(error.message).toBe("401 unauthorized");
		expect(error.message).not.toContain("SECRET");

		const thrown = await errorOf(completeSnapshot(recording(new Error("network down")).backend, { prefix: "x", suffix: "" }, idleSignal));
		expect(thrown.message).toBe("network down");
	});

	test("requires a signal", async () => {
		const { backend } = recording(reply("x"));
		await expect(completeSnapshot(backend, { prefix: "x", suffix: "" }, undefined as unknown as AbortSignal)).rejects.toThrow("AbortSignal is required");
	});
});

describe("normalizeCompletionText", () => {
	test("keeps the first physical line and drops the rest", () => {
		expect(normalizeCompletionText("rld\nextra line")).toBe("rld");
		expect(normalizeCompletionText("first\r\nsecond")).toBe("first");
		expect(normalizeCompletionText("rld\n")).toBe("rld");
	});

	test("never invents a continuation from the next line, and keeps leading spaces", () => {
		expect(normalizeCompletionText("\n\n  return value;")).toBeNull();
		expect(normalizeCompletionText(" world")).toBe(" world");
		expect(normalizeCompletionText("  return value;")).toBe("  return value;");
	});

	test("unwraps the ins wrapper, keeping leading spaces, and tolerates a missing close", () => {
		expect(normalizeCompletionText("<ins> error handling.</ins>")).toBe(" error handling.");
		expect(normalizeCompletionText("Output: <ins>led.</ins> trailing chatter")).toBe("led.");
		expect(normalizeCompletionText("<ins>unterminated")).toBe("unterminated");
		expect(normalizeCompletionText("<ins></ins>")).toBeNull();
		expect(normalizeCompletionText('led API requests."')).toBe('led API requests."');
	});

	test("removes C0/C1 controls and whole ANSI escape sequences", () => {
		expect(normalizeCompletionText("a\u0007b\u009bc")).toBe("abc");
		expect(normalizeCompletionText("a\tb")).toBe("a b");
		expect(normalizeCompletionText("\u001b[31mred\u001b[0m")).toBe("red");
		expect(normalizeCompletionText("\u001b]0;title\u0007rld")).toBe("rld");
		expect(normalizeCompletionText("\u{1F600}ok \u00e9\u0e44\u0e17\u0e22")).toBe("\u{1F600}ok \u00e9\u0e44\u0e17\u0e22");
	});

	test("rejects reasoning output instead of showing it", () => {
		expect(normalizeCompletionText("<thinking>weighing options</thinking>rld")).toBeNull();
		expect(normalizeCompletionText("<thinking>weighing")).toBeNull();
		expect(normalizeCompletionText("Thinking: the user wants")).toBeNull();
		expect(normalizeCompletionText("Reasoning - because")).toBeNull();
	});

	test("stops at chat and other special tokens", () => {
		expect(normalizeCompletionText("<|fim_middle|>rld")).toBeNull();
		expect(normalizeCompletionText("rld<|fim_middle|>")).toBe("rld");
		expect(normalizeCompletionText("rld<|im_end|>")).toBe("rld");
		expect(normalizeCompletionText("<|eot_id|>")).toBeNull();
		expect(normalizeCompletionText("rld<end_of_turn>junk")).toBe("rld");
	});

	test("unwraps a wholesale fenced block", () => {
		expect(normalizeCompletionText("```ts\n  return a + b;\n```")).toBe("  return a + b;");
		expect(normalizeCompletionText("```")).toBeNull();
		expect(normalizeCompletionText("```ts\n```")).toBeNull();
	});

	test("returns null for empty or non-string output", () => {
		expect(normalizeCompletionText("")).toBeNull();
		expect(normalizeCompletionText("   \n\t")).toBeNull();
		expect(normalizeCompletionText(null)).toBeNull();
		expect(normalizeCompletionText(undefined)).toBeNull();
		expect(normalizeCompletionText(42)).toBeNull();
	});

	test("caps very long output without splitting surrogate pairs", () => {
		const long = `${"a".repeat(500)}\u{1F600}tail`;
		const text = normalizeCompletionText(long);
		expect(text).not.toBeNull();
		expect((text as string).length).toBeLessThanOrEqual(400);
		expect(LONE_SURROGATE.test(text as string)).toBe(false);
	});
});
