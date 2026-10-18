import { test } from "node:test";
import { strict as assert } from "node:assert";
import { clozeBlanks, clozePieces, gradeLocally, longestInOrder, parseValue, sameText, sameValue } from "../src/grader";
import { question } from "./helpers";

const answer = (extra: object = {}) => ({ text: "", chosen: [], ...extra });

test("multiple choice and select-all still mark as before", () => {
	assert.equal(gradeLocally(question("q"), answer({ chosen: [0] }))!.verdict, "correct");
	assert.equal(gradeLocally(question("q"), answer({ chosen: [1] }))!.verdict, "incorrect");
	const multi = question("m", { type: "multi", choices: ["a", "b", "c", "d"], answer: [0, 2] });
	assert.equal(gradeLocally(multi, answer({ chosen: [0, 2] }))!.score, 100);
	assert.equal(gradeLocally(multi, answer({ chosen: [0] }))!.verdict, "partial");
});

test("written answers still go to Claude unless an accept pattern matches", () => {
	const short = question("s", { type: "short", accept: ["^r3$"] });
	assert.equal(gradeLocally(short, answer({ text: "R3" }))!.verdict, "correct");
	assert.equal(gradeLocally(short, answer({ text: "the third one" })), null);
});

test("click the bug: right line, wrong line, and one of two", () => {
	const q = question("h", { type: "hotspot", code: "int a;\nstrcpy(buf, in);\nreturn 0;", lines: [2] });
	assert.equal(gradeLocally(q, answer({ chosen: [2] }))!.verdict, "correct");
	const miss = gradeLocally(q, answer({ chosen: [3] }))!;
	assert.equal(miss.verdict, "incorrect");
	assert.match(miss.feedback, /line 2: `strcpy\(buf, in\);`/);
	const two = question("h2", { type: "hotspot", code: "a\nb\nc", lines: [1, 3] });
	assert.equal(gradeLocally(two, answer({ chosen: [1] }))!.score, 50);
});

test("order: credit for the longest stretch in the right relative order", () => {
	assert.equal(longestInOrder([0, 1, 2, 3]), 4);
	assert.equal(longestInOrder([1, 0, 2, 3]), 3);
	assert.equal(longestInOrder([3, 2, 1, 0]), 1);
	const q = question("o", { type: "order", items: ["decompile", "patch", "repack", "sign"] });
	assert.equal(gradeLocally(q, answer({ order: [0, 1, 2, 3] }))!.verdict, "correct");
	const moved = gradeLocally(q, answer({ order: [0, 2, 1, 3] }))!;
	assert.equal(moved.score, 75);
	assert.equal(moved.verdict, "partial");
	assert.match(moved.feedback, /1\. decompile\n2\. patch/);
	assert.equal(gradeLocally(q, answer({ order: [3, 2, 1, 0] }))!.verdict, "incorrect", "reversed is not partial");
	assert.equal(gradeLocally(q, answer({ order: [0, 1] }))!.score, 0, "an incomplete answer scores nothing");
});

test("match: one point per correct pair", () => {
	const q = question("m", { type: "match", pairs: [["RAX", "0"], ["RCX", "1"], ["RDX", "2"], ["RBX", "3"]] });
	assert.equal(gradeLocally(q, answer({ matches: [0, 1, 2, 3] }))!.verdict, "correct");
	const half = gradeLocally(q, answer({ matches: [0, 1, 3, 2] }))!;
	assert.equal(half.score, 50);
	assert.match(half.feedback, /\*\*RDX\*\* goes with \*\*2\*\*/);
	assert.equal(gradeLocally(q, answer({ matches: [-1, -1, -1, -1] }))!.score, 0);
});

test("cloze: blanks, alternatives and forgiving comparison", () => {
	const text = "Writing to {{EAX}} zero-extends into {{RAX|the full 64-bit register}}.";
	assert.deepEqual(clozeBlanks(text), [["EAX"], ["RAX", "the full 64-bit register"]]);
	assert.deepEqual(clozePieces(text), ["Writing to ", " zero-extends into ", "."]);
	const q = question("c", { type: "cloze", cloze: text });
	assert.equal(gradeLocally(q, answer({ blanks: ["eax", "The full 64-bit register."] }))!.verdict, "correct");
	assert.equal(gradeLocally(q, answer({ blanks: ["eax", "rbx"] }))!.score, 50);
	assert.ok(sameText(" `RAX` ", "rax"));
	assert.ok(!sameText("", ""), "an empty blank is never right");
});

test("register values compare by value, whatever the base", () => {
	assert.equal(parseValue("16"), BigInt(16));
	assert.equal(parseValue("0x10"), BigInt(16));
	assert.equal(parseValue("10h"), BigInt(16));
	assert.equal(parseValue("0b10000"), BigInt(16));
	assert.equal(parseValue("set"), BigInt(1));
	assert.equal(parseValue("clear"), BigInt(0));
	assert.equal(parseValue("rax"), null);
	assert.ok(sameValue("0x10", "16"));
	assert.ok(sameValue("0xFFFFFFFFFFFFFFFF", "18446744073709551615"), "64-bit values stay exact");
	assert.ok(!sameValue("0xFFFFFFFFFFFFFFFF", "18446744073709551614"));
	assert.ok(sameValue("-1", "0xFFFFFFFF"), "-1 is all ones in a 32-bit register");
	assert.ok(sameValue("-1", "0xFFFFFFFFFFFFFFFF"));
	assert.ok(!sameValue("-2", "0xFFFFFFFF"));
	assert.ok(sameValue("ZF", "zf"), "names compare as text");
	assert.ok(!sameValue("", "0"), "an empty cell is never right");
});

test("trace: one point per value, across every step", () => {
	const q = question("t", {
		type: "trace",
		code: "mov eax, 0x10\nadd eax, 1",
		trace: [{ line: 1, expect: { eax: "0x10" } }, { line: 2, expect: { eax: "0x11", ZF: "0" } }],
	});
	assert.equal(gradeLocally(q, answer({ cells: [["16"], ["17", "clear"]] }))!.verdict, "correct");
	const partly = gradeLocally(q, answer({ cells: [["16"], ["18", "0"]] }))!;
	assert.equal(partly.score, 67);
	assert.match(partly.feedback, /after line 2, \*\*eax\*\* = `0x11`/);
});
