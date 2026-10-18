import { test } from "node:test";
import { strict as assert } from "node:assert";
import { hashFlag, hintsNeedShortening, isNudge, leaksFlag, nudges } from "../src/labs";
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
	assert.ok(!isNudge("RBX ends as 0x9D7E."), "so is a four-digit one");
	assert.ok(!isNudge("The flag is flag{…}."));
	assert.ok(!isNudge("The key is 1234567."), "so is a long number");
	assert.ok(!isNudge("   "));
	assert.ok(isNudge("Prefix 0x48 changes the width."), "a short opcode is fine");
});

test("only nudges are kept, three at most", () => {
	assert.deepEqual(nudges(["One.", WALKTHROUGH[0], "Two.", "Three.", "Four."]), ["One.", "Two.", "Three."]);
	assert.deepEqual(nudges("not a list"), []);
	assert.ok(hintsNeedShortening(lab("old", WALKTHROUGH)));
	assert.ok(!hintsNeedShortening(lab("new", ["Mind the width."])));
	assert.ok(!hintsNeedShortening({ ...lab("broken", []), hints: undefined } as never), "a lab file without hints");
});

test("a hint that is the flag, in any punctuation, gives it away", () => {
	const l = { ...lab("x", []), flagHash: hashFlag("flag{x0r_k3y}") };
	assert.ok(leaksFlag(l, "Try `flag{x0r_k3y}`."));
	assert.ok(!leaksFlag(l, "XOR is its own inverse."));
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
	assert.deepEqual(await tasks.rewriteHints([a, b]), { "arch-lab-1": 3 }, "lab 2 got nothing usable");
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
	assert.ok("error" in res && /short enough/.test(String(res.error)));
	assert.equal(vault.files.get("_quiz/labs/arch-lab-1.json"), JSON.stringify(a));
});

test("a lab is rewritten only with a full set that keeps its flag hidden, and only if it is the same lab", async () => {
	const vault = makeVault(0);
	// Four old hints, as labs had: a rewrite must bring a full three.
	const leaky = { ...lab("arch-lab-1", [...WALKTHROUGH, ...WALKTHROUGH]), flagHash: hashFlag("flag{x0r_k3y}") };
	const rebuilt = lab("arch-lab-2", WALKTHROUGH);
	vault.files.set("_quiz/labs/arch-lab-1.json", JSON.stringify(leaky));
	vault.files.set("_quiz/labs/arch-lab-2.json", JSON.stringify({ ...rebuilt, flagHash: "b".repeat(64) }));
	const cli = {
		askJson: async () => ({
			ok: true,
			data: { hints: { "arch-lab-1": ["Mind the width.", "flag{x0r_k3y}", "XOR undoes itself."], "arch-lab-2": ["One.", "Two.", "Three."] } },
		}),
	};
	const tasks = new Tasks({ vault } as never, cli as never, {} as never, () => "normal", () => "_quiz/banks", () => "_quiz/courses", () => "_quiz/labs");
	const res = await tasks.rewriteHints([leaky, rebuilt]);
	assert.ok("error" in res, "the leaky set is short of three, and lab 2 was rebuilt meanwhile");
	assert.deepEqual((JSON.parse(vault.files.get("_quiz/labs/arch-lab-1.json")!) as Lab).hints, leaky.hints);
});

test("many labs are rewritten a few per request", async () => {
	const vault = makeVault(0);
	const labs = Array.from({ length: 9 }, (_, i) => lab(`lab-${i}`, WALKTHROUGH));
	for (const l of labs) vault.files.set(`_quiz/labs/${l.id}.json`, JSON.stringify(l));
	let prompts = 0;
	const cli = {
		askJson: async (p: string) => {
			prompts += 1;
			const ids = labs.map((l) => l.id).filter((id) => p.includes(`"id": "${id}"`));
			return { ok: true, data: { hints: Object.fromEntries(ids.map((id) => [id, ["One.", "Two.", "Three."]])) } };
		},
	};
	const tasks = new Tasks({ vault } as never, cli as never, {} as never, () => "normal", () => "_quiz/banks", () => "_quiz/courses", () => "_quiz/labs");
	const res = await tasks.rewriteHints(labs);
	assert.equal(prompts, 3, "9 labs, 4 per request");
	assert.equal(Object.keys(res).length, 9);
});
