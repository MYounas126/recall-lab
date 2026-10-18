import { test } from "node:test";
import { strict as assert } from "node:assert";
import { blurtExam, blurtPrompt, headingsOf, parseBlurt } from "../src/blurt";
import { AnswerIndex } from "../src/history";
import { Store } from "../src/store";
import { Tasks } from "../src/tasks";
import type { Bank } from "../src/types";
import { makeVault, question } from "./helpers";

const NOTE = `---
tags: [asm]
---
# Registers
RAX is the accumulator.
## Widths
\`\`\`
# not a heading, just a comment in code
\`\`\`
## Encoding ##
`;
const NOW = new Date(2026, 9, 18);

test("a note's headings, without frontmatter or code", () => {
	assert.deepEqual(headingsOf(NOTE), ["Registers", "Widths", "Encoding"]);
	assert.deepEqual(headingsOf("No headings at all."), []);
});

test("the comparison prompt lists the sections and what was written", () => {
	const prompt = blurtPrompt("03 Registers", NOTE, "rax is accumulator", ["Registers", "Widths"]);
	assert.match(prompt, /- Registers\n- Widths/);
	assert.match(prompt, /rax is accumulator/);
	assert.match(blurtPrompt("t", "c", "   ", ["S"]), /\(nothing\)/);
});

test("Claude's comparison is held to the note's real sections", () => {
	const sections = ["Registers", "Widths", "Encoding"];
	const r = parseBlurt(
		{
			score: 140,
			feedback: " Good. ",
			covered: ["registers", "Made-up section"],
			missed: [{ heading: "Widths", point: "EAX zero-extends." }, { heading: "Nope", point: "x" }],
		},
		sections, "C/a.md", NOW
	);
	assert.ok(typeof r === "object");
	assert.deepEqual(r.covered, ["Registers"], "matched without case, unknown dropped");
	assert.deepEqual(r.missed, [{ heading: "Widths", point: "EAX zero-extends." }]);
	assert.equal(r.score, 100, "clamped");
	assert.equal(r.feedback, "Good.");
	assert.equal(r.note, "C/a.md");
});

test("a missing score is worked out from the sections covered", () => {
	const r = parseBlurt({ covered: ["A"], missed: [{ heading: "B" }, { heading: "C" }] }, ["A", "B", "C"], "n", NOW);
	assert.ok(typeof r === "object" && r.score === 33);
	assert.match(parseBlurt({ covered: ["Z"] }, ["A"], "n", NOW) as string, /none of the note's sections/);
});

test("the quiz afterwards asks the left-out sections first", () => {
	const bank: Bank = {
		id: "a", title: "A",
		questions: [
			question("q1", { ref: "Note#Registers" }),
			question("q2", { ref: "Note#Widths" }),
			question("q3", { ref: "Note#Widths", tier: "hard" }),
			question("q4", { ref: "Note#Encoding" }),
		],
	};
	const picked = blurtExam(Store.itemsOf([bank]), new AnswerIndex([]), 3, ["widths"]);
	assert.deepEqual(picked.slice(0, 2).map((it) => it.q.id), ["q2", "q3"]);
	assert.equal(picked.length, 3);
	assert.equal(blurtExam(Store.itemsOf([bank]), new AnswerIndex([]), 1, ["Widths"]).length, 1, "never longer than asked");
});

test("checkBlurt compares with the note and treats a note without headings as one section", async () => {
	const vault = makeVault(0);
	vault.files.set("C/flat.md", "Just text, no headings.");
	let sent = "";
	const cli = {
		askJson: async (prompt: string) => {
			sent = prompt;
			return { ok: true, data: { score: 70, feedback: "f", covered: ["flat"], missed: [] } };
		},
	};
	const tasks = new Tasks({ vault } as never, cli as never, {} as never, () => "normal", () => "", () => "");
	const res = await tasks.checkBlurt("C/flat.md", "some text");
	assert.ok(!("error" in res) && res.score === 70 && res.covered[0] === "flat");
	assert.match(sent, /SECTIONS:\n- flat/);
	assert.ok("error" in (await tasks.checkBlurt("C/missing.md", "x")));
});

test("results are kept in order", async () => {
	const store = new Store({ vault: makeVault(0) } as never, () => "_quiz/banks", () => "_quiz/progress");
	const result = (score: number) => ({ note: "C/a.md", at: NOW.toISOString(), score, feedback: "", covered: [], missed: [] });
	await store.saveBlurt(result(40));
	await store.saveBlurt(result(70));
	assert.deepEqual((await store.readProgress()).blurts!.map((b) => b.score), [40, 70]);
});
