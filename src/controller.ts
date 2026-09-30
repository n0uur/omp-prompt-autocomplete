/**
 * Debounced, cancellation-safe controller for model ghost-text suggestions.
 *
 * State model: the controller keeps at most one *basis* — the snapshot a completion was
 * generated for plus the completion text itself. Everything else is derived from it, so
 * there is no cache of stale suggestions and nothing can be shown for text that no longer
 * matches.
 *
 * Guarantees:
 *  - `update()` is idempotent for an equal snapshot (and for repeated `null`), so calling it
 *    from a render pass never refetches and never recurses through `onUpdate()`;
 *  - a changed snapshot aborts the pending request/response epoch immediately, and a response
 *    for an old snapshot is dropped even if the backend ignored the abort;
 *  - typing through a shown suggestion projects the remaining text (including re-showing it
 *    after a backspace) without refetching, until the suggestion is exhausted; exhaustion
 *    starts a fresh request but keeps the projection available while the input shrinks back;
 *  - divergent typing clears the ghost and refetches;
 *  - dismissal suppresses one exact snapshot (and any pending work for it) until the text
 *    changes; a late response for a dismissed snapshot can never re-show it;
 *  - disabling or disposing cancels all work and hides the ghost;
 *  - a failed request is reported once through `onError` and is not retried until new input.
 */
import type { CompletionSnapshot } from "./client";

export interface CompletionControllerOptions {
	/** Performs one completion request. Must honour `signal`. */
	complete: CompletionRequest;
	/** Called whenever the visible suggestion or pending state changed. */
	onUpdate: () => void;
	/** Called once per failed request (never for aborts caused by the controller itself). */
	onError?: CompletionErrorHandler;
	/** Debounce before a request is sent. Defaults to {@link DEFAULT_DEBOUNCE_MS}. */
	debounceMs?: number;
}

export type CompletionRequest = (snapshot: CompletionSnapshot, signal: AbortSignal) => Promise<string | null>;
export type CompletionErrorHandler = (error: unknown) => void;

export const DEFAULT_DEBOUNCE_MS = 180;
/** Maximum number of suggestion characters returned by {@link CompletionController.getSuggestion}. */
export const MAX_SHOWN_CHARS = 160;
/** Bounded memory of dismissed snapshots, so Escape twice cannot resurrect old text. */
const MAX_DISMISSED_KEYS = 16;

interface SuggestionBasis {
	readonly prefix: string;
	readonly suffix: string;
	readonly text: string;
}

interface InFlightRequest {
	readonly epoch: number;
	readonly key: string;
	readonly controller: AbortController;
}

function snapshotKey(snapshot: CompletionSnapshot): string {
	return `${snapshot.prefix.length}:${snapshot.suffix.length}:${snapshot.prefix}\u0000${snapshot.suffix}`;
}

/** Cap the shown text without splitting a surrogate pair. */
function capShown(text: string): string {
	if (text.length <= MAX_SHOWN_CHARS) {
		return text;
	}
	let end = MAX_SHOWN_CHARS;
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) {
		end -= 1;
	}
	return text.slice(0, end);
}

/** Defensive single-line guard: the client already normalises, this protects the renderer. */
function singleLine(text: string): string {
	const breakAt = text.search(/[\r\n\u2028\u2029]/);
	return breakAt === -1 ? text : text.slice(0, breakAt);
}

export class CompletionController {
	private readonly complete: CompletionRequest;
	private readonly onUpdate: () => void;
	private readonly onError: CompletionErrorHandler | undefined;
	private readonly debounceMs: number;

	private enabled = true;
	private disposed = false;
	private epoch = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private inFlight: InFlightRequest | null = null;
	private basis: SuggestionBasis | null = null;
	/** Key of the last snapshot passed to `update()`; `null` means "no snapshot". */
	private inputKey: string | null = null;
	private readonly dismissed: string[] = [];

	constructor(options: CompletionControllerOptions) {
		this.complete = options.complete;
		this.onUpdate = options.onUpdate;
		this.onError = options.onError;
		this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	}

	/** True while a request is debouncing or in flight. */
	get pending(): boolean {
		return this.timer !== null || this.inFlight !== null;
	}

	/**
	 * Report the current prompt context before rendering. `null` means "no context": pending
	 * work is cancelled and the ghost is hidden. Repeating the same argument is a no-op.
	 */
	update(snapshot: CompletionSnapshot | null): void {
		if (this.disposed) {
			return;
		}
		if (snapshot === null) {
			if (this.inputKey === null) {
				return; // repeated null: nothing was pending or shown
			}
			this.inputKey = null;
			this.cancelWork();
			this.basis = null;
			this.onUpdate();
			return;
		}
		const key = snapshotKey(snapshot);
		if (key === this.inputKey) {
			return; // same snapshot: no refetch, no debounce reset, no onUpdate
		}
		this.inputKey = key;
		this.cancelWork();
		if (!this.enabled || this.dismissed.includes(key)) {
			this.basis = null;
			this.onUpdate();
			return;
		}
		const projected = this.project(snapshot);
		if (projected !== null && projected.length > 0) {
			// Typing through the current suggestion: the basis still applies, so no request.
			this.onUpdate();
			return;
		}
		if (projected === null) {
			// Divergent typing (or a moved cursor): the old suggestion no longer applies.
			this.basis = null;
		}
		// Exhausted suggestions keep their basis, so deleting back re-shows the same ghost.
		this.scheduleFetch(snapshot, key);
		this.onUpdate();
	}

	/** The suggestion to render for `snapshot`, or `null`. Pure: never triggers a request. */
	getSuggestion(snapshot: CompletionSnapshot): string | null {
		if (this.disposed || !this.enabled) {
			return null;
		}
		if (this.dismissed.includes(snapshotKey(snapshot))) {
			return null;
		}
		const projected = this.project(snapshot);
		return projected !== null && projected.length > 0 ? capShown(projected) : null;
	}

	/**
	 * Suppress the suggestion for this exact snapshot (and cancel any pending work for it).
	 * Returns true when there was something to suppress, so the caller can consume the key.
	 */
	dismiss(snapshot: CompletionSnapshot): boolean {
		if (this.disposed || !this.enabled) {
			return false;
		}
		const key = snapshotKey(snapshot);
		const visible = this.project(snapshot) !== null;
		const pendingHere = this.pending && this.inputKey === key;
		if (!visible && !pendingHere) {
			return false;
		}
		this.rememberDismissed(key);
		if (this.inputKey === key) {
			this.cancelWork();
			this.basis = null;
			this.onUpdate();
		}
		return true;
	}

	/** Enable or disable suggestions. Disabling cancels work; re-enabling refetches on input. */
	setEnabled(enabled: boolean): void {
		if (this.disposed || this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
		if (enabled) {
			this.inputKey = null; // the next update() may fetch for the current snapshot
		} else {
			this.cancelWork();
			this.basis = null;
		}
		this.onUpdate();
	}

	/** Cancel all work and hide the ghost. The controller is inert afterwards. */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.cancelWork();
		this.basis = null;
		this.inputKey = null;
		this.dismissed.length = 0;
	}

	/**
	 * Remaining suggestion text for `snapshot`, or `null` when it does not continue the basis
	 * (different suffix, or typing that diverged from the suggestion).
	 */
	private project(snapshot: CompletionSnapshot): string | null {
		const basis = this.basis;
		if (basis === null || basis.text.length === 0) {
			return null;
		}
		if (snapshot.suffix !== basis.suffix || !snapshot.prefix.startsWith(basis.prefix)) {
			return null;
		}
		const typed = snapshot.prefix.slice(basis.prefix.length);
		if (typed.length > basis.text.length || !basis.text.startsWith(typed)) {
			return null;
		}
		return basis.text.slice(typed.length);
	}

	/** Drop timer and in-flight request, and invalidate any response still on the wire. */
	private cancelWork(): void {
		this.epoch += 1;
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const inFlight = this.inFlight;
		if (inFlight !== null) {
			this.inFlight = null;
			inFlight.controller.abort();
		}
	}

	private scheduleFetch(snapshot: CompletionSnapshot, key: string): void {
		const request = { prefix: snapshot.prefix, suffix: snapshot.suffix };
		const timer = setTimeout(() => {
			this.timer = null;
			void this.runFetch(request, key);
		}, this.debounceMs);
		// Bun timers expose unref(); DOM typings declare a number.
		const unref = (timer as unknown as { unref?: () => void }).unref;
		if (typeof unref === "function") {
			unref.call(timer);
		}
		this.timer = timer;
	}

	private async runFetch(snapshot: CompletionSnapshot, key: string): Promise<void> {
		if (this.disposed || !this.enabled) {
			return;
		}
		const epoch = this.epoch;
		const controller = new AbortController();
		this.inFlight = { epoch, key, controller };
		let result: string | null;
		try {
			result = await this.complete(snapshot, controller.signal);
		} catch (error) {
			if (this.inFlight !== null && this.inFlight.controller === controller) {
				this.inFlight = null;
			}
			if (this.disposed || epoch !== this.epoch) {
				return; // superseded or cancelled: not an error the user needs to see
			}
			this.basis = null;
			this.onError?.(error);
			this.onUpdate();
			return;
		}
		if (this.inFlight !== null && this.inFlight.controller === controller) {
			this.inFlight = null;
		}
		if (this.disposed || epoch !== this.epoch || key !== this.inputKey || !this.enabled) {
			return; // stale response: never overwrite newer text
		}
		if (this.dismissed.includes(key)) {
			this.onUpdate(); // in-flight request was dismissed; nothing to show
			return;
		}
		const text = typeof result === "string" ? singleLine(result) : "";
		if (text.trim().length === 0) {
			this.basis = null;
			this.onUpdate();
			return;
		}
		this.basis = { prefix: snapshot.prefix, suffix: snapshot.suffix, text };
		this.onUpdate();
	}

	private rememberDismissed(key: string): void {
		if (this.dismissed.includes(key)) {
			return;
		}
		if (this.dismissed.length >= MAX_DISMISSED_KEYS) {
			this.dismissed.shift();
		}
		this.dismissed.push(key);
	}
}
