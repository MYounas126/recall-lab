import { test } from "node:test";
import { strict as assert } from "node:assert";
import { allCovered, coverage, describeCoverage, pickOrder } from "../src/coverage";
import type { Bank, Lab, LabKind, Question } from "../src/types";

const q = (id: string): Question =>
	({ id, tier: "easy", type: "mcq", topic: "t", prompt: "p", choices: ["a", "b"], answer: 0, explain: "" });
const bank = (note: string, n: number): Bank =>
	({ id: `b-${note}`, title: note, note, questions: Array.from({ length: n }, (_, i) => q(`q${i}`)) });
const lab = (id: string, note: string, kind?: LabKind): Lab => ({
	id, courseId: "c", note, title: id, axis: "a", tier: "easy", kind,
	brief: "", setup: "", files: [], hints: [], flagHash: "a", flagFormat: "f", solution: "",
});

const notes = ["C/01.md", "C/02.md", "C/03.md"];

test("each note's coverage counts its questions and its labs by kind", () => {
	const labs = [lab("l1", "C/01.md"), lab("l2", "C/01.md", "source"), lab("b1", "C/01.md", "binary"), lab("p1", "C/02.md", "pwn")];
	const c = coverage(notes, [bank("C/01.md", 7)], labs, { b1: { solvedAt: "2026-10-20T10:00:00Z" } });
	assert.deepEqual(
		{ ...c[0], note: undefined },
		{ note: undefined, name: "01", questions: 7, labs: 2, binary: 1, pwn: 0, solved: 1 },
		"a lab with no kind is a source lab, as every lab was before"
	);
	assert.deepEqual({ labs: c[1].labs, pwn: c[1].pwn, questions: c[1].questions }, { labs: 0, pwn: 1, questions: 0 });
	assert.deepEqual({ ...c[2], note: undefined, name: undefined }, { note: undefined, name: undefined, questions: 0, labs: 0, binary: 0, pwn: 0, solved: 0 });
});

test("what a note has reads as a few words, or nothing at all", () => {
	const of = (labs: Lab[], questions = 0, solved: Record<string, { solvedAt?: string }> = {}) =>
		describeCoverage(coverage(["C/01.md"], questions ? [bank("C/01.md", questions)] : [], labs, solved)[0]);
	assert.equal(of([]), null, "nothing built yet");
	assert.equal(of([], 46), "46 q");
	assert.equal(of([lab("a", "C/01.md")], 46), "46 q · 1 lab");
	assert.equal(of([lab("a", "C/01.md"), lab("b", "C/01.md")]), "2 labs");
	assert.equal(of([lab("a", "C/01.md", "binary"), lab("b", "C/01.md", "pwn")]), "1 reversing · 1 pwn");
	assert.equal(of([lab("a", "C/01.md", "binary")], 0, { a: { solvedAt: "x" } }), "1 reversing · 1 solved");
});

test("the notes with none of this kind are offered first, then the fewest", () => {
	const labs = [
		lab("b1", "C/01.md", "binary"), lab("b2", "C/01.md", "binary"),
		lab("b3", "C/02.md", "binary"),
		lab("p1", "C/03.md", "pwn"),
	];
	const c = coverage(notes, [], labs, {});
	assert.deepEqual(pickOrder(c, "binary").map((x) => x.name), ["03", "02", "01"], "none, then one, then two");
	assert.deepEqual(pickOrder(c, "pwn").map((x) => x.name), ["01", "02", "03"], "a different kind, a different order");
});

test("among notes with none of it, one with a quiz comes first", () => {
	const c = coverage(notes, [bank("C/03.md", 20)], [], {});
	assert.deepEqual(pickOrder(c, "binary").map((x) => x.name), ["03", "01", "02"], "a note already read well enough to question");
	assert.deepEqual(pickOrder(coverage(notes, [], [], {}), "binary").map((x) => x.name), ["01", "02", "03"], "otherwise the course's own order");
});

test("once every note has one, the order has nothing left to say", () => {
	const all = notes.map((n, i) => lab(`b${i}`, n, "binary"));
	assert.equal(allCovered(coverage(notes, [], all, {}), "binary"), true);
	assert.equal(allCovered(coverage(notes, [], all, {}), "pwn"), false);
	assert.equal(allCovered([], "binary"), false, "no notes is not full coverage");
});
