import { test } from "node:test";
import { strict as assert } from "node:assert";
import { KeyPress, keyAction } from "../src/keys";

const press = (key: string, extra: Partial<KeyPress> = {}): KeyPress => ({
	key, mod: false, alt: false, typing: false, onButton: false, answered: false, ...extra,
});

test("number keys pick options by their place on screen", () => {
	assert.deepEqual(keyAction(press("1")), { do: "choose", slot: 0 });
	assert.deepEqual(keyAction(press("9")), { do: "choose", slot: 8 });
	assert.equal(keyAction(press("0")), null);
});

test("Enter submits, G and S submit as Guessing and Sure, D gives up", () => {
	assert.deepEqual(keyAction(press("Enter")), { do: "submit", confidence: "unsure" });
	assert.deepEqual(keyAction(press("g")), { do: "submit", confidence: "guess" });
	assert.deepEqual(keyAction(press("S")), { do: "submit", confidence: "sure" });
	assert.deepEqual(keyAction(press("d")), { do: "skip" });
});

test("a focused button keeps its own Enter", () => {
	assert.equal(keyAction(press("Enter", { onButton: true })), null);
	assert.deepEqual(keyAction(press("g", { onButton: true })), { do: "submit", confidence: "guess" });
});

test("in a text box, keys type — except Escape and Cmd/Ctrl+Enter", () => {
	for (const k of ["g", "s", "d", "1", "Enter", " "]) assert.equal(keyAction(press(k, { typing: true })), null, k);
	assert.deepEqual(keyAction(press("Escape", { typing: true })), { do: "leave-text" });
	assert.deepEqual(keyAction(press("Enter", { typing: true, mod: true })), { do: "submit", confidence: "unsure" });
});

test("once answered, Enter or Space moves on and nothing else fires", () => {
	assert.deepEqual(keyAction(press("Enter", { answered: true })), { do: "next" });
	assert.deepEqual(keyAction(press(" ", { answered: true })), { do: "next" });
	assert.equal(keyAction(press("1", { answered: true })), null);
	assert.equal(keyAction(press("g", { answered: true })), null);
});

test("modified keys are left to Obsidian", () => {
	assert.equal(keyAction(press("s", { mod: true })), null, "Cmd+S stays Obsidian's");
	assert.equal(keyAction(press("1", { alt: true })), null);
});
