import {
	type AutocompleteProvider,
	type EditorTextAssistProvider,
	type EditorTheme,
	type KeybindingsManager,
	matchesKey,
	type TUI,
} from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import type { CompletionSnapshot } from "./client";
import { type CompletionErrorHandler, CompletionController, type CompletionRequest } from "./controller";
import { nextWordOf } from "./next-word";
import { protectedTokensOf } from "./refine";

/**
 * Where the prompt-refinement feature stands, reported through `onRefineStateChange`:
 * `refining` while a rewrite is in flight for `draft`; `refined` while the editor still shows
 * the unedited rewrite, which Escape (or the undo key) reverts to `original`.
 */
export type RefineState =
	| { kind: "idle" }
	| { kind: "refining"; draft: string }
	| { kind: "refined"; original: string; refined: string };

/** One in-flight rewrite, handed out by {@link PromptAutocompleteEditor.beginRefine}. */
export interface RefineJob {
	/** Draft text at the start, placeholders collapsed exactly as the editor stores them. */
	readonly draft: string;
	/** Placeholders the rewrite must keep verbatim. */
	readonly protectedTokens: readonly string[];
	/** Aborted by Escape, by editing or sending the draft, or by a newer job. */
	readonly signal: AbortSignal;
	/**
	 * Replace the draft with `text`. Returns false (and changes nothing) when the job was
	 * cancelled or the draft changed meanwhile, so a late rewrite never clobbers newer input.
	 */
	apply(text: string): boolean;
	/** End the job without applying anything (failure path). */
	finish(): void;
}

export interface PromptAutocompleteEditorOptions {
	complete: CompletionRequest;
	onError?: CompletionErrorHandler;
	onRefineStateChange?: (state: RefineState) => void;
}

interface ActiveRefine {
	readonly draft: string;
	readonly controller: AbortController;
}

/** Keep the native composer, spelling, menus, and ghost acceptance machinery. */
export class PromptAutocompleteEditor extends CustomEditor {
	#controller: CompletionController;
	#keybindings: KeybindingsManager;
	#onRefineStateChange: ((state: RefineState) => void) | undefined;
	#enabled = true;
	#disposed = false;
	#autocompleteProvider?: AutocompleteProvider;
	#refining: ActiveRefine | null = null;
	#refined: { original: string; refined: string } | null = null;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options: PromptAutocompleteEditorOptions) {
		super(tui, theme, keybindings);
		this.#keybindings = keybindings;
		this.#onRefineStateChange = options.onRefineStateChange;
		this.#controller = new CompletionController({
			complete: options.complete,
			onError: options.onError,
			onUpdate: () => {
				// Focus or menu state can change while inference is in flight.
				this.#sync();
				this.invalidate();
				tui.requestRender();
			},
		});
	}

	override setTextAssistProvider(provider: EditorTextAssistProvider | undefined): void {
		// CustomEditor's constructor calls this override before subclass fields exist.
		// Only the deferred callbacks touch subclass state. Preserve spelling's receiver.
		super.setTextAssistProvider({
			tryAutocorrect: provider?.tryAutocorrect?.bind(provider),
			getWordReplacements: provider?.getWordReplacements?.bind(provider),
			getWordCompletion: () => {
				const snapshot = this.#sync();
				return snapshot ? this.#controller.getSuggestion(snapshot) : null;
			},
			wordCompletionFeedback: () => {
				const snapshot = this.#snapshot();
				if (snapshot) this.#controller.dismiss(snapshot);
			},
		});
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.#autocompleteProvider = provider;
		super.setAutocompleteProvider(provider);
	}

	setAutocompleteEnabled(enabled: boolean): void {
		if (this.#disposed) return;
		this.#enabled = enabled;
		this.#controller.setEnabled(enabled);
		this.#sync();
		this.invalidate();
		this.tui?.requestRender();
	}

	get refineState(): RefineState {
		if (this.#refining) return { kind: "refining", draft: this.#refining.draft };
		if (this.#refined) return { kind: "refined", ...this.#refined };
		return { kind: "idle" };
	}

	/**
	 * Start rewriting the current draft, cancelling any earlier job. Returns `undefined` for an
	 * empty draft. The draft stays editable: typing, sending or Escape cancels the job.
	 */
	beginRefine(): RefineJob | undefined {
		if (this.#disposed) return undefined;
		const draft = this.getText();
		if (!draft.trim()) return undefined;
		this.#refining?.controller.abort();
		const active: ActiveRefine = { draft, controller: new AbortController() };
		this.#refining = active;
		this.#refined = null;
		this.#emitRefineState();
		const end = (): boolean => {
			if (this.#refining !== active) return false;
			this.#refining = null;
			return true;
		};
		return {
			draft,
			protectedTokens: protectedTokensOf(draft, this.atomicTokenPattern, this.atoms.keys()),
			signal: active.controller.signal,
			apply: text => {
				if (!end()) return false;
				if (this.#disposed || this.getText() !== draft) {
					this.#emitRefineState();
					return false;
				}
				// setText empties the native undo stack; the refined state carries its own revert.
				this.setText(text);
				this.#refined = { original: draft, refined: this.getText() };
				this.#emitRefineState();
				this.invalidate();
				this.tui?.requestRender();
				return true;
			},
			finish: () => {
				if (end()) this.#emitRefineState();
			},
		};
	}

	/** Abort an in-flight rewrite. Returns true when there was one. */
	cancelRefine(): boolean {
		const active = this.#refining;
		if (!active) return false;
		this.#refining = null;
		active.controller.abort();
		this.#emitRefineState();
		return true;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.cancelRefine();
		this.#disposed = true;
		this.#refined = null;
		this.#controller.dispose();
		this.invalidate();
		this.tui?.requestRender();
	}

	override render(width: number): readonly string[] {
		this.#trackRefineDraft();
		this.#sync();
		return super.render(width);
	}

	override handleInput(data: string): void {
		// Refine owns Escape before the ghost, menus and the agent interrupt: it cancels an
		// in-flight rewrite, or reverts an unedited one. The next Escape keeps its native meaning.
		if (this.#refining && matchesKey(data, "escape")) {
			this.cancelRefine();
			return;
		}
		// Escape is the portable revert key; Windows Terminal swallows Ctrl+- (the undo default) for zoom.
		if (
			this.#refined &&
			this.getText() === this.#refined.refined &&
			(matchesKey(data, "escape") || this.#keybindings.matches(data, "tui.editor.undo"))
		) {
			const { original } = this.#refined;
			this.#refined = null;
			this.setText(original);
			this.#emitRefineState();
			this.#sync();
			this.invalidate();
			this.tui?.requestRender();
			return;
		}
		const snapshot = this.#sync();
		// A menu owns Escape before the ghost; the next Escape still reaches the
		// original CustomEditor interrupt/Vim handling after this snapshot is dismissed.
		if (snapshot && matchesKey(data, "escape") && this.#controller.dismiss(snapshot)) {
			this.invalidate();
			this.tui?.requestRender();
			return;
		}
		// Word-right at a shown ghost takes one word of it (Ctrl+→ / Alt+→ / Alt+F by default).
		// Without a ghost the cursor is at a line end, where native word-right keeps its meaning.
		if (snapshot && this.#keybindings.matches(data, "tui.editor.cursorWordRight")) {
			const ghost = this.#controller.getSuggestion(snapshot);
			if (ghost) {
				this.insertText(nextWordOf(ghost));
				this.#sync();
				return;
			}
		}
		try {
			// Native Tab inserts its provisional space; native right-arrow inserts exactly.
			super.handleInput(data);
		} finally {
			this.#trackRefineDraft();
			this.#sync();
		}
	}

	/** Editing or sending the draft cancels a pending rewrite and retires the undo offer. */
	#trackRefineDraft(): void {
		if (this.#refining && this.getText() !== this.#refining.draft) {
			this.cancelRefine();
		}
		if (this.#refined && this.getText() !== this.#refined.refined) {
			this.#refined = null;
			this.#emitRefineState();
		}
	}

	#emitRefineState(): void {
		this.#onRefineStateChange?.(this.refineState);
	}

	#sync(): CompletionSnapshot | null {
		const snapshot = this.#snapshot();
		this.#controller.update(snapshot);
		return snapshot;
	}

	#snapshot(): CompletionSnapshot | null {
		if (
			this.#disposed ||
			!this.#enabled ||
			// No ghost on a rewrite in flight or still unedited, so Escape always means revert there.
			this.#refining ||
			this.#refined ||
			!this.focused ||
			this.isShowingAutocomplete() ||
			this.vimMode !== "insert"
		) {
			return null;
		}
		const lines = this.getLines();
		const { line, col } = this.getCursor();
		if (col !== lines[line].length) return null;
		if (this.#autocompleteProvider?.getInlineHint?.(lines, line, col)) return null;

		const text = lines.join("\n");
		if (!text.trim() || /^[\/!]/.test(text.trimStart())) return null;
		let offset = col;
		for (let i = 0; i < line; i++) offset += lines[i].length + 1;
		const prefix = text.slice(0, offset);
		if (!prefix.trim()) return null;

		// Avoid racing file/model mentions and path/skill completion while their
		// native menu is still loading. Code fences retain ordinary code suffixes.
		const token = /(?:^|\s)(\S+)$/.exec(prefix)?.[1] ?? "";
		if (/^[@^]/.test(token)) return null;
		let fence: string | undefined;
		for (let i = 0; i <= line; i++) {
			const marker = /^\s*(`{3,}|~{3,})/.exec(lines[i])?.[1];
			if (!marker) continue;
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
		}
		if (!fence && /[\\/]/.test(token)) return null;
		return { prefix, suffix: text.slice(offset) };
	}
}
