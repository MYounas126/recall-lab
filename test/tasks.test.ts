import { test } from "node:test";
import { strict as assert } from "node:assert";
import { bankPrompt, checkInteractive, validateBank } from "../src/tasks";
import type { Bank, Course } from "../src/types";
import { question } from "./helpers";

const course: Course = { id: "c", title: "C", folder: "C", axes: [{ id: "a1", label: "A" }] };

test("hands-on questions are checked, and values tidied to strings", () => {
	assert.equal(checkInteractive(question("h", { type: "hotspot", code: "a\nb", lines: [2] })), null);
	assert.match(checkInteractive(question("h", { type: "hotspot", code: "a\nb", lines: [3] }))!, /outside its code/);
	assert.match(checkInteractive(question("h", { type: "hotspot", lines: [1] }))!, /no code/);

	const trace = question("t", { type: "trace", code: "mov eax, 1", trace: [{ line: 1, expect: { eax: 1 as unknown as string } }] });
	assert.equal(checkInteractive(trace), null);
	assert.equal(trace.trace![0].expect.eax, "1", "a number from the generator becomes text");
	assert.match(checkInteractive(question("t", { type: "trace", code: "x", trace: [{ line: 1, expect: {} }] }))!, /nothing to fill in/);

	assert.match(checkInteractive(question("o", { type: "order", items: ["a", "b"] }))!, /three items/);
	assert.match(checkInteractive(question("o", { type: "order", items: ["a", "b", "A"] }))!, /repeats/);
	assert.match(checkInteractive(question("m", { type: "match", pairs: [["a", "1"], ["b", "1"], ["c", "2"]] }))!, /same answer/);
	assert.match(checkInteractive(question("z", { type: "cloze", cloze: "no blanks here" }))!, /no blanks/);
});

test("a broken hands-on question is dropped, not the whole bank", () => {
	const fine = question("q1");
	const bank: Bank = {
		id: "b", title: "B",
		questions: [fine, question("q2", { type: "order", items: ["only one"] })],
	};
	assert.equal(validateBank(bank, course), null);
	assert.equal(bank.questions.length, 1);
	assert.equal(bank.questions[0], fine);
});

test("hands-on answers are tidied: lines once each, numbers from strings, no rounded values", () => {
	const hot = question("h", { type: "hotspot", code: "a\nb\nc", lines: [2, 2, "3"] as never });
	assert.equal(checkInteractive(hot), null);
	assert.deepEqual(hot.lines, [2, 3]);
	const trace = (expect: Record<string, unknown>) =>
		question("t", { type: "trace", code: "mov rax, 1", trace: [{ line: "1" as never, expect: expect as never }] });
	const fine = trace({ rax: 1 });
	assert.equal(checkInteractive(fine), null);
	assert.deepEqual(fine.trace, [{ line: 1, expect: { rax: "1" } }]);
	assert.match(checkInteractive(trace({ rax: 18446744073709552000 }))!, /too large/);
	assert.equal(checkInteractive(trace({ rax: "0xffffffffffffffff" })), null);
});

test("match answers must differ as the dropdown shows them", () => {
	const q = question("m", { type: "match", pairs: [["a", "`*rsp`"], ["b", "`rsp`"], ["c", "**rsp**"]] });
	assert.match(checkInteractive(q)!, /same answer/);
});

test("a bank of nothing but broken questions is rejected", () => {
	const bank: Bank = { id: "b", title: "B", questions: [question("q1", { type: "match", pairs: [] })] };
	assert.match(validateBank(bank, course)!, /usable/);
});

test("unknown types still fall back to a written answer", () => {
	const bank: Bank = { id: "b", title: "B", questions: [question("q1", { type: "essay" as never })] };
	assert.equal(validateBank(bank, course), null);
	assert.equal(bank.questions[0].type, "short");
});

test("the generator is told about every hands-on type", () => {
	const prompt = bankPrompt("Registers", "# Registers", "C/Registers.md", course, false);
	for (const type of ["hotspot", "trace", "order", "match"]) assert.ok(prompt.includes(`"type":"${type}"`), type);
});
