import { test } from "node:test";
import { strict as assert } from "node:assert";
import { optionsHidden, recallApplies } from "../src/recall";

test("recall-first applies only to questions with options", () => {
	assert.ok(recallApplies(true, "mcq"));
	assert.ok(recallApplies(true, "multi"));
	for (const type of ["short", "command", "image"] as const) assert.ok(!recallApplies(true, type), type);
	assert.ok(!recallApplies(false, "mcq"), "off means off");
});

test("options stay hidden until shown for this very question", () => {
	assert.ok(optionsHidden(true, "mcq", null, 0));
	assert.ok(!optionsHidden(true, "mcq", { index: 0, text: "rax", shown: true }, 0));
	assert.ok(optionsHidden(true, "mcq", { index: 0, text: "rax", shown: true }, 1), "showing question 1's options does not show question 2's");
	assert.ok(optionsHidden(true, "mcq", { index: 3, text: "", shown: false }, 3));
	assert.ok(!optionsHidden(false, "mcq", null, 0));
	assert.ok(!optionsHidden(true, "short", null, 0));
});
