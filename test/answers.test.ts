import { test } from "node:test";
import { strict as assert } from "node:assert";
import { blankSize, describeResponse, notReady, plain, scrambled } from "../src/answers";
import { question } from "./helpers";

const state = (extra: object = {}) => ({ text: "", chosen: [], ...extra });

test("an answer cannot be sent before there is one", () => {
	assert.match(notReady(question("q"), state())!, /Pick an answer/);
	assert.equal(notReady(question("q"), state({ chosen: [1] })), null);
	assert.match(notReady(question("h", { type: "hotspot" }), state())!, /Click a line/);
	const trace = question("t", { type: "trace", trace: [{ line: 1, expect: { a: "1" } }, { line: 2, expect: { a: "2" } }] });
	assert.match(notReady(trace, state({ traceChecked: 1 }))!, /every step/);
	assert.equal(notReady(trace, state({ traceChecked: 2 })), null);
	assert.equal(notReady(question("o", { type: "order" }), state()), null, "an untouched order is still an answer");
});

test("every type's answer reads as one line", () => {
	assert.equal(describeResponse(question("q", { choices: ["a", "b"] }), state({ chosen: [1] })), "b");
	assert.equal(describeResponse(question("h", { type: "hotspot" }), state({ chosen: [7, 3] })), "line 3, 7");
	assert.equal(describeResponse(question("o", { type: "order", items: ["x", "y", "z"] }), state({ order: [2, 0, 1] })), "z → x → y");
	assert.equal(
		describeResponse(question("m", { type: "match", pairs: [["RAX", "0"], ["RCX", "1"]] }), state({ matches: [1, -1] })),
		"RAX → 1; RCX → ?"
	);
	assert.equal(describeResponse(question("c", { type: "cloze" }), state({ blanks: ["eax", "rax"] })), "eax | rax");
	assert.equal(
		describeResponse(question("t", { type: "trace", trace: [{ line: 2, expect: { eax: "1", ZF: "0" } }] }), state({ cells: [["1", "0"]] })),
		"line 2: eax=1, ZF=0"
	);
	assert.equal(describeResponse(question("s", { type: "short" }), state({ text: "typed" })), "typed");
});

test("a scrambled order is never already right", () => {
	for (let i = 0; i < 50; i++) {
		const s = scrambled(3);
		assert.deepEqual(s.slice().sort(), [0, 1, 2]);
		assert.notDeepEqual(s, [0, 1, 2]);
	}
	assert.deepEqual(scrambled(1), [0], "one item has only one order");
});

test("blank widths come in steps, so they do not give the answer's length away", () => {
	assert.equal(blankSize(["ax"]), blankSize(["rax123"]));
	assert.equal(blankSize(["a", "zero-extends"]), 14);
	assert.equal(blankSize(["a much longer answer"]), 22);
});

test("plain text drops markdown a dropdown cannot show", () => {
	assert.equal(plain("`RAX` is **wide**"), "RAX is wide");
	assert.equal(plain("[[Note]]"), "Note");
});
