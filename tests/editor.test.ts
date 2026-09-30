import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	type AutocompleteProvider,
	CURSOR_MARKER,
	getEditorTheme,
	getKeybindings,
	ProcessTerminal,
	TUI,
} from "@oh-my-pi/pi-tui";
import type { CompletionSnapshot } from "../src/client";
import { PromptAutocompleteEditor, type PromptAutocompleteEditorOptions, type RefineState } from "../src/editor";

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const restores: Array<{ mockRestore(): void }> = [];
const editors: PromptAutocompleteEditor[] = [];
const timers = new Map<NodeJS.Timeout, () => void>();
let nextTimer = -1;

beforeEach(() => {
	// Control only the completion debounce, leaving native editor timers untouched.
	restores.push(spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
		if (ms !== 180) return realSetTimeout(callback, ms, ...args);
		const id = nextTimer-- as unknown as NodeJS.Timeout;
		timers.set(id, () => callback(...args));
		return id;
	}) as typeof setTimeout));
	restores.push(spyOn(globalThis, "clearTimeout").mockImplementation(((id: NodeJS.Timeout) => {
		if (typeof id === "number" && id < 0) timers.delete(id);
		else realClearTimeout(id);
	}) as typeof clearTimeout));
});

afterEach(() => {
	for (const editor of editors.splice(0)) editor.dispose();
	for (const restore of restores.splice(0).reverse()) restore.mockRestore();
	timers.clear();
});

function createEditor(
	complete: (snapshot: CompletionSnapshot, signal: AbortSignal) => Promise<string | null>,
	options: Omit<PromptAutocompleteEditorOptions, "complete"> = {},
) {
	const tui = new TUI(new ProcessTerminal());
	// No terminal ownership or scheduler is needed for direct native editor rendering.
	restores.push(spyOn(tui, "requestRender").mockImplementation(() => {}));
	const editor = new PromptAutocompleteEditor(tui, getEditorTheme(), getKeybindings(), { complete, ...options });
	editor.setSpellingFeatures({ typoDetection: false, autocorrect: false, autocomplete: "off" });
	editor.focused = true;
	editors.push(editor);
	return editor;
}

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function debounce() {
	const scheduled = [...timers.values()];
	timers.clear();
	for (const callback of scheduled) callback();
	await settle();
}

function deferred() {
	let resolve!: (value: string | null) => void;
	const promise = new Promise<string | null>(done => { resolve = done; });
	return { promise, resolve };
}

function screen(editor: PromptAutocompleteEditor) {
	// TUI consumes its private cursor marker before terminal ANSI processing.
	return stripVTControlCharacters(editor.render(100).join("\n").replaceAll(CURSOR_MARKER, ""));
}

test("native Tab accepts a phrase and punctuation consumes its provisional space", async () => {
	const editor = createEditor(async () => "the failure path");
	editor.setText("Explain ");
	editor.render(100);
	await debounce();
	expect(screen(editor)).toContain("the failure path");
	expect(editor.getText()).toBe("Explain ");
	editor.handleInput("\t");
	expect(editor.getText()).toBe("Explain the failure path ");
	editor.handleInput(".");
	expect(editor.getText()).toBe("Explain the failure path.");
});

test("right arrow inserts the exact code suffix without a space", async () => {
	const editor = createEditor(async () => "value.map(transform);");
	editor.setText("```ts\nreturn ");
	editor.render(100);
	await debounce();
	editor.handleInput("\x1b[C");
	expect(editor.getText()).toBe("```ts\nreturn value.map(transform);");
});

test("Escape dismisses a shown suggestion before the original interrupt handler", async () => {
	const editor = createEditor(async () => "the edge cases");
	let interrupts = 0;
	editor.onEscape = () => { interrupts++; };
	editor.setText("Cover ");
	editor.render(100);
	await debounce();
	editor.handleInput("\x1b");
	expect(interrupts).toBe(0);
	expect(screen(editor)).not.toContain("the edge cases");
	await debounce();
	editor.handleInput("\x1b");
	expect(interrupts).toBe(1);
	expect(editor.getText()).toBe("Cover ");
});

test("Escape cancels an in-flight result and does not swallow the next interrupt", async () => {
	const result = deferred();
	let signal!: AbortSignal;
	const editor = createEditor(async (_snapshot, requestSignal) => {
		signal = requestSignal;
		return result.promise;
	});
	let interrupts = 0;
	editor.onEscape = () => { interrupts++; };
	editor.setText("Describe ");
	editor.render(100);
	await debounce();
	editor.handleInput("\x1b");
	expect(signal.aborted).toBe(true);
	expect(interrupts).toBe(0);
	result.resolve("a stale response");
	await settle();
	expect(screen(editor)).not.toContain("a stale response");
	editor.handleInput("\x1b");
	expect(interrupts).toBe(1);
});

test("Escape during debounce prevents inference", async () => {
	let calls = 0;
	const editor = createEditor(async () => { calls++; return "anything"; });
	editor.setText("Describe ");
	editor.render(100);
	editor.handleInput("\x1b");
	await debounce();
	expect(calls).toBe(0);
});

test("cursor movement aborts inference and right arrow mid-line only moves the cursor", async () => {
	const result = deferred();
	let signal!: AbortSignal;
	const editor = createEditor(async (_snapshot, requestSignal) => {
		signal = requestSignal;
		return result.promise;
	});
	editor.setText("Explain");
	editor.render(100);
	await debounce();
	editor.handleInput("\x1b[D");
	expect(signal.aborted).toBe(true);
	result.resolve(" this stale phrase");
	await settle();
	expect(screen(editor)).not.toContain("this stale phrase");
	editor.handleInput("\x1b[C");
	expect(editor.getText()).toBe("Explain");
	expect(editor.getCursor()).toEqual({ line: 0, col: 7 });
});

test("external draft replacement cannot display or accept an old result", async () => {
	const result = deferred();
	const editor = createEditor(async () => result.promise);
	editor.setText("Original ");
	editor.render(100);
	await debounce();
	editor.setText("Replacement ");
	result.resolve("old suggestion");
	await settle();
	expect(screen(editor)).not.toContain("old suggestion");
	editor.handleInput("\x1b[C");
	expect(editor.getText()).toBe("Replacement ");
});

test("blur, disable, and disposal invalidate pending work without disabling editing", async () => {
	for (const action of ["blur", "disable", "dispose"] as const) {
		const result = deferred();
		let signal!: AbortSignal;
		const editor = createEditor(async (_snapshot, requestSignal) => {
			signal = requestSignal;
			return result.promise;
		});
		editor.setText("Explain ");
		editor.render(100);
		await debounce();
		if (action === "blur") editor.focused = false;
		else if (action === "disable") editor.setAutocompleteEnabled(false);
		else editor.dispose();
		editor.render(100);
		expect(signal.aborted).toBe(true);
		result.resolve("stale suggestion");
		await settle();
		expect(screen(editor)).not.toContain("stale suggestion");
		editor.handleInput("x");
		expect(editor.getText()).toBe("Explain x");
	}
});

test("reenabling completion permits a fresh result for the unchanged draft", async () => {
	const editor = createEditor(async () => "the actual fix");
	editor.setText("Describe ");
	editor.setAutocompleteEnabled(false);
	editor.render(100);
	await debounce();
	expect(screen(editor)).not.toContain("the actual fix");
	editor.setAutocompleteEnabled(true);
	await debounce();
	expect(screen(editor)).toContain("the actual fix");
});

test("commands, shell drafts, mentions, and paths never start local inference", async () => {
	let calls = 0;
	const editor = createEditor(async () => { calls++; return "unexpected"; });
	for (const draft of ["", "   ", "/model gem", "  !git status", "Read @src", "Ask ^gemma", "Read ./src", "Read src/file", "Read C:\\src", "Use /skill"]) {
		editor.setText(draft);
		editor.render(100);
		await debounce();
	}
	expect(calls).toBe(0);
});

test("full prompt snapshots preserve later lines and whitespace-ending fenced code", async () => {
	const snapshots: CompletionSnapshot[] = [];
	const editor = createEditor(async snapshot => { snapshots.push(snapshot); return "next"; });
	editor.setText("Explain this:\n```ts\nconst result = \n```\nThen summarize.");
	editor.moveToMessageStart();
	editor.handleInput("\x1b[B");
	editor.handleInput("\x1b[B");
	editor.moveToLineEnd();
	editor.render(100);
	await debounce();
	expect(snapshots).toEqual([{
		prefix: "Explain this:\n```ts\nconst result = ",
		suffix: "\n```\nThen summarize.",
	}]);
});

function fileProvider(): AutocompleteProvider {
	return {
		getSuggestions: async () => ({ prefix: "", items: [{ value: "chosen.ts", label: "chosen.ts" }] }),
		getForceFileSuggestions: async () => ({ prefix: "", items: [{ value: "chosen.ts", label: "chosen.ts" }] }),
		applyCompletion: () => ({ lines: ["chosen.ts"], cursorLine: 0, cursorCol: 9 }),
	};
}

test("a native file menu cancels pending ghost work and keeps Tab selection precedence", async () => {
	const result = deferred();
	let signal!: AbortSignal;
	const editor = createEditor(async (_snapshot, requestSignal) => {
		signal = requestSignal;
		return result.promise;
	});
	editor.setAutocompleteProvider(fileProvider());
	editor.setText("Read ");
	editor.render(100);
	await debounce();
	editor.handleInput("\t");
	await settle();
	expect(editor.isShowingAutocomplete()).toBe(true);
	editor.render(100);
	expect(signal.aborted).toBe(true);
	result.resolve("a model suggestion");
	await settle();
	expect(screen(editor)).not.toContain("a model suggestion");
	editor.handleInput("\t");
	expect(editor.getText()).toBe("chosen.ts");
});

test("Escape closes a native menu before interrupting the agent", async () => {
	const editor = createEditor(async () => null);
	editor.setAutocompleteProvider(fileProvider());
	editor.setText("Read ./");
	let interrupts = 0;
	editor.onEscape = () => { interrupts++; };
	editor.handleInput("\t");
	await settle();
	expect(editor.isShowingAutocomplete()).toBe(true);
	editor.handleInput("\x1b");
	expect(editor.isShowingAutocomplete()).toBe(false);
	expect(interrupts).toBe(0);
	editor.handleInput("\x1b");
	expect(interrupts).toBe(1);
});

test("native inline hints take precedence and are not accepted as local phrases", async () => {
	const editor = createEditor(async () => "a local phrase");
	editor.setText("Explain ");
	editor.render(100);
	await debounce();
	editor.setAutocompleteProvider({ ...fileProvider(), getInlineHint: () => "native hint" });
	expect(screen(editor)).toContain("native hint");
	expect(screen(editor)).not.toContain("a local phrase");
	editor.handleInput("\x1b[C");
	expect(editor.getText()).toBe("Explain ");
});

test("wrapping a spelling provider retains native autocorrection while replacing dictionary ghosts", async () => {
	const editor = createEditor(async () => "the fix");
	editor.setTextAssistProvider({
		getWordCompletion: () => "dictionary-only",
		tryAutocorrect: (lines, line, col) => lines[line].slice(0, col) === "teh " ? { replaceLen: 4, insert: "the " } : null,
	});
	editor.setText("teh");
	editor.handleInput(" ");
	await settle();
	expect(editor.getText()).toBe("the ");
	await debounce();
	expect(screen(editor)).toContain("the fix");
	expect(screen(editor)).not.toContain("dictionary-only");
});

test("spelling replacements remain selectable through the native spelling menu", async () => {
	const editor = createEditor(async () => " ghost");
	editor.setTextAssistProvider({
		getWordReplacements: () => ({ line: 0, startCol: 0, endCol: 3, items: ["the"] }),
	});
	editor.setText("teh");
	editor.handleInput("\x1b[46;5u");
	await settle();
	expect(editor.isShowingAutocomplete()).toBe(true);
	editor.handleInput("\t");
	expect(editor.getText()).toBe("the");
});

const CTRL_RIGHT = "\x1b[1;5C";
const CTRL_MINUS = "\x1b[45;5u";

test("Ctrl+Right accepts the ghost one word at a time without refetching", async () => {
	let calls = 0;
	const editor = createEditor(async () => {
		calls++;
		return "led API requests.";
	});
	editor.setText("Please add error handling for fai");
	editor.render(100);
	await debounce();
	editor.handleInput(CTRL_RIGHT);
	expect(editor.getText()).toBe("Please add error handling for failed");
	expect(screen(editor)).toContain(" API requests.");
	editor.handleInput(CTRL_RIGHT);
	expect(editor.getText()).toBe("Please add error handling for failed API");
	editor.handleInput(CTRL_RIGHT);
	expect(editor.getText()).toBe("Please add error handling for failed API requests.");
	expect(calls).toBe(1);
	// Exhausted: the next press is native word-right at the line end and inserts nothing.
	editor.handleInput(CTRL_RIGHT);
	expect(editor.getText()).toBe("Please add error handling for failed API requests.");
});

test("Ctrl+Right steps through Thai suggestions by dictionary word", async () => {
	const editor = createEditor(async () => "แก้บั๊กในไฟล์นี้");
	editor.setText("ช่วย");
	editor.render(100);
	await debounce();
	editor.handleInput(CTRL_RIGHT);
	const accepted = editor.getText().slice("ช่วย".length);
	expect(accepted.length).toBeGreaterThan(0);
	expect("แก้บั๊กในไฟล์นี้".startsWith(accepted)).toBe(true);
	expect(accepted).not.toBe("แก้บั๊กในไฟล์นี้");
});

test("Ctrl+Right without a ghost keeps native word movement", async () => {
	const editor = createEditor(async () => null);
	editor.setText("Explain this change");
	editor.moveToMessageStart();
	editor.handleInput(CTRL_RIGHT);
	expect(editor.getText()).toBe("Explain this change");
	expect(editor.getCursor().col).toBeGreaterThan(0);
});

function refineRecorder() {
	const states: RefineState["kind"][] = [];
	return { states, onRefineStateChange: (state: RefineState) => states.push(state.kind) };
}

test("Escape after a rewrite restores the original without interrupting the agent", () => {
	const recorder = refineRecorder();
	const editor = createEditor(async () => null, recorder);
	let interrupts = 0;
	editor.onEscape = () => { interrupts++; };
	// Isolate from ghost dismissal, which owns the next Escape while a ghost request is pending.
	editor.setAutocompleteEnabled(false);
	editor.setText("pls fix teh bug");
	const job = editor.beginRefine()!;
	expect(job.draft).toBe("pls fix teh bug");
	expect(editor.refineState.kind).toBe("refining");
	expect(job.apply("Please fix the bug.")).toBe(true);
	expect(editor.getText()).toBe("Please fix the bug.");
	expect(editor.refineState).toEqual({ kind: "refined", original: "pls fix teh bug", refined: "Please fix the bug." });
	editor.handleInput("\x1b");
	expect(editor.getText()).toBe("pls fix teh bug");
	expect(interrupts).toBe(0);
	expect(recorder.states).toEqual(["refining", "refined", "idle"]);
	editor.handleInput("\x1b");
	expect(interrupts).toBe(1);
});

test("the undo key also restores the original where the terminal delivers it", () => {
	const editor = createEditor(async () => null);
	editor.setText("pls fix teh bug");
	editor.beginRefine()!.apply("Please fix the bug.");
	editor.handleInput(CTRL_MINUS);
	expect(editor.getText()).toBe("pls fix teh bug");
});

test("no ghost is offered on an unedited rewrite, so Escape cannot be spent dismissing one", async () => {
	let calls = 0;
	const editor = createEditor(async () => { calls++; return " ghost"; });
	editor.setText("pls fix teh bug");
	editor.beginRefine()!.apply("Please fix the bug");
	editor.render(100);
	await debounce();
	expect(calls).toBe(0);
	editor.handleInput("\x1b");
	expect(editor.getText()).toBe("pls fix teh bug");
});

test("editing a rewrite retires the revert so Escape and undo are native again", () => {
	const recorder = refineRecorder();
	const editor = createEditor(async () => null, recorder);
	let interrupts = 0;
	editor.onEscape = () => { interrupts++; };
	editor.setAutocompleteEnabled(false);
	editor.setText("draft");
	editor.beginRefine()!.apply("Rewritten draft");
	editor.handleInput("!");
	expect(editor.refineState.kind).toBe("idle");
	editor.handleInput(CTRL_MINUS);
	expect(editor.getText()).toBe("Rewritten draft");
	editor.handleInput("\x1b");
	expect(editor.getText()).toBe("Rewritten draft");
	expect(interrupts).toBe(1);
});

test("Escape cancels an in-flight rewrite without interrupting the agent", () => {
	const editor = createEditor(async () => null);
	let interrupts = 0;
	editor.onEscape = () => { interrupts++; };
	// Isolate refine from ghost dismissal, which owns the next Escape while a ghost is pending.
	editor.setAutocompleteEnabled(false);
	editor.setText("Explain the cache");
	const job = editor.beginRefine()!;
	editor.handleInput("\x1b");
	expect(job.signal.aborted).toBe(true);
	expect(interrupts).toBe(0);
	expect(job.apply("Rewritten")).toBe(false);
	expect(editor.getText()).toBe("Explain the cache");
	editor.handleInput("\x1b");
	expect(interrupts).toBe(1);
});

test("typing during a rewrite cancels it and a late result never clobbers the draft", () => {
	const editor = createEditor(async () => null);
	editor.setText("Explain the cache");
	const job = editor.beginRefine()!;
	editor.handleInput("s");
	expect(job.signal.aborted).toBe(true);
	expect(job.apply("Rewritten")).toBe(false);
	expect(editor.getText()).toBe("Explain the caches");
	expect(editor.refineState.kind).toBe("idle");
});

test("Enter during a rewrite sends the draft as-is and cancels the rewrite", () => {
	const editor = createEditor(async () => null);
	const sent: string[] = [];
	editor.onSubmit = text => { sent.push(text); editor.setText(""); };
	editor.setText("Ship it");
	const job = editor.beginRefine()!;
	editor.handleInput("\r");
	expect(sent).toEqual(["Ship it"]);
	expect(job.signal.aborted).toBe(true);
	expect(job.apply("Please ship it.")).toBe(false);
	expect(editor.getText()).toBe("");
});

test("no ghost is requested while a rewrite is in flight", async () => {
	let calls = 0;
	const editor = createEditor(async () => { calls++; return "ghost"; });
	editor.setText("Explain ");
	editor.beginRefine();
	editor.render(100);
	await debounce();
	expect(calls).toBe(0);
	expect(screen(editor)).not.toContain("ghost");
});

test("rewrites record collapsed paste markers as protected placeholders", () => {
	const editor = createEditor(async () => null);
	editor.setText("Summarize ");
	editor.moveToMessageEnd();
	editor.insertPaste(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
	const draft = editor.getText();
	const marker = /\[Paste #\d+[^\]]*\]/.exec(draft)?.[0];
	expect(marker).toBeDefined();
	expect(editor.beginRefine()!.protectedTokens).toEqual([marker!]);
});

test("an empty draft cannot start a rewrite", () => {
	const editor = createEditor(async () => null);
	editor.setText("   ");
	expect(editor.beginRefine()).toBeUndefined();
	expect(editor.refineState.kind).toBe("idle");
});
