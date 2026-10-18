import { test } from "node:test";
import { strict as assert } from "node:assert";
import { blurtExam, blurtPrompt, headingsOf, missedHeading, parseBlurt, sectionsOf } from "../src/blurt";
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

const names = (content: string) => headingsOf(content).map((h) => h.text);
const sections = (...names: string[]) => names.map((name) => ({ name, link: name }));

test("a note's headings, without frontmatter or code", () => {
	assert.deepEqual(names(NOTE), ["Registers", "Widths", "Encoding"]);
	assert.deepEqual(headingsOf(NOTE).map((h) => h.level), [1, 2, 2]);
	assert.deepEqual(names("No headings at all."), []);
});

test("headings are read the way Obsidian reads them", () => {
	assert.deepEqual(names("---\n---\n# First\ntext\n\n---\n# Second"), ["First", "Second"], "an empty frontmatter swallows nothing");
	assert.deepEqual(names("---\r\ntags: [x]\r\n---\r\n# Windows\r\n"), ["Windows"], "CRLF frontmatter");
	assert.deepEqual(names("# Real\n\n    # indented code\n\t# tabbed code"), ["Real"]);
	assert.deepEqual(names("%%\n# hidden\n%%\n# Shown\n%% # inline %%"), ["Shown"]);
	assert.deepEqual(names("## Why C#\n## Closed ##"), ["Why C#", "Closed"]);
});

test("a repeated heading is named, and linked, through the one above it", () => {
	const s = sectionsOf(headingsOf("# Registers\n## Example\n# Flags\n## Example\n# Summary"));
	assert.deepEqual(s, [
		{ name: "Registers", link: "Registers" },
		{ name: "Registers > Example", link: "Registers#Example" },
		{ name: "Flags", link: "Flags" },
		{ name: "Flags > Example", link: "Flags#Example" },
		{ name: "Summary", link: "Summary" },
	]);
	assert.equal(missedHeading({ heading: "Flags > Example", link: "Flags#Example" }), "Example");
	assert.equal(missedHeading({ heading: "Widths" }), "Widths", "older results have no link");
});

test("the comparison prompt lists the sections and what was written", () => {
	const prompt = blurtPrompt("03 Registers", NOTE, "rax is accumulator", ["Registers", "Widths"]);
	assert.match(prompt, /- Registers\n- Widths/);
	assert.match(prompt, /rax is accumulator/);
	assert.match(blurtPrompt("t", "c", "   ", ["S"]), /\(nothing\)/);
});

test("Claude's comparison is held to the note's real sections", () => {
	const known = sections("Registers", "Widths", "Encoding");
	const r = parseBlurt(
		{
			score: 140,
			feedback: " Good. ",
			covered: ["registers", "Made-up section"],
			missed: [{ heading: "Widths", point: "EAX zero-extends." }, { heading: "Nope", point: "x" }],
		},
		known, "C/a.md", NOW
	);
	assert.ok(typeof r === "object");
	assert.deepEqual(r.covered, ["Registers"], "matched without case, unknown dropped");
	assert.deepEqual(r.missed, [{ heading: "Widths", point: "EAX zero-extends.", link: "Widths" }]);
	assert.equal(r.score, 100, "clamped");
	assert.equal(r.feedback, "Good.");
	assert.equal(r.note, "C/a.md");
});

test("a missing score is worked out from the sections covered", () => {
	const r = parseBlurt({ covered: ["A"], missed: [{ heading: "B" }, { heading: "C" }] }, sections("A", "B", "C"), "n", NOW);
	assert.ok(typeof r === "object" && r.score === 33);
	assert.match(parseBlurt({ covered: ["Z"] }, sections("A"), "n", NOW) as string, /none of the note's sections/);
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
