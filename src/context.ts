import type { Message } from "@oh-my-pi/pi-ai";
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent";
import path from "node:path";

/**
 * Background the model may use to guess better: where the user is working, what was just
 * discussed, and which files the agent touched. Everything is bounded and drawn only from the
 * current session branch; tool outputs and thinking are never included.
 */
export interface PromptContext {
	/** Absolute working directory. */
	cwd: string;
	sessionName?: string;
	/** Oldest first; assistant turns are text only and tail-trimmed. */
	recentTurns: Array<{ role: "user" | "assistant"; text: string }>;
	/** Most recent first, deduplicated, relative to `cwd` where possible. */
	recentFiles: string[];
}

export const MAX_TURNS = 4;
export const MAX_USER_TURN_CHARS = 600;
export const MAX_ASSISTANT_TURN_CHARS = 500;
export const MAX_CONVERSATION_CHARS = 1500;
export const MAX_FILES = 10;
/** Stop walking the branch once this many message entries have been inspected. */
const MAX_ENTRIES_SCANNED = 200;

const HASHLINE_HEADER = /^\[([^\]\n]+?)#[0-9A-Fa-f]{4}\]$/gm;
const SYSTEM_BLOCKS = /<(system-reminder|system-notice)\b[\s\S]*?<\/\1>/g;
const PATH_ARGUMENT_KEYS = ["path", "file_path", "filePath"] as const;

/** Visible text of a message: user text (attachments dropped) or assistant text blocks. */
function visibleText(message: Message): string {
	if (message.role === "user") {
		const content = typeof message.content === "string" ? message.content : message.content.map(block => (block.type === "text" ? block.text : "")).join("");
		return content.replace(SYSTEM_BLOCKS, "").trim();
	}
	if (message.role === "assistant") {
		return message.content
			.map(block => (block.type === "text" ? block.text : ""))
			.join("")
			.trim();
	}
	return "";
}

/** Head of `value` capped to `max` characters on a whitespace boundary where possible. */
function headOf(value: string, max: number): string {
	if (value.length <= max) return value;
	const cut = value.lastIndexOf(" ", max);
	return `${value.slice(0, cut > max / 2 ? cut : max)}…`;
}

/** Tail of `value` capped to `max` characters on a whitespace boundary where possible. */
function tailOf(value: string, max: number): string {
	if (value.length <= max) return value;
	const start = value.length - max;
	const cut = value.indexOf(" ", start);
	return `…${value.slice(cut !== -1 && cut < start + max / 2 ? cut + 1 : start)}`;
}

/** File paths named by a tool call: `path`-like arguments and hashline edit headers. */
function filesOfToolCall(name: string, args: Record<string, unknown>): string[] {
	const files: string[] = [];
	for (const key of PATH_ARGUMENT_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0 && !value.includes("://")) files.push(value);
	}
	if (name === "edit" && typeof args.input === "string") {
		for (const match of args.input.matchAll(HASHLINE_HEADER)) files.push(match[1]);
	}
	return files;
}

export function collectPromptContext(session: ReadonlySessionManager, cwd: string): PromptContext {
	const context: PromptContext = { cwd, sessionName: session.getSessionName(), recentTurns: [], recentFiles: [] };
	const branch = session.getBranch();
	const files = new Set<string>();
	const turns: PromptContext["recentTurns"] = [];
	let conversationChars = 0;
	let scanned = 0;
	for (let index = branch.length - 1; index >= 0 && scanned < MAX_ENTRIES_SCANNED; index--) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		scanned++;
		const message = entry.message as Message;
		if (message.role === "assistant" && files.size < MAX_FILES) {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				for (const file of filesOfToolCall(block.name, block.arguments)) {
					if (files.size >= MAX_FILES) break;
					const absolute = path.isAbsolute(file) ? file : path.resolve(cwd, file);
					const relative = path.relative(cwd, absolute);
					files.add(relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.replaceAll("\\", "/") : absolute.replaceAll("\\", "/"));
				}
			}
		}
		if (turns.length >= MAX_TURNS || conversationChars >= MAX_CONVERSATION_CHARS) continue;
		if (message.role !== "user" && message.role !== "assistant") continue;
		if (message.role === "user" && message.synthetic) continue;
		const text = visibleText(message);
		if (!text) continue;
		const trimmed =
			message.role === "user"
				? headOf(text, Math.min(MAX_USER_TURN_CHARS, MAX_CONVERSATION_CHARS - conversationChars))
				: tailOf(text, Math.min(MAX_ASSISTANT_TURN_CHARS, MAX_CONVERSATION_CHARS - conversationChars));
		if (!trimmed) continue;
		turns.push({ role: message.role, text: trimmed });
		conversationChars += trimmed.length;
	}
	context.recentTurns = turns.reverse();
	context.recentFiles = [...files];
	return context;
}

/** Render the context as the background block of the user message; empty when nothing is known. */
export function renderPromptContext(context: PromptContext | undefined): string {
	if (!context) return "";
	const lines: string[] = [`project: ${path.basename(context.cwd) || context.cwd} (${context.cwd.replaceAll("\\", "/")})`];
	if (context.sessionName) lines.push(`session: ${context.sessionName}`);
	if (context.recentFiles.length > 0) lines.push(`recent files: ${context.recentFiles.join(", ")}`);
	if (context.recentTurns.length > 0) {
		lines.push("conversation so far:");
		for (const turn of context.recentTurns) lines.push(`${turn.role}: ${turn.text.replaceAll("\n", " ")}`);
	}
	return lines.join("\n");
}
