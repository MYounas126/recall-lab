import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseStudent, parseTeachScore, studentPrompt, teachScorePrompt } from "../src/teach";
import { Tasks } from "../src/tasks";
import { Store } from "../src/store";
import type { Turn } from "../src/types";
import { makeVault } from "./helpers";

const NOW = new Date(2026, 9, 18);
const turns: Turn[] = [
	{ who: "you", text: "Registers are tiny fast storage inside the CPU." },
	{ who: "student", text: "Why does writing EAX change RAX?" },
	{ who: "you", text: "Writing a 32-bit register zero-extends into the 64-bit one." },
];

test("the student sees the conversation and how many questions it has left", () => {
	const prompt = studentPrompt("Registers", "The note.", turns, 2);
	assert.match(prompt, /TEACHER: Registers are tiny fast storage/);
	assert.match(prompt, /STUDENT: Why does writing EAX change RAX\?/);
	assert.match(prompt, /You may ask 2 more questions/);
	assert.match(studentPrompt("R", "n", turns, 1), /You may ask 1 more question\./);
	assert.match(prompt, /Never hint at the answer/);
});

test("a student reply needs words; done is only ever true when said", () => {
	assert.deepEqual(parseStudent({ reply: " What is a flag? " }), { reply: "What is a flag?", done: false });
	assert.deepEqual(parseStudent({ reply: "Thanks!", done: true }), { reply: "Thanks!", done: true });
	assert.deepEqual(parseStudent({ reply: "Hm?", done: "yes" }), { reply: "Hm?", done: false });
	assert.match(parseStudent({ done: true }) as string, /said nothing/);
});

test("the scoring prompt carries the sections and the whole conversation", () => {
	const prompt = teachScorePrompt("Registers", "The note.", turns, ["Widths", "Encoding"]);
	assert.match(prompt, /- Widths\n- Encoding/);
	assert.match(prompt, /TEACHER: Writing a 32-bit register zero-extends/);
	assert.match(prompt, /KEY POINTS/);
});

test("a score is checked: clamped, sections held to the note, explanations counted", () => {
	const r = parseTeachScore(
		{
			score: -5,
			feedback: "Good start.",
			covered: ["Registers are fast storage"],
			missed: [{ point: "Zero-extension", heading: "widths" }, { point: "Encoding numbers", heading: "Not in the note" }, { point: "" }],
		},
		["Widths", "Encoding"], "C/a.md", turns, NOW
	);
	assert.ok(typeof r === "object");
	assert.equal(r.score, 0);
	assert.deepEqual(r.missed, [{ point: "Zero-extension", heading: "Widths" }, { point: "Encoding numbers" }]);
	assert.equal(r.turns, 2, "two explanations from you");
	const derived = parseTeachScore({ covered: ["a", "b", "c"], missed: [{ point: "d" }] }, [], "n", turns, NOW);
	assert.ok(typeof derived === "object" && derived.score === 75);
	assert.match(parseTeachScore({}, [], "n", turns, NOW) as string, /no key points/);
});

test("a whole conversation runs through the tasks without the real CLI", async () => {
	const vault = makeVault(0);
	vault.files.set("C/a.md", "# Widths\nEAX zero-extends into RAX.");
	const prompts: string[] = [];
	const replies: unknown[] = [
		{ reply: "What happens to the top half?" },
		{ score: 80, feedback: "f", covered: ["zero-extension"], missed: [{ point: "encoding", heading: "Widths" }] },
	];
	const cli = { askJson: async (p: string) => { prompts.push(p); return { ok: true, data: replies.shift() }; } };
	const tasks = new Tasks({ vault } as never, cli as never, {} as never, () => "normal", () => "", () => "");

	const reply = await tasks.studentReply("C/a.md", turns.slice(0, 1), 3);
	assert.ok(!("error" in reply) && reply.reply === "What happens to the top half?" && !reply.done);
	const score = await tasks.scoreTeachBack("C/a.md", turns);
	assert.ok(!("error" in score) && score.score === 80 && score.missed[0].heading === "Widths");
	assert.match(prompts[0], /EAX zero-extends into RAX/);
	assert.ok("error" in (await tasks.studentReply("C/gone.md", turns, 1)));
});

test("teach-back results are kept in order", async () => {
	const store = new Store({ vault: makeVault(0) } as never, () => "_quiz/banks", () => "_quiz/progress");
	const result = (score: number) => ({ note: "C/a.md", at: NOW.toISOString(), score, feedback: "", covered: [], missed: [], turns: 1 });
	await store.saveTeachBack(result(50));
	await store.saveTeachBack(result(90));
	assert.deepEqual((await store.readProgress()).teachbacks!.map((r) => r.score), [50, 90]);
});
