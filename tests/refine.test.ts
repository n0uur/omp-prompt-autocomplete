import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { nextWordOf } from "../src/next-word";
import {
	MAX_REFINE_DRAFT_CHARS,
	parseRefinedPrompt,
	placeholderMismatches,
	protectedTokensOf,
	type RefineBackend,
	RefineError,
	type RefineRequest,
	refineDraft,
} from "../src/refine";

const idleSignal = new AbortController().signal;

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

function backendOf(result: AssistantMessage | Error): { backend: RefineBackend; calls: Array<{ context: Context; maxTokens: number }> } {
	const calls: Array<{ context: Context; maxTokens: number }> = [];
	const backend: RefineBackend = async (context, _signal, maxTokens) => {
		calls.push({ context, maxTokens });
		if (result instanceof Error) throw result;
		return result;
	};
	return { backend, calls };
}

function userText(context: Context): string {
	const [message] = context.messages;
	if (message.role !== "user" || typeof message.content !== "string") throw new Error("expected one text user message");
	return message.content;
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

const request = (overrides: Partial<RefineRequest> = {}): RefineRequest => ({
	draft: "pls fix teh login bug",
	instruction: "Fix grammar",
	protectedTokens: [],
	...overrides,
});

describe("nextWordOf", () => {
	test("takes leading space plus one word and the punctuation glued to it", () => {
		expect(nextWordOf("led API requests.")).toBe("led");
		expect(nextWordOf(" API requests.")).toBe(" API");
		expect(nextWordOf(" requests.")).toBe(" requests.");
	});

	test("walks code in word-plus-punctuation chunks (UAX #29 keeps dotted names whole)", () => {
		expect(nextWordOf("value.map(transform);")).toBe("value.map(");
		expect(nextWordOf("transform);")).toBe("transform);");
		expect(nextWordOf("(sum, price) => sum")).toBe("(sum,");
	});

	test("keeps contractions and decimals whole", () => {
		expect(nextWordOf(" don't know")).toBe(" don't");
		expect(nextWordOf(" 3.14 radians")).toBe(" 3.14");
	});

	test("segments scripts without spaces instead of taking everything", () => {
		const thai = "แก้บั๊กในไฟล์นี้";
		const word = nextWordOf(thai);
		expect(word.length).toBeGreaterThan(0);
		expect(word.length).toBeLessThan(thai.length);
		expect(thai.startsWith(word)).toBe(true);
	});

	test("whitespace-only input is accepted whole", () => {
		expect(nextWordOf("   ")).toBe("   ");
	});
});

describe("parseRefinedPrompt", () => {
	test("takes the tagged body and keeps its line breaks", () => {
		expect(parseRefinedPrompt("Sure!\n<prompt>\nFix the login bug.\n\n- keep tests green\n</prompt>")).toBe(
			"Fix the login bug.\n\n- keep tests green",
		);
	});

	test("accepts an unterminated tag and a later literal mention of the tag", () => {
		expect(parseRefinedPrompt("<prompt>Fix it")).toBe("Fix it");
		expect(parseRefinedPrompt("<prompt>Explain the </prompt> tag</prompt>")).toBe("Explain the </prompt> tag");
	});

	test("unwraps a wholesale fence when the model skipped the tags", () => {
		expect(parseRefinedPrompt("```text\nFix the login bug.\n```")).toBe("Fix the login bug.");
	});

	test("strips terminal controls but keeps tabs and newlines", () => {
		expect(parseRefinedPrompt("<prompt>\u001b[31mred\u001b[0m\tand\r\nnext\u0007</prompt>")).toBe("red\tand\nnext");
	});

	test("empty or non-string replies are unusable", () => {
		expect(parseRefinedPrompt("<prompt>  </prompt>")).toBeNull();
		expect(parseRefinedPrompt(undefined)).toBeNull();
	});
});

describe("placeholders", () => {
	test("collects pattern matches and atom labels in order, counting overlaps once", () => {
		const pattern = /\[(?:Image|Paste) #\d+[^\]]*\]/g;
		const text = "See [Image #1, 800x600] and [Paste #2, +30 lines] with ⟨skill:review⟩, again [Image #1, 800x600]";
		expect(protectedTokensOf(text, pattern, ["⟨skill:review⟩", "#1"])).toEqual([
			"[Image #1, 800x600]",
			"[Paste #2, +30 lines]",
			"⟨skill:review⟩",
			"[Image #1, 800x600]",
		]);
	});

	test("a non-global editor pattern still finds every occurrence", () => {
		expect(protectedTokensOf("[Paste #1] [Paste #1]", /\[Paste #\d+\]/, [])).toEqual(["[Paste #1]", "[Paste #1]"]);
	});

	test("mismatch reports lost and duplicated placeholders", () => {
		const expected = ["[Image #1]", "[Paste #2]", "[Paste #2]"];
		expect(placeholderMismatches(expected, "[Image #1] [Paste #2] [Paste #2]")).toEqual([]);
		expect(placeholderMismatches(expected, "[Paste #2] [Paste #2]")).toEqual(["[Image #1]"]);
		expect(placeholderMismatches(expected, "[Image #1] [Image #1] [Paste #2] [Paste #2]")).toEqual(["[Image #1]"]);
		expect(placeholderMismatches(expected, "[Image #1] [Paste #2]")).toEqual(["[Paste #2]"]);
	});
});

describe("refineDraft", () => {
	test("sends instruction, placeholders and draft as data and returns the rewrite", async () => {
		const { backend, calls } = backendOf(reply("<prompt>Please fix the login bug in [Image #1].</prompt>"));
		const result = await refineDraft(
			backend,
			request({
				draft: "pls fix teh login bug in [Image #1]",
				protectedTokens: ["[Image #1]"],
				background: { cwd: "C:\\Work\\app", recentTurns: [], recentFiles: ["src/login.ts"] },
			}),
			idleSignal,
		);
		expect(result).toBe("Please fix the login bug in [Image #1].");
		const text = userText(calls[0].context);
		expect(text).toContain("Refinement instruction: Fix grammar");
		expect(text).toContain('Placeholders to keep verbatim: "[Image #1]"');
		expect(text).toContain("<draft>\npls fix teh login bug in [Image #1]\n</draft>");
		expect(text).toContain("recent files: src/login.ts");
		expect(calls[0].context.tools).toBeUndefined();
	});

	test("output budget grows with the draft within bounds", async () => {
		const small = backendOf(reply("<prompt>ok</prompt>"));
		await refineDraft(small.backend, request({ draft: "short" }), idleSignal);
		const large = backendOf(reply("<prompt>ok</prompt>"));
		await refineDraft(large.backend, request({ draft: "x".repeat(MAX_REFINE_DRAFT_CHARS) }), idleSignal);
		expect(small.calls[0].maxTokens).toBe(1024);
		expect(large.calls[0].maxTokens).toBe(8192);
	});

	test("a rewrite that drops an attachment placeholder is rejected", async () => {
		const { backend } = backendOf(reply("<prompt>Please fix the login bug.</prompt>"));
		const error = await errorOf(
			refineDraft(backend, request({ draft: "fix bug [Paste #1, +30 lines]", protectedTokens: ["[Paste #1, +30 lines]"] }), idleSignal),
		);
		expect(error).toBeInstanceOf(RefineError);
		expect(error.message).toContain("[Paste #1, +30 lines]");
	});

	test("provider errors, truncation and empty replies become RefineErrors without the draft", async () => {
		const secret = "SECRET-DRAFT-TEXT";
		const cases: Array<[AssistantMessage | Error, string]> = [
			[reply("", { stopReason: "error", errorMessage: "429 quota exceeded\ndetails" }), "429 quota exceeded"],
			[reply("<prompt>half", { stopReason: "length" }), "cut off"],
			[reply("<prompt></prompt>"), "nothing usable"],
			[new Error("socket hang up\nstack"), "socket hang up"],
		];
		for (const [result, expected] of cases) {
			const error = await errorOf(refineDraft(backendOf(result).backend, request({ draft: secret }), idleSignal));
			expect(error).toBeInstanceOf(RefineError);
			expect(error.message).toBe(error.message.split("\n")[0]);
			expect(error.message).toContain(expected);
			expect(error.message).not.toContain(secret);
		}
	});

	test("the caller's abort is an AbortError, the deadline a RefineError", async () => {
		const hanging: RefineBackend = (_context, signal) => {
			const { promise, reject } = Promise.withResolvers<AssistantMessage>();
			signal.addEventListener("abort", () => reject(new Error("aborted")));
			return promise;
		};
		const controller = new AbortController();
		const pending = refineDraft(hanging, request(), controller.signal);
		controller.abort();
		expect((await errorOf(pending)).name).toBe("AbortError");
		const late = await errorOf(refineDraft(hanging, request(), idleSignal, { deadlineMs: 5 }));
		expect(late).toBeInstanceOf(RefineError);
		expect(late.message).toContain("in time");
	});

	test("empty drafts, empty instructions and oversized drafts never reach the model", async () => {
		const { backend, calls } = backendOf(reply("<prompt>x</prompt>"));
		for (const bad of [request({ draft: "  " }), request({ instruction: " " }), request({ draft: "x".repeat(MAX_REFINE_DRAFT_CHARS + 1) })]) {
			expect(await errorOf(refineDraft(backend, bad, idleSignal))).toBeInstanceOf(RefineError);
		}
		expect(calls.length).toBe(0);
	});
});
