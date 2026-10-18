import { test } from "node:test";
import { strict as assert } from "node:assert";
import { describeSection, dotLevel, headingKey, noteMemory, refHeading } from "../src/notemap";
import { Memory, describeAgo, expectedScore } from "../src/memory";
import { AnswerIndex } from "../src/history";
import type { Bank } from "../src/types";
import { attempt, question } from "./helpers";

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 18, 12, 0);
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

test("headings match regardless of case, punctuation and markdown", () => {
	assert.equal(headingKey("4.1 The **width** suffixes:"), headingKey("4.1 the width suffixes"));
	assert.equal(headingKey("Registers — RAX, RBX"), "registers rax rbx");
	assert.notEqual(headingKey("4.1 Widths"), headingKey("4.2 Widths"));
});

test("a ref names the heading after its last #", () => {
	assert.equal(refHeading("03 Registers#4.1 The width suffixes"), "4.1 The width suffixes");
	assert.equal(refHeading("Note#Part#Sub part"), "Sub part");
	assert.equal(refHeading("Note without heading"), null);
	assert.equal(refHeading(undefined), null);
	assert.equal(refHeading("Note#"), null);
});

const bank: Bank = {
	id: "a", title: "A", note: "C/a.md",
	questions: [
		question("q1", { ref: "A#Widths" }),
		question("q2", { ref: "A#Widths" }),
		question("q3", { ref: "A#Encoding" }),
		question("q4"), // no ref: counts toward the note, not a section
	],
};

test("a note's memory is grouped by the sections its questions point at", () => {
	const history = [attempt("a", "q1", 100, ago(1)), attempt("a", "q3", 0, ago(2))];
	const memory = new Memory(history, 0.9);
	const index = new AnswerIndex(history);
	const note = noteMemory([bank], memory, expectedScore(history, 0.9, NOW), (b, q) => index.lastSeen(b, q), NOW);

	assert.equal(note.questions, 4);
	assert.equal(note.lastAnswered, Date.parse(ago(1)));
	assert.equal(note.sections.size, 2);

	const widths = note.sections.get(headingKey("Widths"))!;
	assert.equal(widths.questions, 2);
	assert.equal(widths.answered, 1);
	assert.ok(widths.score! > 80, "a question answered right yesterday is well remembered");

	const encoding = note.sections.get(headingKey("Encoding"))!;
	assert.equal(encoding.score, 0, "missed, so nothing to remember yet");
	assert.equal(encoding.due, 1, "a miss two days ago is due");
	assert.equal(note.due, 1);
});

test("dots are green from 80, amber from 50, red below, grey when unanswered", () => {
	assert.equal(dotLevel(null), "none");
	assert.equal(dotLevel(92), "good");
	assert.equal(dotLevel(80), "good");
	assert.equal(dotLevel(55), "fair");
	assert.equal(dotLevel(10), "poor");
});

test("the dot's tooltip says what it means", () => {
	assert.equal(
		describeSection({ questions: 3, answered: 2, due: 1, score: 64 }),
		"Expected score 64% · 2 of 3 questions answered · 1 due today"
	);
	assert.equal(describeSection({ questions: 1, answered: 0, due: 0, score: null }), "Not answered yet · 0 of 1 question answered");
});

test("describeAgo speaks plainly", () => {
	assert.equal(describeAgo(new Date(NOW.getTime() - 3_600_000), NOW), "today");
	assert.equal(describeAgo(new Date(NOW.getTime() - DAY), NOW), "yesterday");
	assert.equal(describeAgo(new Date(NOW.getTime() - 5 * DAY), NOW), "5 days ago");
	assert.match(describeAgo(new Date(NOW.getTime() - 60 * DAY), NOW), /^on /);
});
