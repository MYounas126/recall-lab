import { test } from "node:test";
import { strict as assert } from "node:assert";
import { contentId, validateBank } from "../src/tasks";
import { AnswerIndex } from "../src/history";
import { Store } from "../src/store";
import type { Bank, Course } from "../src/types";
import { question } from "./helpers";

const course: Course = { id: "c", title: "C", folder: "C", axes: [{ id: "a1", label: "A" }] };
const generated = (prompts: string[]): Bank => ({
	id: "c-registers", title: "Registers",
	questions: prompts.map((p, i) => question(`q${i + 1}`, { prompt: p })),
});

test("generated questions get ids from their content, not their position", () => {
	const first = generated(["Which register is RBX?", "What does XOR EAX, EAX do?"]);
	assert.equal(validateBank(first, course), null);
	const rebuilt = generated(["What does XOR EAX, EAX do?", "Where does a function return its value?"]);
	assert.equal(validateBank(rebuilt, course), null);

	// The question both builds share keeps its id, at whatever position; the new
	// one gets an id of its own instead of inheriting the old q2's history.
	assert.equal(rebuilt.questions[0].id, first.questions[1].id);
	assert.ok(!first.questions.some((q) => q.id === rebuilt.questions[1].id));
	assert.ok(rebuilt.questions.every((q) => /^q-[0-9a-f]{8}$/.test(q.id)));
});

test("an explanation edit keeps the id; a changed answer makes a new one", () => {
	const base = question("x", { prompt: "Which register is RBX?", choices: ["R3", "R1"], answer: 0 });
	assert.equal(contentId({ ...base, explain: "rewritten", topic: "other", tier: "hard" }), contentId(base));
	assert.notEqual(contentId({ ...base, choices: ["R3", "R2"] }), contentId(base));
	assert.equal(contentId({ answer: 0, choices: ["R3", "R1"], prompt: "Which register is RBX?", id: "y", tier: "easy", type: "mcq", topic: "t", explain: "" }), contentId(base), "field order does not matter");
});

test("identical questions in one build still get distinct ids", () => {
	const bank = generated(["Same?", "Same?"]);
	assert.equal(validateBank(bank, course), null);
	assert.notEqual(bank.questions[0].id, bank.questions[1].id);
});

test("an easy-only bank still fills the paper it was asked for", () => {
	const bank: Bank = { id: "e", title: "E", questions: ["a", "b", "c", "d", "e"].map((id) => question(id)) };
	assert.equal(Store.pickExam(Store.itemsOf([bank]), new AnswerIndex([]), 4).length, 4);
	assert.equal(Store.pickExam(Store.itemsOf([bank]), new AnswerIndex([]), 9).length, 5, "never more than there is");
});
