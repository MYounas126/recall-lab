import { test } from "node:test";
import { strict as assert } from "node:assert";
import { describePractice, knownButUntried, practice, provenByHand } from "../src/handson";
import type { Lab, LabProgress, SkillAxis, Tier } from "../src/types";

const axes: SkillAxis[] = [
	{ id: "regs", label: "Registers & Data" },
	{ id: "stack", label: "Stack & Frames" },
	{ id: "flow", label: "Control Flow" },
];

const lab = (id: string, axis: string, tier: Tier = "easy"): Lab => ({
	id, courseId: "arch", note: "Arch/n.md", title: id, axis, tier,
	brief: "", setup: "", files: [], hints: [], flagHash: "a".repeat(64), flagFormat: "flag{...}", solution: "",
});

const solved = (hints = 0, attempts = 0): LabProgress =>
	({ labId: "x", attempts, hintsUsed: hints, solvedAt: "2026-10-20T10:00:00.000Z", firstOpenedAt: "2026-10-20T09:00:00.000Z" });
const open = (): LabProgress => ({ labId: "x", attempts: 1, hintsUsed: 0, firstOpenedAt: "2026-10-20T09:00:00.000Z" });
const quit = (): LabProgress => ({ labId: "x", attempts: 0, hintsUsed: 0, gaveUpAt: "2026-10-20T11:00:00.000Z", firstOpenedAt: "2026-10-20T09:00:00.000Z" });

test("each axis counts what was solved, what is open, and what was given up", () => {
	const labs = [lab("a", "regs"), lab("b", "regs", "brutal"), lab("c", "regs"), lab("d", "stack")];
	const p = practice(axes, labs, { a: solved(), b: solved(1), c: open(), d: quit() });
	const regs = p.find((x) => x.axis.id === "regs")!;
	assert.deepEqual(
		{ total: regs.total, solved: regs.solved, started: regs.started, gaveUp: regs.gaveUp },
		{ total: 3, solved: 2, started: 1, gaveUp: 0 }
	);
	assert.equal(regs.score, 93, "the mean of 100 and 85, a hint costing 15");
	assert.equal(regs.best, "brutal", "the hardest one solved");
	const stack = p.find((x) => x.axis.id === "stack")!;
	assert.deepEqual({ total: stack.total, solved: stack.solved, gaveUp: stack.gaveUp }, { total: 1, solved: 0, gaveUp: 1 });
	assert.equal(stack.score, null, "nothing solved, so nothing to average");
});

test("an axis with no labs, and a lab pointing at an axis that is gone", () => {
	const p = practice(axes, [lab("a", "vanished")], {});
	assert.equal(p.find((x) => x.axis.id === "flow")!.total, 0, "no labs for it");
	assert.equal(p.find((x) => x.axis.id === "regs")!.total, 1, "a lost axis falls to the first, as questions do");
	assert.deepEqual(practice([], [lab("a", "regs")], {}), [], "no axes, nothing to say");
});

test("a lab never opened is not the same as one abandoned", () => {
	const labs = [lab("a", "regs"), lab("b", "regs")];
	const p = practice(axes, labs, {})[0];
	assert.deepEqual({ solved: p.solved, started: p.started, gaveUp: p.gaveUp }, { solved: 0, started: 0, gaveUp: 0 });
	assert.equal(describePractice(p), "2 never opened");
});

test("each axis's record reads as a short line", () => {
	const of = (labs: Lab[], prog: Record<string, LabProgress>) => describePractice(practice(axes, labs, prog)[0]);
	assert.equal(of([], {}), "no labs yet");
	assert.equal(of([lab("a", "regs")], { a: solved() }), "1 of 1 solved · 100% · hardest easy");
	assert.equal(of([lab("a", "regs", "brutal")], { a: solved(2) }), "1 of 1 solved · 70% · hardest brutal");
	assert.equal(of([lab("a", "regs")], { a: open() }), "1 of 1 open");
	assert.equal(of([lab("a", "regs")], { a: quit() }), "1 given up");
});

test("the gap worth pointing at: answered well, never done by hand", () => {
	const labs = [lab("a", "regs"), lab("b", "stack")];
	const p = practice(axes, labs, { a: solved() });
	const scores = [
		{ axis: axes[0], score: 80, seen: 10 },   // answered well, and solved — fine
		{ axis: axes[1], score: 75, seen: 10 },   // answered well, never solved — the gap
		{ axis: axes[2], score: 90, seen: 10 },   // answered well, but there are no labs
	];
	assert.deepEqual(knownButUntried(p, scores).map((x) => x.axis.id), ["stack"]);
	assert.deepEqual(knownButUntried(p, scores.map((s) => ({ ...s, seen: 0 }))), [], "an axis never asked about is not a gap");
	assert.deepEqual(knownButUntried(p, scores.map((s) => ({ ...s, score: 20 }))), [], "nor is one you answer badly");
	assert.deepEqual(provenByHand(p).map((x) => x.axis.id), ["regs"]);
});
