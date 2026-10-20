import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
	BENIGN_INPUT, PROBE_INPUT, PWN_CFLAGS, PWN_PROTECTIONS, SECTIONS,
	challengeProblem, checkScript, parseCheck, pwnPrompt,
} from "../src/pwn";
import { Sandbox } from "../src/sandbox";
import { LabStore, hashFlag } from "../src/labs";
import { Tasks } from "../src/tasks";
import type { Course, Lab, Tier } from "../src/types";
import { makeVault } from "./helpers";

const course: Course = { id: "bx", title: "Binary Exploitation", folder: "BX", axes: [{ id: "stack", label: "Stack" }] };
const FLAG = "flag{fr4m3_0f_m1n3}";

// ------------------------------------------------------------- the prompt

test("the prompt asks for a vulnerable program and a win path, never for an exploit", () => {
	const p = pwnPrompt("05 The Stack", "Saved RBP, return address.", course, "easy", []);
	assert.match(p, /COMPILED x86-64 Linux binary with symbols/);
	assert.match(p, /`win` function that prints the flag/);
	assert.match(p, /They write the exploit themselves; you do not\./);
	assert.match(p, /Saved RBP, return address\./, "the note itself");
	assert.ok(!/write (an |the )?exploit for/i.test(p), "it is never asked to attack its own program");
});

test("the prompt pins the bug to one a sanitizer can confirm, and keeps the flag out of the binary", () => {
	const p = pwnPrompt("N", "c", course, "hard", []);
	assert.match(p, /MEMORY-SAFETY bug on the stack/);
	assert.match(p, /proves the bug is really there by building the/);
	assert.match(p, /a sanitizer only sees memory errors/);
	assert.match(p, /NEVER EXIST AS A LITERAL STRING IN THE BINARY/);
	assert.match(p, /'f'\^0x5a/, "the constant-expression trick");
	assert.match(p, /YOU CANNOT RUN ANYTHING/);
});

test("the generator is told the protections are not its to choose, and not to give addresses away", () => {
	const p = pwnPrompt("N", "c", course, "brutal", ["Overflowed"]);
	assert.match(p, /Do NOT choose the compiler flags or weaken any protection/);
	assert.match(p, /stack canary, PIE and full RELRO/, "the tier's protections, stated");
	assert.match(p, /Do NOT put addresses, offsets or buffer distances in the brief/);
	assert.match(p, /Already used for this note.*Overflowed/);
});

test("each tier is compiled the same way every time, and says what it leaves you facing", () => {
	assert.ok(PWN_CFLAGS.easy.includes("-fno-stack-protector") && PWN_CFLAGS.easy.includes("-no-pie"));
	assert.ok(PWN_CFLAGS.hard.includes("-fno-stack-protector") && PWN_CFLAGS.hard.includes("-pie"));
	assert.ok(PWN_CFLAGS.brutal.includes("-fstack-protector-strong") && PWN_CFLAGS.brutal.includes("-pie"));
	for (const tier of ["easy", "hard", "brutal"] as Tier[]) {
		assert.ok(PWN_CFLAGS[tier].includes("-O0"), `${tier}: the frame stays plain`);
		assert.ok(!PWN_CFLAGS[tier].includes("-s"), `${tier}: symbols are kept`);
		assert.match(PWN_PROTECTIONS[tier], /NX on/);
	}
});

// -------------------------------------------------------------- the check

test("the check script builds the tier's way, then proves the bug with a sanitizer build", () => {
	const s = checkScript(["src/pwn.c"], "stack", "easy");
	assert.match(s, /gcc '-O0' '-fno-stack-protector' '-no-pie' '-w' -o 'stack' 'src\/pwn\.c'/);
	assert.match(s, new RegExp(`\\./'stack' < '${BENIGN_INPUT}'`), "ordinary input on the real binary");
	assert.match(s, /-fsanitize=address .* -o probe_build/, "a second build, only to confirm the bug");
	assert.match(s, new RegExp(`\\./probe_build < '${PROBE_INPUT}'`));
	assert.ok(!s.includes("grep -F"), "the plugin judges, outside the container");
	// The sanitizer copy is never what gets handed over.
	assert.ok(s.indexOf("-o 'stack'") < s.indexOf("probe_build"));
});

test("the check output is split into its sections", () => {
	const script = ["strings", "benign", "symbols", "sanitizer", "elf"];
	const stdout = script.map((s) => `===RL-${s.toUpperCase()}===\n${s}-body\n`).join("");
	const out = parseCheck(stdout);
	for (const s of SECTIONS) assert.match(out[s], new RegExp(`${s}-body`));
});

// ------------------------------------------------- is it worth handing over?

const good = {
	strings: "/lib64/ld-linux\nGCC: (Debian)\nWho goes there?",
	benign: "Who goes there?\nWelcome, Alice\n[exit:0]",
	symbols: "main\ngreet\nwin\nputs",
	sanitizer: "==1==ERROR: AddressSanitizer: stack-buffer-overflow on address 0x7ffd",
	elf: "GNU_STACK 0x000000 RW\nGNU_RELRO 0x002df8\nType: EXEC",
};
const verdict = (over: Partial<typeof good>, tier: Tier = "easy") => challengeProblem({ ...good, ...over }, FLAG, tier);

test("a challenge is kept only when the flag is hidden, ordinary input is dull, and the bug is real", () => {
	assert.equal(verdict({}), null);
	assert.match(String(verdict({ strings: "", benign: "" })), /did not build/);
	assert.match(String(verdict({ strings: `GCC\n${FLAG}` })), /readable with `strings`/);
	assert.match(String(verdict({ benign: `${FLAG}\n[exit:0]` })), /prints the flag on ordinary input/);
	assert.match(String(verdict({ benign: "crash\n[exit:139]" })), /does not survive ordinary input/);
	assert.match(String(verdict({ symbols: "main\ngreet\nputs" })), /no `win` symbol/);
	assert.match(String(verdict({ sanitizer: "no output at all" })), /did not trip the bug/);
});

test("only a stack overflow counts, because that is the bug the challenge is meant to have", () => {
	const heap = "==1==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x60";
	assert.match(String(verdict({ sanitizer: heap })), /the bug is heap-buffer-overflow, not a stack buffer overflow/);
	const dyn = "==1==ERROR: AddressSanitizer: dynamic-stack-buffer-overflow";
	assert.equal(verdict({ sanitizer: dyn }), null, "a variable-length frame still counts");
});

test("the protections have to match the tier they were compiled for", () => {
	const exec = "GNU_STACK 0x000000 RW\nType: EXEC";
	const dyn = "GNU_STACK 0x000000 RW\nType: DYN";
	const canary = good.symbols + "\n__stack_chk_fail";
	assert.equal(verdict({ elf: exec }, "easy"), null);
	assert.match(String(verdict({ elf: dyn }, "easy")), /no PIE and no canary/);
	assert.match(String(verdict({ elf: exec, symbols: canary }, "easy")), /no PIE and no canary/);
	assert.equal(verdict({ elf: dyn }, "hard"), null);
	assert.match(String(verdict({ elf: exec }, "hard")), /PIE and no canary/);
	assert.equal(verdict({ elf: dyn, symbols: canary }, "brutal"), null);
	assert.match(String(verdict({ elf: dyn }, "brutal")), /PIE and a canary/);
	const rwe = "GNU_STACK 0x000000 0x0 0x0 0x0 0x0 RWE\nType: EXEC";
	assert.match(String(verdict({ elf: rwe })), /stack came out executable/);
});

// -------------------------------------------------------- writing one end to end

function fakeDocker(report: Partial<typeof good> & { writeBinary?: boolean } = {}) {
	const calls: string[][] = [];
	const exec = async (_cmd: string, args: string[]) => {
		calls.push(args);
		if (args.includes("info")) return { code: 0, stdout: "27.0.0", stderr: "", timedOut: false };
		if (args.includes("inspect")) return { code: 0, stdout: "sha256:1", stderr: "", timedOut: false };
		const work = (args[args.indexOf("-v") + 1] ?? "").split(":")[0];
		if (report.writeBinary !== false) fs.writeFileSync(path.join(work, "stack"), "ELF");
		const merged = { ...good, ...report };
		const stdout = SECTIONS.map((s) => `===RL-${s.toUpperCase()}===\n${merged[s]}\n`).join("");
		return { code: 0, stdout, stderr: "", timedOut: false };
	};
	return { exec, calls };
}

const CHALLENGE = {
	title: "Frame of Mine", tier: "easy", axis: "stack", minutes: 60,
	brief: "Reach the win path.", files: [{ path: "src/pwn.c", content: "int main(void){return 0;}" }],
	output: "stack", benign: { stdin: "Alice\n" }, probe: { stdin: "A".repeat(160) + "\n" },
	hints: ["Count to the saved return address."], flag: FLAG, flagFormat: "flag{...}",
	solution: "Overwrite the saved return address with win.",
	// The generator does not get to pick these; the tier does.
	build: { cflags: ["-O2", "-s", "-fstack-protector-all"], output: "mine" },
};

async function writeChallenge(reply: unknown, report?: Parameters<typeof fakeDocker>[0], tier: Tier = "easy") {
	const vault = makeVault(0);
	vault.files.set("BX/05 The Stack.md", "# The stack\nSaved RBP and the return address.");
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rl-pwn-"));
	const app = { vault } as never;
	const labs = new LabStore(app, () => "_quiz/labs", () => workspace);
	const docker = fakeDocker(report);
	const sandbox = new Sandbox(() => ({ docker: "docker", context: "" }), docker.exec);
	const cli = { askJson: async () => ({ ok: true, data: reply }) };
	const tasks = new Tasks(app, cli as never, {} as never, () => "normal", () => "_quiz/banks", () => "_quiz/courses", () => "_quiz/labs", sandbox, labs);
	const res = await tasks.generatePwn("BX/05 The Stack.md", course, tier);
	return { res, vault, workspace, docker };
}

test("a sound challenge is saved, with the tier's protections and not the generator's", async () => {
	const { res, vault, workspace } = await writeChallenge(CHALLENGE);
	assert.ok(!("error" in res), JSON.stringify(res));
	const lab = res as Lab;
	assert.equal(lab.kind, "pwn");
	assert.deepEqual(lab.build, { cflags: PWN_CFLAGS.easy, output: "stack" }, "the tier decides how it is built");
	assert.equal(lab.flagHash, hashFlag(FLAG));

	const saved = JSON.parse(vault.files.get(`_quiz/labs/${lab.id}.json`)!) as Lab & { benign?: unknown; probe?: unknown };
	assert.equal(saved.benign, undefined, "the checking inputs are not part of the lab");
	assert.equal(saved.probe, undefined);
	assert.ok(!JSON.stringify(saved).includes("fr4m3_0f_m1n3"), "nor is the flag");
	assert.ok(fs.existsSync(path.join(workspace, lab.id, "stack")), "the binary is on disk");
	const brief = fs.readFileSync(path.join(workspace, lab.id, "BRIEF.md"), "utf8");
	assert.match(brief, /`win` function that prints the flag/);
	assert.match(brief, /no stack canary, no PIE/, "it says what it was built with");
	fs.rmSync(workspace, { recursive: true, force: true });
});

test("the ordinary and probe inputs go into the build, and are cleared away after", async () => {
	const { docker, workspace } = await writeChallenge(CHALLENGE);
	const run = docker.calls.find((a) => a.includes("--network"))!;
	assert.ok(run.includes("none"), "the challenge is built with no network");
	const work = run[run.indexOf("-v") + 1].split(":")[0];
	assert.ok(work.includes(".build"));
	assert.ok(!fs.existsSync(work), "cleared away afterwards");
	fs.rmSync(workspace, { recursive: true, force: true });
});

test("a challenge that cannot be shown to have the bug is refused", async () => {
	for (const [name, report, expected] of [
		["no bug", { sanitizer: "clean run" }, /did not trip the bug/],
		["flag readable", { strings: `GCC\n${FLAG}` }, /readable with `strings`/],
		["no win", { symbols: "main\ngreet" }, /no `win` symbol/],
		["free flag", { benign: `${FLAG}\n[exit:0]` }, /prints the flag on ordinary input/],
	] as [string, Parameters<typeof fakeDocker>[0], RegExp][]) {
		const { res, workspace } = await writeChallenge(CHALLENGE, report);
		assert.ok("error" in res, name);
		assert.match((res as { error: string }).error, expected, name);
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("a reply missing what the check needs is refused before anything is built", async () => {
	const without = async (drop: Record<string, unknown>) => {
		const { res, workspace } = await writeChallenge({ ...CHALLENGE, ...drop });
		fs.rmSync(workspace, { recursive: true, force: true });
		return "error" in res ? res.error : "accepted";
	};
	assert.match(await without({ flag: undefined }), /without a flag/);
	assert.match(await without({ probe: undefined }), /without the inputs needed to check it/);
	assert.match(await without({ benign: undefined }), /without the inputs needed to check it/);
	assert.match(await without({ files: [] }), /without source/);
	assert.match(await without({ output: "../escape" }), /not a plain file name/);
	assert.match(await without({ title: `${FLAG} here` }), /still shows its flag/);
});
