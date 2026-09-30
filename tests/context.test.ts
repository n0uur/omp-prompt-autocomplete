import { describe, expect, test } from "bun:test";
import type { ReadonlySessionManager, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { buildCompletionContext } from "../src/client";
import { collectPromptContext, MAX_CONVERSATION_CHARS, MAX_FILES, MAX_TURNS, renderPromptContext } from "../src/context";

const CWD = "C:\\Work\\kmitl-website";

type Content = SessionEntry extends { type: "message"; message: infer M } ? M : never;

function entry(message: Content, index: number): SessionEntry {
	return { type: "message", id: `e${index}`, parentId: index === 0 ? null : `e${index - 1}`, timestamp: new Date(index * 1000).toISOString(), message } as SessionEntry;
}

function user(text: string, extra: Record<string, unknown> = {}): Content {
	return { role: "user", content: text, timestamp: 0, ...extra } as Content;
}

function assistant(text: string, toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = []): Content {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "private reasoning" },
			{ type: "text", text },
			...toolCalls.map((call, index) => ({ type: "toolCall", id: `c${index}`, name: call.name, arguments: call.arguments })),
		],
		stopReason: "stop",
		timestamp: 0,
	} as Content;
}

function session(messages: Content[], name?: string): ReadonlySessionManager {
	const branch = messages.map(entry);
	return { getBranch: () => branch, getSessionName: () => name } as unknown as ReadonlySessionManager;
}

describe("collectPromptContext", () => {
	test("empty session yields only the project line", () => {
		const context = collectPromptContext(session([]), CWD);
		expect(context.recentTurns).toEqual([]);
		expect(context.recentFiles).toEqual([]);
		expect(renderPromptContext(context)).toBe("project: kmitl-website (C:/Work/kmitl-website)");
	});

	test("keeps the latest turns in order, user text head-trimmed and assistant text tail-trimmed", () => {
		const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
		const context = collectPromptContext(
			session([user("first question"), assistant("first answer"), user(`second ${long}`), assistant(`${long} final answer`), user("third")], "login fixes"),
			CWD,
		);
		expect(context.sessionName).toBe("login fixes");
		expect(context.recentTurns.length).toBe(MAX_TURNS);
		expect(context.recentTurns.map(turn => turn.role)).toEqual(["assistant", "user", "assistant", "user"]);
		expect(context.recentTurns[0].text).toBe("first answer");
		expect(context.recentTurns[1].text.startsWith("second word0")).toBe(true);
		expect(context.recentTurns[1].text.endsWith("…")).toBe(true);
		expect(context.recentTurns[2].text.startsWith("…")).toBe(true);
		expect(context.recentTurns[2].text.endsWith("final answer")).toBe(true);
		expect(context.recentTurns[3].text).toBe("third");
		expect(context.recentTurns.reduce((sum, turn) => sum + turn.text.length, 0)).toBeLessThanOrEqual(MAX_CONVERSATION_CHARS + 2);
	});

	test("drops thinking, tool results, synthetic turns, attachments and system blocks", () => {
		const context = collectPromptContext(
			session([
				user("real question <system-reminder>secret injected text</system-reminder> tail"),
				user("auto-continue", { synthetic: true }),
				{ role: "toolResult", toolCallId: "c0", toolName: "read", content: [{ type: "text", text: "FILE CONTENTS" }], isError: false, timestamp: 0 } as Content,
				{ role: "user", content: [{ type: "text", text: "with image" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 0 } as Content,
				assistant("visible answer"),
			]),
			CWD,
		);
		const rendered = renderPromptContext(context);
		expect(context.recentTurns).toEqual([
			{ role: "user", text: "real question  tail" },
			{ role: "user", text: "with image" },
			{ role: "assistant", text: "visible answer" },
		]);
		expect(rendered).not.toContain("secret injected");
		expect(rendered).not.toContain("FILE CONTENTS");
		expect(rendered).not.toContain("private reasoning");
		expect(rendered).not.toContain("AAAA");
	});

	test("collects touched files newest first, relative to cwd, from path arguments and hashline headers", () => {
		const context = collectPromptContext(
			session([
				assistant("reading", [
					{ name: "read", arguments: { path: `${CWD}\\src\\login.ts` } },
					{ name: "read", arguments: { path: "https://example.com/page" } },
					{ name: "read", arguments: { path: "agent://Scout" } },
				]),
				assistant("editing", [
					{ name: "edit", arguments: { input: `[${CWD}\\src\\login.ts#1A2B]\nPUT 1.=1:\n+x\n[src/auth/session.ts#3C4D]\nPUT 2.=2:\n+y` } },
					{ name: "write", arguments: { path: "C:\\elsewhere\\notes.md", content: "" } },
				]),
			]),
			CWD,
		);
		expect(context.recentFiles).toEqual(["src/login.ts", "src/auth/session.ts", "C:/elsewhere/notes.md"]);
		expect(renderPromptContext(context)).toContain("recent files: src/login.ts, src/auth/session.ts, C:/elsewhere/notes.md");
	});

	test("caps the number of files", () => {
		const calls = Array.from({ length: MAX_FILES + 5 }, (_, i) => ({ name: "read", arguments: { path: `f${i}.ts` } }));
		const context = collectPromptContext(session([assistant("many", calls)]), CWD);
		expect(context.recentFiles.length).toBe(MAX_FILES);
		expect(context.recentFiles[0]).toBe("f0.ts");
	});
});

describe("buildCompletionContext with background", () => {
	test("places the background before the draft in the single user turn", () => {
		const background = collectPromptContext(session([user("fix the login redirect")], "login"), CWD);
		const context = buildCompletionContext({ prefix: "now also fix the", suffix: "" }, background);
		const content = context.messages[0].content as string;
		expect(content.startsWith("Background:\nproject: kmitl-website")).toBe(true);
		expect(content).toContain("session: login");
		expect(content).toContain("user: fix the login redirect");
		expect(content.endsWith(`Draft: ${JSON.stringify({ prefix: "now also fix the", suffix: "" })}`)).toBe(true);
	});

	test("omits the background block entirely when none is given", () => {
		const content = buildCompletionContext({ prefix: "a", suffix: "b" }).messages[0].content as string;
		expect(content).toBe(`Draft: ${JSON.stringify({ prefix: "a", suffix: "b" })}`);
	});
});
