import { test } from "node:test";
import { strict as assert } from "node:assert";
import { gateOf, gatesOf, isOpen, lockedTiers, opened, whyLocked } from "../src/gates";
import { AnswerIndex } from "../src/history";
import { Store } from "../src/store";
import type { Attempt, Bank } from "../src/types";
import { attempt, question } from "./helpers";

const RULE = { hard: 80, brutal: 80 };

const quiz: Bank = {
	id: "a", title: "A", note: "C/a.md",
	questions: [
		question("e1"), question("e2"), question("e3"), question("e4"),
		question("h1", { tier: "hard" }), question("h2", { tier: "hard" }),
		question("b1", { tier: "brutal" }),
	],
};
const gate = (attempts: Attempt[], bank = quiz, rule = RULE) =>
	gateOf(Store.itemsOf([bank]), new AnswerIndex(attempts), rule);
const right = (...ids: string[]) => ids.map((id) => attempt("a", id, 100));

test("a quiz never answered keeps Hard and Brutal shut", () => {
	const g = gate([]);
	assert.deepEqual(g.open, { easy: true, hard: false, brutal: false });
	assert.deepEqual(g.mastery, { easy: 0, hard: 0, brutal: 0 });
	assert.deepEqual(lockedTiers(g), ["hard", "brutal"]);
});

test("Hard opens once enough of Easy is owned, unanswered questions counting as zero", () => {
	assert.equal(gate(right("e1")).mastery.easy, 25, "acing one question of four owns a quarter of the tier");
	assert.equal(gate(right("e1", "e2", "e3")).open.hard, false, "75% is short of 80%");
	const g = gate(right("e1", "e2", "e3", "e4"));
	assert.equal(g.open.hard, true);
	assert.equal(g.open.brutal, false, "Brutal waits on the Hard tier");
});

test("Brutal needs Hard open as well as enough of Hard owned", () => {
	assert.equal(gate(right("e1", "e2", "e3", "e4", "h1")).open.brutal, false, "half of Hard is not enough");
	assert.equal(gate(right("e1", "e2", "e3", "e4", "h1", "h2")).open.brutal, true);
	assert.equal(gate(right("h1", "h2")).open.brutal, false, "drilling Hard does not skip the Easy gate");
});

test("a question's mastery is the mean of its last three scores, and a failed marking says nothing", () => {
	const history = [
		attempt("a", "e1", 0), attempt("a", "e1", 100), attempt("a", "e1", 100), attempt("a", "e1", 100),
		attempt("a", "e2", 0, undefined, { gradedBy: "error" }),
	];
	assert.equal(gate(history).mastery.easy, 25);
});

test("a tier with no questions never holds the next one shut", () => {
	const noEasy: Bank = { id: "a", title: "A", questions: [question("h1", { tier: "hard" }), question("b1", { tier: "brutal" })] };
	assert.deepEqual(gate([], noEasy).open, { easy: true, hard: true, brutal: false });
	assert.equal(gate([], noEasy).mastery.easy, null);
	const noHard: Bank = { id: "a", title: "A", questions: [question("e1"), question("b1", { tier: "brutal" })] };
	assert.equal(gate([], noHard).open.brutal, false, "Easy still has to be owned first");
	assert.equal(gate(right("e1"), noHard).open.brutal, true);
});

test("thresholds of zero open every tier", () => {
	assert.deepEqual(gate([], quiz, { hard: 0, brutal: 0 }).open, { easy: true, hard: true, brutal: true });
});

test("each quiz has its own gates", () => {
	const other: Bank = { id: "b", title: "B", questions: [question("e1"), question("h1", { tier: "hard" })] };
	const items = Store.itemsOf([quiz, other]);
	const gates = gatesOf(items, new AnswerIndex(right("e1", "e2", "e3", "e4")), RULE);
	const hardIn = (bankId: string) => items.find((it) => it.bankId === bankId && it.q.tier === "hard")!;
	assert.equal(isOpen(hardIn("a"), gates), true);
	assert.equal(isOpen(hardIn("b"), gates), false, "mastering one note opens nothing in another");
	assert.equal(isOpen({ bankId: "elsewhere", q: question("x", { tier: "brutal" }) }, gates), true);
});

test("a gated exam is still a full paper, drawn from the open tiers", () => {
	const index = new AnswerIndex([]);
	const items = Store.itemsOf([quiz]);
	const open = items.filter((it) => isOpen(it, gatesOf(items, index, RULE)));
	const paper = Store.pickExam(open, index, 4);
	assert.equal(paper.length, 4);
	assert.ok(paper.every((it) => it.q.tier === "easy"));
});

test("the reason names what is locked and what opens it", () => {
	assert.equal(
		whyLocked(gate(right("e1")), RULE),
		"Hard and Brutal are locked. Hard opens once you own 80% of this quiz's Easy questions; you own 25%."
	);
	assert.equal(
		whyLocked(gate(right("e1", "e2", "e3", "e4", "h1")), RULE),
		"Brutal is locked. It opens once you own 80% of this quiz's Hard questions; you own 50%."
	);
	assert.equal(whyLocked(gate([], quiz, { hard: 0, brutal: 0 }), RULE), null);
	assert.match(whyLocked(gate(right("e1", "e2")), RULE, gate(right("e1")))!, /you own 50% \(25% before\)\.$/);
});

test("opened lists only the tiers a session opened", () => {
	const before = gatesOf(Store.itemsOf([quiz]), new AnswerIndex(right("e1", "e2", "e3")), RULE);
	const after = gatesOf(Store.itemsOf([quiz]), new AnswerIndex(right("e1", "e2", "e3", "e4")), RULE);
	assert.deepEqual([...opened(before, after)], [["a", ["hard"]]]);
	assert.equal(opened(after, after).size, 0);
});
