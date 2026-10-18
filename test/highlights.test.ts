import { test } from "node:test";
import { strict as assert } from "node:assert";
import { hashText, highlightBank, highlightQuestions } from "../src/highlights";
import { Store } from "../src/store";
import { gradeLocally } from "../src/grader";
import { makeVault } from "./helpers";

const NOTE = `---
tags: [asm]
---
# Registers

Writing to ==EAX== zero-extends the result into ==RAX==. The rest is untouched.

- ==RBX== is register number three in the encoding.
## Widths
\`\`\`asm
mov ==eax==, 1   ; inside code: not a question
\`\`\`
A ==word== is two bytes wide on x86.
Too ==short==.
`;

test("each sentence with a highlight becomes a fill-in-the-blank", () => {
	const qs = highlightQuestions("Arch/03 Registers.md", NOTE);
	assert.deepEqual(qs.map((q) => q.cloze), [
		"Writing to {{EAX}} zero-extends the result into {{RAX}}.",
		"{{RBX}} is register number three in the encoding.",
		"A {{word}} is two bytes wide on x86.",
	]);
	assert.ok(qs.every((q) => q.type === "cloze" && q.tier === "easy"));
});

test("each question points at the heading above it", () => {
	const qs = highlightQuestions("Arch/03 Registers.md", NOTE);
	assert.equal(qs[0].ref, "03 Registers#Registers");
	assert.equal(qs[2].ref, "03 Registers#Widths");
});

test("the explanation shows the sentence with the answers in bold", () => {
	assert.equal(highlightQuestions("a.md", NOTE)[0].explain, "Writing to **EAX** zero-extends the result into **RAX**.");
});

test("ids come from the text, so they survive a reload and change with an edit", () => {
	const first = highlightQuestions("a.md", NOTE).map((q) => q.id);
	assert.deepEqual(highlightQuestions("a.md", NOTE).map((q) => q.id), first);
	const edited = highlightQuestions("a.md", NOTE.replace("two bytes", "16 bits"));
	assert.notEqual(edited[2].id, first[2]);
	assert.equal(edited[0].id, first[0]);
	assert.match(first[0], /^hl-[0-9a-f]{8}$/);
	assert.equal(hashText("abc"), hashText("abc"));
});

test("a note without highlights has no highlight bank", () => {
	assert.equal(highlightBank("a.md", "# Plain\n\nNothing marked here."), null);
	assert.equal(highlightBank("Arch/03 Registers.md", NOTE)!.id, "hl:Arch/03 Registers.md");
});

test("a highlight question marks like any cloze", () => {
	const [q] = highlightQuestions("a.md", NOTE);
	assert.equal(gradeLocally(q, { text: "", chosen: [], blanks: ["eax", "rax"] })!.verdict, "correct");
});

test("the store finds highlight banks across a course's notes", async () => {
	const vault = makeVault(0);
	vault.files.set("Arch/03 Registers.md", NOTE);
	vault.files.set("Arch/04 Plain.md", "# Plain\n\nNothing marked.");
	vault.files.set("Other/x.md", "Writing to ==EAX== zero-extends the result into RAX.");
	const store = new Store({ vault } as never, () => "_quiz/banks", () => "_quiz/progress");
	const banks = await store.listHighlightBanks([{ id: "arch", title: "Arch", folder: "Arch", axes: [] }]);
	assert.deepEqual(banks.map((b) => b.note), ["Arch/03 Registers.md"]);
});
