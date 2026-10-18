import { test } from "node:test";
import { strict as assert } from "node:assert";
import { needingSteps, needsGuidance } from "../src/guided";
import { SECOND_TRY_CAP, Tasks, checkStep, checkVariant, combineTries, markPrompt, stepsPrompt } from "../src/tasks";
import type { Bank } from "../src/types";
import { attempt, makeVault, question } from "./helpers";

const steps = [question("p~s1"), question("p~s2")];
const problem = question("p", { tier: "brutal", type: "short", expected: "x", steps });

test("a problem is guided when new, or missed last time, and unaided once right", () => {
	assert.ok(needsGuidance(problem, []));
	assert.ok(needsGuidance(problem, [attempt("a", "p", 40)]));
	assert.ok(!needsGuidance(problem, [attempt("a", "p", 0), attempt("a", "p", 100)]));
	assert.ok(!needsGuidance(question("q"), []), "no steps, nothing to guide");
});

test("only brutal problems without steps need them", () => {
	const bank: Bank = { id: "a", title: "A", questions: [problem, question("b", { tier: "brutal" }), question("e")] };
	assert.deepEqual(needingSteps([bank]).map((b) => b.questions.map((q) => q.id)), [["b"]]);
});

test("a guided step must be marked on the device, and inherits its problem's place", () => {
	const s = question("x", { tier: "brutal", topic: "other" });
	assert.equal(checkStep(question("p", { tier: "brutal", topic: "regs", axis: "ax", ref: "N#H" }), s), null);
	assert.deepEqual([s.tier, s.topic, s.axis, s.ref], ["easy", "regs", "ax", "N#H"]);
	assert.match(checkStep(problem, question("x", { type: "short", expected: "y" }))!, /cannot be checked at once/);
	assert.match(checkStep(problem, question("x", { type: "cloze", cloze: "no blanks" }))!, /no blanks/);
	assert.match(checkStep(question("p"), question("x"))!, /not a brutal problem/, "steps are for brutal problems only");
});

test("the steps prompt lists the allowed types and leaves old steps out", () => {
	const prompt = stepsPrompt("Note", "content", [problem]);
	assert.match(prompt, /mcq, multi, cloze, order, match, hotspot, trace/);
	assert.ok(!prompt.includes("p~s1"), "existing steps are not sent back");
});

test("steps replace an old set, and a set needs at least two usable steps", async () => {
	const vault = makeVault(0);
	const path = "_quiz/banks/a.json";
	const bank: Bank = { id: "a", title: "A", questions: [problem, question("q2", { tier: "brutal" })] };
	vault.files.set(path, JSON.stringify(bank));
	const mcq = (p: string) => ({ type: "mcq", prompt: p, choices: ["a", "b"], answer: 0, explain: "" });
	const cli = {
		askJson: async () => ({
			ok: true,
			data: { steps: { p: [mcq("one"), mcq("two"), mcq("three")], q2: [mcq("lonely"), { type: "short", prompt: "x" }] } },
		}),
	};
	const tasks = new Tasks({ vault } as never, cli as never, {} as never, () => "normal", () => "_quiz/banks", () => "_quiz/courses");
	assert.equal(await tasks.generateSteps(bank, path, ["p", "q2"]), 1, "only p got a set");
	const saved = JSON.parse(vault.files.get(path)!) as Bank;
	assert.deepEqual(saved.questions[0].steps!.map((s) => [s.id, s.prompt]), [["p~s1", "one"], ["p~s2", "two"], ["p~s3", "three"]]);
	assert.equal(saved.questions[1].steps, undefined, "one usable step is not a walk-through");
});

test("steps written for a problem rebuilt meanwhile are not attached to what replaced it", async () => {
	const vault = makeVault(0);
	const path = "_quiz/banks/a.json";
	const bank: Bank = { id: "a", title: "A", questions: [question("p", { tier: "brutal", prompt: "Exploit the overflow." })] };
	vault.files.set(path, JSON.stringify(bank));
	const mcq = (p: string) => ({ type: "mcq", prompt: p, choices: ["a", "b"], answer: 0, explain: "" });
	const cli = {
		askJson: async () => {
			// Rebuilt while queued: p is now an easy question about something else.
			vault.files.set(path, JSON.stringify({ ...bank, questions: [question("p", { prompt: "What does XOR EAX, EAX do?" })] }));
			return { ok: true, data: { steps: { p: [mcq("frame step 1"), mcq("frame step 2")] } } };
		},
	};
	const tasks = new Tasks({ vault } as never, cli as never, {} as never, () => "normal", () => "_quiz/banks", () => "_quiz/courses");
	const res = await tasks.generateSteps(bank, path, ["p"]);
	assert.ok(typeof res === "object" && /changed/.test(res.error), JSON.stringify(res));
	assert.equal((JSON.parse(vault.files.get(path)!) as Bank).questions[0].steps, undefined);
});

test("a variant or practice question never keeps steps echoed from its original", () => {
	const v = question("v", { tier: "brutal", steps: [question("s")] });
	assert.equal(checkVariant(question("o", { tier: "brutal" }), v), null);
	assert.equal(v.steps, undefined);
});

test("the marking prompt asks for a nudge that does not give the answer away", () => {
	const prompt = markPrompt(question("s", { type: "short", expected: "RAX", rubric: ["names RAX"] }), "RBX", false, "normal");
	assert.match(prompt, /"nudge"/);
	assert.match(prompt, /WITHOUT stating it/);
});

test("a nudge comes back only with a miss", async () => {
	const reply = (verdict: string) => ({
		askJson: async () => ({ ok: true, data: { score: 50, verdict, feedback: "f", missing: [], nudge: "Which register is the accumulator?" } }),
	});
	const make = (cli: object) => new Tasks({ vault: makeVault(0) } as never, cli as never, {} as never, () => "normal", () => "", () => "");
	const q = question("s", { type: "short", expected: "RAX" });
	const partial = await make(reply("partial")).markAnswer(q, "RBX");
	assert.ok(!("error" in partial) && partial.nudge === "Which register is the accumulator?");
	const correct = await make(reply("correct")).markAnswer(q, "RAX");
	assert.ok(!("error" in correct) && correct.nudge === undefined);
});

test("a second try is capped, and never counts as fully right", () => {
	const first = { score: 20, verdict: "incorrect" as const, feedback: "f1", missing: ["a"] };
	const perfect = combineTries(first, { score: 100, verdict: "correct", feedback: "f2", missing: [] });
	assert.equal(perfect.score, Math.round(100 * SECOND_TRY_CAP));
	assert.equal(perfect.verdict, "partial");
	assert.match(perfect.feedback, /^Second try: f2/);
	assert.equal(perfect.secondWon, true);
	const worse = combineTries({ ...first, score: 50 }, { score: 30, verdict: "incorrect", feedback: "f3", missing: ["b"] });
	assert.equal(worse.score, 50, "a worse second try never lowers the first");
	assert.equal(worse.secondWon, false);
	assert.match(worse.feedback, /^Your first try stands: f1/, "the winning try's feedback");
	assert.deepEqual(worse.missing, ["a"]);
	assert.equal(combineTries(first, { score: 10, verdict: "incorrect", feedback: "", missing: [] }).verdict, "incorrect");
});
