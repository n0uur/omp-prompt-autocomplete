import { afterEach, expect, test, vi } from "bun:test";
import type { CompletionSnapshot } from "../src/client";
import { CompletionController } from "../src/controller";

interface PendingCall {
	readonly snapshot: CompletionSnapshot;
	readonly signal: AbortSignal;
	resolve(value: string | null): void;
	reject(error: unknown): void;
}

function createCompleter(): {
	calls: PendingCall[];
	complete: (snapshot: CompletionSnapshot, signal: AbortSignal) => Promise<string | null>;
} {
	const calls: PendingCall[] = [];
	const complete = (snapshot: CompletionSnapshot, signal: AbortSignal): Promise<string | null> => {
		const { promise, resolve, reject } = Promise.withResolvers<string | null>();
		calls.push({ snapshot: { ...snapshot }, signal, resolve, reject });
		return promise;
	};
	return { calls, complete };
}

const at = (prefix: string, suffix = ""): CompletionSnapshot => ({ prefix, suffix });

/** Run the debounce timer and let the awaiting request start. */
async function fireDebounce(ms = 1): Promise<void> {
	vi.advanceTimersByTime(ms);
	await Promise.resolve();
}

/** Let a manually resolved request settle. */
async function settle(): Promise<void> {
	await Promise.resolve();
}

afterEach(() => {
	vi.useRealTimers();
});

test("coalesces rapid input into one debounced request for the latest snapshot", async () => {
	vi.useFakeTimers();
	const fake = createCompleter();
	const controller = new CompletionController({ complete: fake.complete, onUpdate: () => {}, debounceMs: 180 });

	controller.update(at("a"));
	controller.update(at("ab"));
	controller.update(at("abc"));
	expect(controller.pending).toBe(true);

	await fireDebounce(179);
	expect(fake.calls.length).toBe(0);

	await fireDebounce(1);
	expect(fake.calls.length).toBe(1);
	expect(fake.calls[0].snapshot.prefix).toBe("abc");
	expect(fake.calls[0].signal.aborted).toBe(false);
	expect(controller.pending).toBe(true);

	fake.calls[0].resolve("d");
	await settle();
	expect(controller.pending).toBe(false);
});

test("repeated identical snapshots and rendered suggestions neither refetch nor recurse", async () => {
	vi.useFakeTimers();
	const fake = createCompleter();
	const current = at("hello");
	let updates = 0;
	let controller: CompletionController | undefined;
	controller = new CompletionController({
		complete: fake.complete,
		onUpdate: () => {
			updates += 1;
			controller?.update(current);
		},
		debounceMs: 0,
	});

	controller.update(current);
	controller.update(current);
	expect(controller.getSuggestion(current)).toBeNull();
	expect(updates).toBe(1);

	await fireDebounce();
	expect(fake.calls.length).toBe(1);
	fake.calls[0].resolve(" world");
	await settle();
	expect(controller.getSuggestion(current)).toBe(" world");

	const afterResponse = updates;
	controller.update(current);
	await fireDebounce(1000);
	expect(fake.calls.length).toBe(1);
	expect(controller.getSuggestion(current)).toBe(" world");
	expect(updates).toBe(afterResponse); // an equal snapshot is a pure render no-op
});

test("aborts the in-flight request as soon as the snapshot changes", async () => {
	vi.useFakeTimers();
	const fake = createCompleter();
	const controller = new CompletionController({ complete: fake.complete, onUpdate: () => {}, debounceMs: 0 });

	controller.update(at("abc"));
	await fireDebounce();
	expect(fake.calls.length).toBe(1);

	controller.update(at("abcd"));
	expect(fake.calls[0].signal.aborted).toBe(true);
	await fireDebounce();
	expect(fake.calls.length).toBe(2);
	expect(fake.calls[1].snapshot.prefix).toBe("abcd");
});

test("drops a late response for a superseded snapshot even if the backend ignores the abort", async () => {
	vi.useFakeTimers();
	const fake = createCompleter();
	const controller = new CompletionController({ complete: fake.complete, onUpdate: () => {}, debounceMs: 0 });

	controller.update(at("abc"));
	await fireDebounce();
	controller.update(at("abcd"));
	await fireDebounce();
	expect(fake.calls.length).toBe(2);

	fake.calls[1].resolve("d-answer");
	await settle();
	expect(controller.getSuggestion(at("abcd"))).toBe("d-answer");

	// The backend ignored the abort and answered the older request afterwards.
	fake.calls[0].resolve("stale-answer");
	await settle();
	expect(controller.getSuggestion(at("abcd"))).toBe("d-answer");
	expect(controller.getSuggestion(at("abc"))).toBeNull();
});

test("projects the remaining text while typing through a suggestion, then refetches once exhausted", async () => {
	vi.useFakeTimers();
	const fake = createCompleter();
	const controller = new CompletionController({ complete: fake.complete, onUpdate: () => {}, debounceMs: 0 });

	controller.update(at("he"));
	await fireDebounce();
	fake.calls[0].resolve("llo wor");
	await settle();
	expect(controller.getSuggestion(at("he"))).toBe("llo wor");

	controller.update(at("hel"));
	await fireDebounce(1000);
	expect(fake.calls.length).toBe(1);
	expect(controller.getSuggestion(at("hel"))).toBe("lo wor");

	controller.update(at("hello wo"));
	await fireDebounce(1000);
	expect(fake.calls.length).toBe(1);
	expect(controller.getSuggestion(at("hello wo"))).toBe("r");

	controller.update(at("hello wor"));
	expect(controller.getSuggestion(at("hello wor"))).toBeNull();
	await fireDebounce();
	expect(fake.calls.length).toBe(2);
	expect(fake.calls[1].snapshot.prefix).toBe("hello wor");

	// Deleting back into the suggestion re-shows it without a new request.
	controller.update(at("hel"));
	expect(controller.getSuggestion(at("hel"))).toBe("lo wor");
	await fireDebounce(1000);
	expect(fake.calls.length).toBe(2);
});

test("clears the ghost and refetches when typing diverges from the suggestion", async () => {
	vi.useFakeTimers();
	const fake = createCompleter();
	const controller = new CompletionController({ complete: fake.complete, onUpdate: () => {}, debounceMs: 0 });

	controller.update(at("he"));
	await fireDebounce();
	fake.calls[0].resolve("llo wor");
	await settle();

	controller.update(at("hex"));
	expect(controller.getSuggestion(at("hex"))).toBeNull();
	await fireDebounce();
	expect(fake.calls.length).toBe(2);

	// A suffix change also invalidates the basis.
	controller.update(at("hex", "!"));
	expect(controller.getSuggestion(at("hex", "!"))).toBeNull();
	expect(fake.calls[1].signal.aborted).toBe(true);
});

test("dismissal suppresses one exact snapshot and survives a late response", async () => {
	vi.useFakeTimers();
	const fake = createCompleter();
	const controller = new CompletionController({ complete: fake.complete, onUpdate: () => {}, debounceMs: 0 });
	const target = at("git com");

	controller.update(target);
	expect(controller.dismiss(target)).toBe(true); // pending debounce counts as visible work
	expect(controller.getSuggestion(target)).toBeNull();
	expect(controller.pending).toBe(false);

	await fireDebounce(1000);
	expect(fake.calls.length).toBe(0); // dismissal cancelled the request

	controller.update(at("git commi"));
	await fireDebounce();
	expect(fake.calls.length).toBe(1);
	fake.calls[0].resolve("t");
	await settle();
	expect(controller.getSuggestion(at("git commi"))).toBe("t");

	controller.update(target);
	expect(controller.getSuggestion(target)).toBeNull();
	expect(controller.dismiss(target)).toBe(false);
	expect(controller.dismiss(at("unrelated"))).toBe(false);
});

test("a dismissed in-flight request cannot re-show its ghost when the response lands", async () => {
	vi.useFakeTimers();
	const fake = createCompleter();
	const controller = new CompletionController({ complete: fake.complete, onUpdate: () => {}, debounceMs: 0 });
	const target = at("git com");

	controller.update(target);
	await fireDebounce();
	expect(fake.calls.length).toBe(1);
	expect(controller.dismiss(target)).toBe(true);
	expect(fake.calls[0].signal.aborted).toBe(true);

	fake.calls[0].resolve("mit"); // backend answers anyway
	await settle();
	expect(controller.getSuggestion(target)).toBeNull();
	expect(controller.pending).toBe(false);
});

test("reports a failure once, stops pending work, and retries only on new input", async () => {
	vi.useFakeTimers();
	const fake = createCompleter();
	const errors: unknown[] = [];
	const controller = new CompletionController({
		complete: fake.complete,
		onUpdate: () => {},
		onError: (error) => errors.push(error),
		debounceMs: 0,
	});

	controller.update(at("boom"));
	await fireDebounce();
	fake.calls[0].reject(new Error("server exploded"));
	await settle();

	expect(errors.length).toBe(1);
	expect(controller.getSuggestion(at("boom"))).toBeNull();
	expect(controller.pending).toBe(false);

	controller.update(at("boom"));
	await fireDebounce(1000);
	expect(fake.calls.length).toBe(1);
	expect(errors.length).toBe(1);

	controller.update(at("boom again"));
	await fireDebounce();
	expect(fake.calls.length).toBe(2);
});

test("disabling cancels work and hides the ghost, and re-enabling refetches", async () => {
	vi.useFakeTimers();
	const fake = createCompleter();
	const controller = new CompletionController({ complete: fake.complete, onUpdate: () => {}, debounceMs: 0 });

	controller.update(at("abc"));
	await fireDebounce();
	expect(fake.calls.length).toBe(1);

	controller.setEnabled(false);
	expect(fake.calls[0].signal.aborted).toBe(true);
	expect(controller.getSuggestion(at("abc"))).toBeNull();
	expect(controller.pending).toBe(false);

	controller.update(at("abcd"));
	await fireDebounce(1000);
	expect(fake.calls.length).toBe(1);

	controller.setEnabled(true);
	controller.update(at("abcd"));
	await fireDebounce();
	expect(fake.calls.length).toBe(2);
});

test("dispose cancels everything and leaves the controller inert", async () => {
	vi.useFakeTimers();
	const fake = createCompleter();
	const controller = new CompletionController({ complete: fake.complete, onUpdate: () => {}, debounceMs: 0 });

	controller.update(at("abc"));
	await fireDebounce();
	controller.dispose();

	expect(fake.calls[0].signal.aborted).toBe(true);
	expect(controller.pending).toBe(false);
	expect(controller.getSuggestion(at("abc"))).toBeNull();
	expect(controller.dismiss(at("abc"))).toBe(false);

	fake.calls[0].resolve("text"); // backend ignores the abort
	await settle();
	expect(controller.getSuggestion(at("abc"))).toBeNull();

	controller.update(at("abcd"));
	await fireDebounce(1000);
	expect(fake.calls.length).toBe(1);
	controller.setEnabled(false);
	expect(controller.pending).toBe(false);
});

test("null snapshots cancel work, hide the ghost, and repeat as a no-op", async () => {
	vi.useFakeTimers();
	const fake = createCompleter();
	let updates = 0;
	const controller = new CompletionController({
		complete: fake.complete,
		onUpdate: () => {
			updates += 1;
		},
		debounceMs: 0,
	});

	controller.update(null);
	expect(updates).toBe(0); // nothing was pending or shown yet

	controller.update(at("hi"));
	expect(updates).toBe(1);
	await fireDebounce();
	expect(fake.calls.length).toBe(1);

	controller.update(null);
	expect(updates).toBe(2);
	expect(fake.calls[0].signal.aborted).toBe(true);
	expect(controller.pending).toBe(false);
	expect(controller.getSuggestion(at("hi"))).toBeNull();

	controller.update(null);
	expect(updates).toBe(2);

	fake.calls[0].resolve(" there");
	await settle();
	expect(controller.getSuggestion(at("hi"))).toBeNull();
});

test("caps the shown suggestion without splitting surrogate pairs and keeps projecting past the cap", async () => {
	vi.useFakeTimers();
	const fake = createCompleter();
	const controller = new CompletionController({ complete: fake.complete, onUpdate: () => {}, debounceMs: 0 });

	controller.update(at("x"));
	await fireDebounce();
	fake.calls[0].resolve(`${"a".repeat(159)}\u{1F600}tail`);
	await settle();

	const ghost = controller.getSuggestion(at("x")) as string;
	expect(ghost.length).toBe(159);
	expect(ghost).toBe("a".repeat(159));

	const typed = `x${"a".repeat(159)}`;
	controller.update(at(typed));
	expect(controller.getSuggestion(at(typed))).toBe("\u{1F600}tail");
});
