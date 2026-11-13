import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
	CHECK_SCRIPT, ExerciseKind, lastWords, plainName, redact, showsFlag, writeInputs, writeSources,
} from "../src/exercise";
import { C_BUILDER, SandboxImage, Sandbox, runArgs } from "../src/sandbox";
import { LabStore, hashFlag } from "../src/labs";
import { Tasks } from "../src/tasks";
import type { Course, Lab } from "../src/types";
import { KINDS, imagesNeeded, kindOf } from "../src/kinds";
import { makeVault } from "./helpers";

const course: Course = { id: "arch", title: "Arch", folder: "Arch", axes: [{ id: "regs", label: "Registers" }] };
/**
 * A build directory inside a parent of its own, so a test that checks what a
 * bad path would have written can look just outside it without reading, or
 * being fooled by, anything another run left in the system temp directory.
 */
function scratch(): { work: string; parent: string } {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rl-ex-"));
	const work = path.join(parent, "build");
	fs.mkdirSync(work);
	return { work, parent };
}

// ------------------------------------------------------ guarding the build

test("source goes where it is told, including into subdirectories", () => {
	const { work, parent } = scratch();
	assert.equal(writeSources(work, [{ path: "src/deep/a.c", content: "int a;" }]), null);
	assert.equal(fs.readFileSync(path.join(work, "src/deep/a.c"), "utf8"), "int a;");
	fs.rmSync(parent, { recursive: true, force: true });
});

test("a path that climbs out of the build is refused, and nothing is written", () => {
	// The build directory is mounted into the container. A path that escapes
	// it would put a generated file somewhere on the real machine.
	const { work, parent } = scratch();
	const outside = path.join(parent, "escaped.c");
	for (const bad of ["../escaped.c", "src/../../escaped.c", "./../escaped.c"]) {
		const why = writeSources(work, [{ path: bad, content: "pwned" }]);
		assert.match(String(why), /tries to escape the build/, bad);
		assert.ok(!fs.existsSync(outside), `${bad} wrote outside the build`);
	}
	assert.match(String(writeInputs(work, { "../in.txt": "x" })), /tries to escape the build/, "inputs are guarded too");
	assert.deepEqual(fs.readdirSync(parent), ["build"], "nothing landed beside the build");
	fs.rmSync(parent, { recursive: true, force: true });
});

test("a file written before a bad one still leaves the build unusable, not the machine dirty", () => {
	const { work, parent } = scratch();
	const why = writeSources(work, [{ path: "ok.c", content: "fine" }, { path: "../bad.c", content: "no" }]);
	assert.match(String(why), /tries to escape the build/);
	assert.ok(!fs.existsSync(path.join(parent, "bad.c")));
	assert.deepEqual(fs.readdirSync(parent), ["build"]);
	fs.rmSync(parent, { recursive: true, force: true });
});

// ------------------------------------------------------- hiding the answer

const labWith = (over: Partial<Lab>): Lab => ({
	id: "x", courseId: "arch", note: "n.md", title: "T", axis: "regs", tier: "easy",
	brief: "", setup: "", files: [], hints: [], flagHash: "a".repeat(64), flagFormat: "flag{...}", solution: "",
	...over,
});

test("the flag is taken out of everything shown before it is solved, but not the title", () => {
	const lab = labWith({
		brief: "It prints flag{secret} when happy.",
		solution: "The answer is flag{secret}.",
		hints: ["Look for flag{secret}", "Mind the width"],
		title: "flag{secret} challenge",
	});
	redact(lab, "flag{secret}");
	assert.equal(lab.brief, "It prints `flag{...}` when happy.");
	assert.equal(lab.solution, "The answer is `flag{...}`.");
	assert.deepEqual(lab.hints, ["Look for `flag{...}`", "Mind the width"]);
	assert.equal(lab.title, "flag{secret} challenge", "the title is left alone so the check can catch it");
	assert.equal(showsFlag(lab, "flag{secret}"), true, "and it does");
});

test("what the learner sees is judged after redacting, not before", () => {
	const lab = labWith({ brief: "It prints flag{secret}." });
	assert.equal(showsFlag(lab, "flag{secret}"), true);
	redact(lab, "flag{secret}");
	assert.equal(showsFlag(lab, "flag{secret}"), false, "redacting is a fix, not a reason to throw it away");
});

// ----------------------------------------------------------- small helpers

test("a plain file name is one that cannot point anywhere else", () => {
	for (const ok of ["stack", "crackme", "a.out", "my-prog_2"]) assert.equal(plainName(ok), true, ok);
	for (const no of ["../x", "a/b", ".hidden", "", "x".repeat(65), "a b"]) assert.equal(plainName(no), false, no);
});

test("a failed build is explained by its last words, from stderr when there is any", () => {
	assert.equal(lastWords({ stdout: "a\nb\nc\nd", stderr: "" }), "b c d");
	assert.equal(lastWords({ stdout: "out", stderr: "error: no such file" }), "error: no such file");
	assert.equal(lastWords({ stdout: "x".repeat(500), stderr: "" }).length, 300, "short enough for a notice");
});

// -------------------------------------- a new kind is a descriptor, no more

/** A toolchain the C builder does not have, to show a kind may ask for one. */
const PY_BUILDER: SandboxImage = {
	tag: "recall-lab-python:1",
	label: "the Python builder",
	dockerfile: "FROM --platform=linux/amd64 python:3.13-slim\nWORKDIR /work\n",
};

/**
 * A third kind that is not C and not compiled, written only for this test.
 * If the loop can carry it, the loop is not a crackme pipeline in disguise.
 */
const SCRIPT_KIND: ExerciseKind = {
	kind: "binary",
	image: PY_BUILDER,
	tag: "py",
	verb: "run",
	timeoutMs: 1000,
	prompt: (title) => `Write a Python puzzle for ${title}.`,
	prepare(reply, sources) {
		const solve = (reply.solve as { stdin?: unknown } | undefined)?.stdin;
		if (typeof solve !== "string") return "it came back without the input that solves it";
		return {
			build: { cflags: [], output: "puzzle.py" },
			inputs: { "solve.in": solve },
			script: `python3 ${sources[0].path} < solve.in`,
		};
	},
	verdict: (stdout, flag) => ({
		problem: stdout.includes(flag) ? null : "the input that should solve it did not print the flag",
		compiled: true,
	}),
	footer: (lab) => `\n\nRun \`${lab.build?.output}\` and work out what it wants.`,
};

function fakeDocker(printed: string) {
	const calls: string[][] = [];
	const exec = async (_cmd: string, args: string[]) => {
		calls.push(args);
		if (args.includes("info")) return { code: 0, stdout: "27.0.0", stderr: "", timedOut: false };
		if (args.includes("inspect")) return { code: 0, stdout: "sha256:1", stderr: "", timedOut: false };
		const work = (args[args.indexOf("-v") + 1] ?? "").split(":")[0];
		fs.writeFileSync(path.join(work, "puzzle.py"), "print('hi')");
		return { code: 0, stdout: printed, stderr: "", timedOut: false };
	};
	return { exec, calls };
}

async function runKind(reply: unknown, printed = "flag{py_puzzle}") {
	const vault = makeVault(0);
	vault.files.set("Arch/01 Intro.md", "# Intro\nRegisters.");
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rl-exlabs-"));
	const app = { vault } as never;
	const labs = new LabStore(app, () => "_quiz/labs", () => workspace);
	const docker = fakeDocker(printed);
	const sandbox = new Sandbox(() => ({ docker: "docker", context: "" }), docker.exec);
	const cli = { askJson: async () => ({ ok: true, data: reply }) };
	const tasks = new Tasks(
		app, cli as never, {} as never, () => "normal",
		() => "_quiz/banks", () => "_quiz/courses", () => "_quiz/labs", sandbox, labs
	);
	const res = await tasks.generateExercise(SCRIPT_KIND, "Arch/01 Intro.md", course, "easy", []);
	return { res, vault, workspace, docker };
}

const PUZZLE = {
	title: "Modulo Maze", axis: "regs", minutes: 20, brief: "Find the input.",
	files: [{ path: "src/puzzle.py", content: "x = input()" }],
	solve: { stdin: "42\n" }, hints: ["Count the remainder."],
	flag: "flag{py_puzzle}", flagFormat: "flag{...}", solution: "Invert the modulo.",
};

test("a new kind of exercise needs only a descriptor: the loop carries it unchanged", async () => {
	const { res, vault, workspace, docker } = await runKind(PUZZLE);
	assert.ok(!("error" in res), JSON.stringify(res));
	const lab = res as Lab;
	assert.match(lab.id, /^arch-01-intro-py-/, "named with the kind's own tag");
	assert.equal(lab.flagHash, hashFlag("flag{py_puzzle}"));
	assert.equal(lab.tier, "easy");

	// The loop ran the kind's script, in the kind's own toolchain, in the
	// locked-down container — not in whichever image happened to come first.
	const run = docker.calls.find((a) => a.includes("--network"))!;
	assert.deepEqual(run.slice(-3), [PY_BUILDER.tag, "sh", CHECK_SCRIPT]);
	assert.ok(!run.includes(C_BUILDER.tag), "the C builder has no part in it");
	assert.ok(run.includes("none"), "still no network");

	const saved = JSON.parse(vault.files.get(`_quiz/labs/${lab.id}.json`)!) as Lab & { solve?: unknown };
	assert.equal(saved.solve, undefined, "the solving input is the answer, so it is not stored");
	assert.ok(!JSON.stringify(saved).includes("py_puzzle"), "nor is the flag");
	assert.match(fs.readFileSync(path.join(workspace, lab.id, "BRIEF.md"), "utf8"), /work out what it wants/);
	fs.rmSync(workspace, { recursive: true, force: true });
});

test("the loop applies its own rules to a new kind, not just the kind's", async () => {
	// Everything the kind did not write: the flag, the source, the redaction
	// and the refusal to hand over something that gives itself away.
	const cases: [string, unknown, RegExp][] = [
		["no flag", { ...PUZZLE, flag: undefined }, /without a flag/],
		["no source", { ...PUZZLE, files: [] }, /without source/],
		["the kind's own check", { ...PUZZLE, solve: undefined }, /without the input that solves it/],
		["the flag in the title", { ...PUZZLE, title: "flag{py_puzzle} maze" }, /still shows its flag/],
		["a path that escapes", { ...PUZZLE, files: [{ path: "../out.py", content: "x" }] }, /tries to escape the build/],
	];
	for (const [name, reply, expected] of cases) {
		const { res, workspace } = await runKind(reply);
		assert.ok("error" in res, name);
		assert.match((res as { error: string }).error, expected, name);
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("a brief naming the flag is redacted, and a hint naming it is dropped", async () => {
	const { res, workspace } = await runKind({
		...PUZZLE,
		brief: "It prints flag{py_puzzle} when happy.",
		hints: ["Try flag{py_puzzle}", "Count the remainder."],
	});
	assert.ok(!("error" in res), JSON.stringify(res));
	const lab = res as Lab;
	assert.equal(lab.brief, "It prints `flag{...}` when happy.");
	assert.deepEqual(lab.hints, ["Count the remainder."], "a redacted hint is not a nudge, so it goes");
	fs.rmSync(workspace, { recursive: true, force: true });
});

test("a kind that says the challenge is unsound has it thrown away", async () => {
	const { res, workspace } = await runKind(PUZZLE, "Nope, wrong input.");
	assert.ok("error" in res);
	assert.match((res as { error: string }).error, /did not print the flag/);
	fs.rmSync(workspace, { recursive: true, force: true });
});

test("redacting happens before trimming, so a hint left saying only `flag{...}` is dropped", async () => {
	// A generator that formats its flag one way and names the format another.
	// Redacted first, the hint reads "Try `flag{...}`", which is not a nudge
	// and goes. Trimmed first, it survives redaction and reaches the page
	// saying nothing at all.
	const { res, workspace } = await runKind(
		{ ...PUZZLE, flag: "CTF{xyz123}", flagFormat: "flag{...}", hints: ["Try CTF{xyz123}", "Count the remainder."] },
		"CTF{xyz123}"
	);
	assert.ok(!("error" in res), JSON.stringify(res));
	assert.deepEqual((res as Lab).hints, ["Count the remainder."]);
	fs.rmSync(workspace, { recursive: true, force: true });
});

// ------------------------------------------------- one toolchain per kind

test("the image a container runs is the one it was given", () => {
	const args = (image: SandboxImage) => runArgs("", "job", "/w", ["sh", "x.sh"], image);
	assert.deepEqual(args(C_BUILDER).slice(-3), [C_BUILDER.tag, "sh", "x.sh"]);
	assert.deepEqual(args(PY_BUILDER).slice(-3), [PY_BUILDER.tag, "sh", "x.sh"]);
	assert.ok(args(PY_BUILDER).includes("--read-only"), "and it is locked down either way");
});

test("Docker answering and a toolchain being built are separate questions", async () => {
	const asked: string[][] = [];
	const exec = async (_c: string, args: string[]) => {
		asked.push(args);
		if (args.includes("info")) return { code: 0, stdout: "27.0.0\n", stderr: "", timedOut: false };
		// Only the C builder exists here; the Python one has never been built.
		const found = args.includes(C_BUILDER.tag);
		return { code: found ? 0 : 1, stdout: found ? "sha256:1" : "", stderr: found ? "" : "No such image", timedOut: false };
	};
	const sandbox = new Sandbox(() => ({ docker: "docker", context: "" }), exec);
	const status = await sandbox.status();
	assert.deepEqual(status, { ok: true, server: "27.0.0" }, "up, and it does not claim to know about images");
	assert.equal(await sandbox.hasImage(C_BUILDER), true);
	assert.equal(await sandbox.hasImage(PY_BUILDER), false, "a toolchain nobody has needed yet is simply absent");
	assert.ok(asked.some((a) => a.includes("inspect") && a.includes(PY_BUILDER.tag)));
});

test("a toolchain is built from its own Dockerfile, under its own tag", async () => {
	const asked: string[][] = [];
	let dockerfile = "";
	const exec = async (_c: string, args: string[]) => {
		asked.push(args);
		const dir = args[args.length - 1];
		if (args.includes("build")) dockerfile = fs.readFileSync(path.join(dir, "Dockerfile"), "utf8");
		return { code: 0, stdout: "", stderr: "", timedOut: false };
	};
	const sandbox = new Sandbox(() => ({ docker: "docker", context: "" }), exec);
	const { parent } = scratch();
	await sandbox.buildImage(parent, PY_BUILDER);
	const build = asked.find((a) => a.includes("build"))!;
	assert.equal(build[build.indexOf("-t") + 1], PY_BUILDER.tag);
	assert.equal(dockerfile, PY_BUILDER.dockerfile, "its own, not the C builder's");
	assert.deepEqual(fs.readdirSync(parent), ["build"], "and the scratch copy is cleared away");
	fs.rmSync(parent, { recursive: true, force: true });
});

test("the kinds are one list, and the toolchains they need are counted once", () => {
	assert.deepEqual(KINDS.map((k) => k.kind), ["binary", "pwn"]);
	assert.deepEqual(KINDS.map((k) => k.tag), ["ctf", "pwn"]);
	// Both are C today, so there is one image to build, not two.
	assert.deepEqual(imagesNeeded().map((i) => i.tag), [C_BUILDER.tag]);
});

test("a lab is matched back to the kind that wrote it", () => {
	assert.equal(kindOf(labWith({ kind: "binary" }))?.tag, "ctf");
	assert.equal(kindOf(labWith({ kind: "pwn" }))?.tag, "pwn");
	assert.equal(kindOf(labWith({})), null, "a plain source lab was written by no kind");
});
