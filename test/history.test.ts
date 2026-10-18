import { test } from "node:test";
import { strict as assert } from "node:assert";
import { AnswerIndex } from "../src/history";
import { Store } from "../src/store";
import { scoreAxes } from "../src/radar";
import type { Bank, Course } from "../src/types";
import { attempt, question } from "./helpers";

// Generated banks number their questions q1, q2… so the same ids recur.
const bankA: Bank = { id: "a", title: "A", note: "C/a.md", questions: [question("q1"), question("q2")] };
const bankB: Bank = { id: "b", title: "B", note: "C/b.md", questions: [question("q1"), question("q2")] };
const course: Course = { id: "c", title: "C", folder: "C", axes: [{ id: "a1", label: "Axis" }] };

test("an answer counts only for the bank it was given in", () => {
	const index = new AnswerIndex([attempt("a", "q1", 100)]);
	assert.equal(index.mastery("a", "q1"), 100);
	assert.equal(index.mastery("b", "q1"), null);
	assert.equal(index.lastSeen("b", "q1"), 0);
});

test("mastery is the mean of the three most recent scores", () => {
	const index = new AnswerIndex([0, 0, 100, 40, 100].map((s) => attempt("a", "q1", s)));
	assert.equal(index.mastery("a", "q1"), 80);
});

test("lastSeen is the most recent answer", () => {
	const index = new AnswerIndex([
		attempt("a", "q1", 100, "2026-10-01T09:00:00.000Z"),
		attempt("a", "q1", 100, "2026-10-05T09:00:00.000Z"),
	]);
	assert.equal(index.lastSeen("a", "q1"), Date.parse("2026-10-05T09:00:00.000Z"));
});

test("across banks, an unanswered q1 is still asked first", () => {
	const index = new AnswerIndex([attempt("a", "q1", 100), attempt("a", "q2", 100)]);
	const picked = Store.pickQuestions(Store.itemsOf([bankA, bankB]), index, "easy", 2);
	assert.deepEqual(picked.map((it) => `${it.bankId}/${it.q.id}`).sort(), ["b/q1", "b/q2"]);
});

test("the radar does not borrow scores from another bank's q1", () => {
	const [axis] = scoreAxes(course, [bankA, bankB], new AnswerIndex([attempt("a", "q1", 100)]));
	assert.equal(axis.total, 4);
	assert.equal(axis.seen, 1);
	assert.equal(axis.score, 25); // 100 over four questions; the unanswered three count as zero
});

test("a course exam keeps every question's own bank", () => {
	const tiered = (id: string): Bank => ({
		id, title: id,
		questions: [question("q1"), question("q2", { tier: "hard" }), question("q3", { tier: "brutal" })],
	});
	const picked = Store.pickExam(Store.itemsOf([tiered("c"), tiered("d")]), new AnswerIndex([]), 6);
	assert.equal(picked.length, 6);
	assert.deepEqual(picked.map((it) => it.bankId).sort(), ["c", "c", "c", "d", "d", "d"]);
});

test("the full exam puts easy first and keeps everything", () => {
	const bank: Bank = {
		id: "x", title: "X",
		questions: [question("b1", { tier: "brutal" }), question("h1", { tier: "hard" }), question("e1")],
	};
	const order = Store.fullExam(Store.itemsOf([bank])).map((it) => it.q.id);
	assert.deepEqual(order, ["e1", "h1", "b1"]);
});
