import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER } from "@oh-my-pi/pi-tui";
import { type PickerResult, RefinePicker } from "../src/picker";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const OPTIONS = [{ label: "Polish", description: "fix wording" }, { label: "Make it concise" }, { label: "Translate to English" }];

function picker(initialIndex = 0) {
	const results: PickerResult[] = [];
	const component = new RefinePicker({
		options: OPTIONS,
		initialIndex,
		draft: "pls fix\nteh bug",
		theme: { fg: (_color, text) => text },
		done: result => results.push(result),
		requestRender: () => {},
	});
	component.focused = true;
	const screen = () => stripVTControlCharacters(component.render(80).join("\n").replaceAll(CURSOR_MARKER, ""));
	return { component, results, screen };
}

test("Enter on an empty field takes the highlighted preset, arrows wrap", () => {
	const { component, results } = picker(1);
	component.handleInput(DOWN);
	component.handleInput(DOWN);
	expect(component.selectedIndex).toBe(0);
	component.handleInput(UP);
	expect(component.selectedIndex).toBe(2);
	component.handleInput("\r");
	expect(results).toEqual([{ kind: "option", label: "Translate to English" }]);
});

test("typed text wins over the highlighted preset and closes only once", () => {
	const { component, results } = picker();
	for (const ch of "  keep it in Thai ") component.handleInput(ch);
	component.handleInput("\r");
	component.handleInput("\r");
	expect(results).toEqual([{ kind: "custom", text: "keep it in Thai" }]);
});

test("Tab seeds the field with the highlighted preset for editing", () => {
	const { component, results } = picker();
	component.handleInput(DOWN);
	component.handleInput("\t");
	for (const ch of "and polite") component.handleInput(ch);
	component.handleInput("\r");
	expect(results).toEqual([{ kind: "custom", text: "Make it concise and polite" }]);
});

test("Escape cancels", () => {
	const { component, results } = picker();
	component.handleInput("\x1b");
	expect(results).toEqual([undefined]);
});

test("renders the draft on one line, every preset, and a hint for the current mode", () => {
	const { component, screen } = picker();
	expect(screen()).toContain("draft: pls fix teh bug");
	for (const option of OPTIONS) expect(screen()).toContain(option.label);
	expect(screen()).toContain("Enter refine · Tab edit preset");
	component.handleInput("x");
	expect(screen()).toContain("Enter refine with your instruction");
	for (const line of component.render(40)) expect(stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, "")).length).toBeLessThanOrEqual(40);
});
