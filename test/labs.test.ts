import { test } from "node:test";
import { strict as assert } from "node:assert";
import { hintsNeedShortening, isNudge, nudges } from "../src/labs";
import { Tasks, hintsPrompt, labPrompt } from "../src/tasks";
import type { Course, Lab } from "../src/types";
import { makeVault } from "./helpers";

const course: Course = { id: "arch", title: "Arch", folder: "Arch", axes: [{ id: "regs", label: "Registers" }] };

// Hints as the old prompt had Claude write them: steps, then the answer.
const WALKTHROUGH = [
	"Only the writes to `RAX` change `RAX`. Track it first, one instruction at a time, as a 16-hex-digit number.",
	"After that, `mov bh, 0x9D` replaces only bits 15-8. The final `RBX` is `0x0000000055669D7E`. Take its bytes little-endian.",
];

function lab(id: string, hints: string[]): Lab {
	return {
		id, courseId: "arch", note: "Arch/03 Registers.md", title: id, axis: "regs", tier: "easy",
		brief: "Find the flag.", setup: "cat src/c.c", files: [{ path: "src/c.c", content: "int main(){}" }],
		hints, flagHash: "a".repeat(64), flagFormat: "flag{...}", solution: "Trace RBX.",
	};
}

test("a hint is a nudge of a few words, not a step or a value", () => {
	assert.ok(isNudge("Mind the register width."));
	assert.ok(isNudge("What does `AH` cover?"));
	assert.ok(isNudge("Not every write zero-extends."));
	for (const h of WALKTHROUGH) assert.ok(!isNudge(h), h);
	assert.ok(!isNudge("RBX ends as 0x55669D7E."), "a long hex value is part of the answer");
	assert.ok(!isNudge("The key is 1234567."), "so is a long number");
	assert.ok(!isNudge("   "));
	assert.ok(isNudge("Prefix 0x48 changes the width."), "a short opcode is fine");
});

test("only nudges are kept, three at most", () => {
	assert.deepEqual(nudges(["One.", WALKTHROUGH[0], "Two.", "Three.", "Four."]), ["One.", "Two.", "Three."]);
	assert.deepEqual(nudges("not a list"), []);
	assert.ok(hintsNeedShortening(lab("old", WALKTHROUGH)));
	assert.ok(!hintsNeedShortening(lab("new", ["Mind the width."])));
});

test("the lab prompt asks for CTF-style hints, never for one that nearly tells them", () => {
	const prompt = labPrompt("03 Registers", "content", "Arch/03 Registers.md", course, 3, "gcc");
	assert.match(prompt, /HackTheBox/);
	assert.match(prompt, /AT MOST 8 words/);
	assert.ok(!/nearly telling them/.test(prompt));
});

test("a new lab keeps only its nudges", async () => {
	const vault = makeVault(0);
	vault.files.set("Arch/03 Registers.md", "# Registers\nRAX is the accumulator.");
	// The flag's inside, hex-encoded: there to be worked out, not read off.
	const encoded = Buffer.from("wide_eax", "utf8").toString("hex");
	const cli = {
		askJson: async () => ({
			ok: true,
			data: {
				labs: [{
					title: "Widths", tier: "easy", axis: "regs", brief: "Find the flag.", setup: "cat src/c.c",
					files: [{ path: "src/c.c", content: `const char *k = "${encoded}"; /* decode me */` }],
					hints: ["Mind the register width.", ...WALKTHROUGH, "XOR is its own inverse."],
					flag: "flag{wide_eax}", solution: "Decode the hex.",
				}],
			},
		}),
	};
	const tasks = new Tasks({ vault } as never, cli as never, {} as never, () => "normal", () => "_quiz/banks", () => "_quiz/courses", () => "_quiz/labs");
	const res = await tasks.generateLabs("Arch/03 Registers.md", course, 1);
	assert.ok(Array.isArray(res), JSON.stringify(res));
	assert.deepEqual(res[0].hints, ["Mind the register width.", "XOR is its own inverse."]);
});

test("old hints are rewritten in one request, keeping the rest of each lab", async () => {
	const vault = makeVault(0);
	const a = lab("arch-lab-1", WALKTHROUGH);
	const b = lab("arch-lab-2", WALKTHROUGH);
	vault.files.set("_quiz/labs/arch-lab-1.json", JSON.stringify(a));
	vault.files.set("_quiz/labs/arch-lab-2.json", JSON.stringify(b));
	let prompts = 0;
	let sent = "";
	const cli = {
		askJson: async (p: string) => {
			prompts += 1;
			sent = p;
			return {
				ok: true,
				data: { hints: { "arch-lab-1": ["Which write zero-extends?", "Watch the upper half.", "BH is bits 8-15."], "arch-lab-2": [WALKTHROUGH[1]] } },
			};
		},
	};
	const tasks = new Tasks({ vault } as never, cli as never, {} as never, () => "normal", () => "_quiz/banks", () => "_quiz/courses", () => "_quiz/labs");
	assert.equal(await tasks.rewriteHints([a, b]), 1, "lab 2 got nothing usable");
	assert.equal(prompts, 1);
	assert.match(sent, /"id": "arch-lab-1"/);
	assert.match(hintsPrompt([a]), /AT MOST 8 words/);
	const saved = JSON.parse(vault.files.get("_quiz/labs/arch-lab-1.json")!) as Lab;
	assert.deepEqual(saved.hints, ["Which write zero-extends?", "Watch the upper half.", "BH is bits 8-15."]);
	assert.equal(saved.flagHash, a.flagHash);
	assert.deepEqual(saved.files, a.files);
	assert.deepEqual((JSON.parse(vault.files.get("_quiz/labs/arch-lab-2.json")!) as Lab).hints, WALKTHROUGH, "kept as it was");
});

test("hints that are all still too long are an error, and nothing is written", async () => {
	const vault = makeVault(0);
	const a = lab("arch-lab-1", WALKTHROUGH);
	vault.files.set("_quiz/labs/arch-lab-1.json", JSON.stringify(a));
	const cli = { askJson: async () => ({ ok: true, data: { hints: { "arch-lab-1": WALKTHROUGH } } }) };
	const tasks = new Tasks({ vault } as never, cli as never, {} as never, () => "normal", () => "_quiz/banks", () => "_quiz/courses", () => "_quiz/labs");
	const res = await tasks.rewriteHints([a]);
	assert.ok(typeof res === "object" && /short enough/.test(res.error));
	assert.equal(vault.files.get("_quiz/labs/arch-lab-1.json"), JSON.stringify(a));
});
