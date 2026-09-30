import { type Component, type Focusable, Input, matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

/**
 * The refine instruction picker: a one-line instruction field over a list of presets, shown in
 * place of the prompt editor. Typing writes a custom instruction; with the field empty, Enter
 * takes the highlighted preset. OMP's ask dialog cannot be used here: it deliberately refuses
 * focus while the prompt has a draft, and refining always has one.
 */

export interface PickerOption {
	label: string;
	description?: string;
}

export type PickerResult = { kind: "option"; label: string } | { kind: "custom"; text: string } | undefined;

/** The theme colours the picker uses; OMP's `Theme` satisfies it. */
export interface PickerTheme {
	fg(color: "accent" | "muted" | "dim" | "text", text: string): string;
}

export interface RefinePickerOptions {
	options: readonly PickerOption[];
	initialIndex?: number;
	/** Current draft, shown as a one-line reminder of what will be rewritten. */
	draft: string;
	theme: PickerTheme;
	done: (result: PickerResult) => void;
	requestRender: () => void;
}

export class RefinePicker implements Component, Focusable {
	readonly #input = new Input();
	readonly #options: readonly PickerOption[];
	readonly #draft: string;
	readonly #theme: PickerTheme;
	readonly #done: (result: PickerResult) => void;
	readonly #requestRender: () => void;
	#selected: number;
	#closed = false;

	constructor(options: RefinePickerOptions) {
		this.#options = options.options;
		this.#draft = options.draft;
		this.#theme = options.theme;
		this.#done = options.done;
		this.#requestRender = options.requestRender;
		this.#selected = Math.min(Math.max(0, options.initialIndex ?? 0), Math.max(0, this.#options.length - 1));
		this.#input.prompt = "";
		this.#input.onSubmit = value => {
			const text = value.trim();
			if (text) this.#close({ kind: "custom", text });
			else if (this.#options[this.#selected]) this.#close({ kind: "option", label: this.#options[this.#selected].label });
		};
		this.#input.onEscape = () => this.#close(undefined);
	}

	get focused(): boolean {
		return this.#input.focused;
	}

	set focused(value: boolean) {
		this.#input.focused = value;
	}

	/** Index of the highlighted preset. */
	get selectedIndex(): number {
		return this.#selected;
	}

	/** The typed instruction. */
	get value(): string {
		return this.#input.getValue();
	}

	handleInput(data: string): void {
		if (this.#closed) return;
		const count = this.#options.length;
		if (count > 0 && (matchesKey(data, "up") || matchesKey(data, "down"))) {
			this.#selected = (this.#selected + (matchesKey(data, "up") ? count - 1 : 1)) % count;
		} else if (count > 0 && matchesKey(data, "tab")) {
			// Start a custom instruction from the highlighted preset.
			this.#input.setValue(`${this.#options[this.#selected].label} `);
		} else {
			this.#input.handleInput(data);
		}
		this.#requestRender();
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const theme = this.#theme;
		const inner = Math.max(1, width - 2);
		const fit = (text: string) => truncateToWidth(text, inner);
		const title = " Refine prompt ";
		const rule = "─".repeat(Math.max(0, width - visibleWidth(title) - 1));
		const typed = this.#input.getValue().trim().length > 0;
		const lines = [`${theme.fg("dim", "─")}${theme.fg("accent", title)}${theme.fg("dim", rule)}`];
		const draft = this.#draft.replace(/\s+/g, " ").trim();
		lines.push(` ${theme.fg("muted", fit(`draft: ${draft}`))}`);
		const field = this.#input.render(Math.max(1, inner - 2))[0] ?? "";
		const placeholder = theme.fg("dim", truncateToWidth(" type an instruction, or pick one below", Math.max(0, inner - 4)));
		lines.push(` ${theme.fg("accent", "›")} ${typed ? field : `${field.trimEnd()}${placeholder}`}`);
		this.#options.forEach((option, index) => {
			const active = index === this.#selected;
			const marker = active ? theme.fg(typed ? "dim" : "accent", "❯ ") : "  ";
			const label = active && !typed ? theme.fg("accent", option.label) : theme.fg(typed ? "dim" : "text", option.label);
			const rest = option.description ? ` — ${option.description}` : "";
			const room = Math.max(0, inner - 2 - visibleWidth(option.label));
			lines.push(` ${marker}${label}${theme.fg("dim", truncateToWidth(rest, room))}`);
		});
		const hint = typed
			? "Enter refine with your instruction · Esc cancel"
			: "↑↓ pick · Enter refine · Tab edit preset · Esc cancel";
		lines.push(` ${theme.fg("dim", fit(hint))}`);
		return lines;
	}

	#close(result: PickerResult): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#done(result);
	}
}
