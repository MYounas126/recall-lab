import { test } from "node:test";
import { strict as assert } from "node:assert";
import { findLeeches } from "../src/leeches";
import { AnswerIndex } from "../src/history";
import { Tasks, leechPrompt, parseDiagnosis } from "../src/tasks";
import { Store } from "../src/store";
import { qkey, type Bank, type Diagnosis } from "../src/types";
import { attempt, makeVault, question } from "./helpers";

const ts = (day: number) => new Date(2026, 9, day, 9).toISOString();
const miss = (id: string, day: number, response = "wrong") => attempt("a", id, 0, ts(day), { response, feedback: `fb ${day}` });
const bank: Bank = { id: "a", title: "A", note: "C/a.md", questions: [question("q1"), question("q2"), question("q3")] };

test("a leech is missed often and not since put right twice running", () => {
	const index = new AnswerIndex([
		miss("q1", 1), miss("q1", 2), miss("q1", 3), miss("q1", 4), miss("q1", 5),
		miss("q2", 1), miss("q2", 2), miss("q2", 3), miss("q2", 4),
		attempt("a", "q2", 100, ts(5)), attempt("a", "q2", 100, ts(6)), // cured
		miss("q3", 1), miss("q3", 2), miss("q3", 3),                    // under the threshold
	]);
	const leeches = findLeeches([bank], index, 4);
	assert.deepEqual(leeches.map((l) => [l.key, l.misses]), [[qkey("a", "q1"), 5]]);
	assert.equal(findLeeches([bank], index, 3).length, 2, "a lower threshold catches q3 too");
	assert.equal(findLeeches([bank], index, 3)[0].key, qkey("a", "q1"), "most missed first");
});

test("the diagnosis prompt shows the question and every recent wrong answer", () => {
	const prompt = leechPrompt(question("q1", { prompt: "Which register is number 3?" }), [miss("q1", 1, "RCX"), miss("q1", 2, "RDX")], "Registers", "The note.");
	assert.match(prompt, /Which register is number 3\?/);
	assert.match(prompt, /1\. They said: RCX \| Marked: fb 1/);
	assert.match(prompt, /2\. They said: RDX/);
	assert.match(prompt, /"type":"mcq"/);
	assert.match(prompt, /The note\./);
});

test("a diagnosis needs a misconception, a lesson and a usable fresh question", () => {
	const original = question("q1", { tier: "hard", topic: "numbers" });
	const fresh = { type: "mcq", prompt: "And number 1?", choices: ["RCX", "RAX"], answer: 0, explain: "" };
	const now = new Date(2026, 9, 18);
	const ok = parseDiagnosis(original, { misconception: "You count from 1.", lesson: ["a", "b", "c"], question: fresh }, now);
	assert.ok(typeof ok === "object");
	assert.equal(ok.question.id, "q1~fix");
	assert.equal(ok.question.tier, "hard", "the fresh question tests the same idea");
	assert.deepEqual(ok.lesson, ["a", "b", "c"]);
	assert.match(parseDiagnosis(original, { lesson: ["a"], question: fresh }, now) as string, /no misconception/);
	assert.match(parseDiagnosis(original, { misconception: "x", lesson: [], question: fresh }, now) as string, /no lesson/);
	const wrongType = { ...fresh, type: "short" };
	assert.match(parseDiagnosis(original, { misconception: "x", lesson: ["a"], question: wrongType }, now) as string, /fresh question/);
});

test("a diagnosis is stored and survives other changes to progress", async () => {
	const vault = makeVault();
	const store = new Store({ vault } as never, () => "_quiz/banks", () => "_quiz/progress");
	const d: Diagnosis = { at: ts(1), misconception: "m", lesson: ["s"], question: question("q1~fix") };
	await Promise.all([store.saveDiagnosis(qkey("a", "q1"), d), store.markComplete("C/a.md")]);
	const data = await store.readProgress();
	assert.equal(data.clinic?.[qkey("a", "q1")]?.misconception, "m");
	assert.ok(data.completed?.["C/a.md"]);
});

test("diagnoseLeech reads the note, asks once and returns a checked diagnosis", async () => {
	const vault = makeVault(0);
	vault.files.set("C/a.md", "# A\n\nRBX is register 3.");
	let asked = "";
	const cli = {
		askJson: async (prompt: string) => {
			asked = prompt;
			return { ok: true, data: { misconception: "m", lesson: ["s1", "s2", "s3"], question: { type: "mcq", prompt: "p", choices: ["a", "b"], answer: 1, explain: "" } } };
		},
	};
	const tasks = new Tasks({ vault } as never, cli as never, {} as never, () => "normal", () => "_quiz/banks", () => "_quiz/courses");
	const leech = { item: { bankId: "a", q: question("q1") }, key: qkey("a", "q1"), misses: 4, wrong: [miss("q1", 1)] };
	const res = await tasks.diagnoseLeech(leech, "C/a.md");
	assert.ok(!("error" in res));
	assert.match(asked, /RBX is register 3/);
	const failing = new Tasks({ vault } as never, { askJson: async () => ({ ok: true, data: {} }) } as never, {} as never, () => "normal", () => "", () => "");
	const bad = await failing.diagnoseLeech(leech, "C/a.md");
	assert.ok("error" in bad && /not usable/.test(bad.error));
});
