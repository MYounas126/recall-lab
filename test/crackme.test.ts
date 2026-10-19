import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
	MARK, SOLVE_INPUT, buildScript, challengeProblem, crackmePrompt, parseBuild, parseBuildOutput,
} from "../src/crackme";
import { BUILDER_IMAGE, Sandbox, runArgs } from "../src/sandbox";
import { LabStore, hashFlag } from "../src/labs";
import { Tasks } from "../src/tasks";
import type { Course, Lab } from "../src/types";
import { makeVault } from "./helpers";

const course: Course = { id: "arch", title: "Arch", folder: "Arch", axes: [{ id: "regs", label: "Registers" }] };
const build = { cflags: ["-O2", "-s"], output: "crackme" };

// ------------------------------------------------------------- the prompt

test("the prompt asks for the note's own subject matter, and rules out a password compare", () => {
	const p = crackmePrompt("08 Function Parameters", "RCX, RDX, R8, R9.", course, "hard", []);
	assert.match(p, /COMPILED x86-64 Linux binary/);
	assert.match(p, /NOT ALLOWED: comparing the input against a stored password, serial or flag/);
	assert.match(p, /must exercise THIS NOTE'S subject matter/);
	assert.match(p, /NEVER EXIST AS A LITERAL STRING IN THE BINARY/);
	assert.match(p, /a transformation you must invert/i, "the hard tier's shape");
	assert.match(p, /RCX, RDX, R8, R9\./, "the note itself");
});

test("each tier asks for a different kind of work, and repeats are steered away from", () => {
	const of = (tier: "easy" | "hard" | "brutal", avoid: string[] = []) => crackmePrompt("N", "c", course, tier, avoid);
	assert.match(of("easy"), /EASY — one mechanism/);
	assert.match(of("hard"), /HARD — a transformation/);
	assert.match(of("brutal"), /bytecode interpreter/);
	assert.ok(!of("easy").includes("bytecode interpreter"), "one tier's shape at a time");
	assert.match(of("hard", ["Widths", "Home Slots"]), /Already used for this note.*Widths; Home Slots/);
});

// -------------------------------------------------------- the build spec

test("a build spec is accepted only if it compiles one plain file name with safe flags", () => {
	assert.deepEqual(parseBuild({ cflags: ["-O2", "-s", "-no-pie"], output: "crackme" }), { cflags: ["-O2", "-s", "-no-pie"], output: "crackme" });
	assert.deepEqual(parseBuild({ output: "crackme" }), { cflags: [], output: "crackme" });
	assert.match(String(parseBuild({ output: "../escape" })), /not a plain file name/);
	assert.match(String(parseBuild({ output: "a/b" })), /not a plain file name/);
	assert.match(String(parseBuild({ output: "" })), /not a plain file name/);
	assert.match(String(parseBuild(null)), /without build settings/);
	for (const bad of ["-I/etc", "-L/usr/lib", "-lcrypto", "-Wl,-rpath", "-o"]) {
		assert.match(String(parseBuild({ output: "c", cflags: [bad] })), /reach outside the build/, bad);
	}
	assert.match(String(parseBuild({ output: "c", cflags: ["rm -rf /"] })), /which is not a flag/);
});

test("the build script compiles, lists the binary's strings, then runs it on the intended input", () => {
	const s = buildScript(["src/crackme.c"], build);
	assert.match(s, /gcc '-O2' '-s' -o 'crackme' 'src\/crackme\.c'/);
	assert.ok(s.indexOf(MARK.strings) < s.indexOf(MARK.run), "strings before the run");
	assert.match(s, new RegExp(`timeout 10 \\./'crackme' < '${SOLVE_INPUT}'`));
	// Nothing is compared in the container, so the flag never goes into it.
	assert.ok(!s.includes("grep"), "the plugin does the judging, outside");
	assert.match(buildScript(["a b.c"], { ...build, output: "it's" }), /'a b\.c'/, "names with spaces survive");
});

test("the build output is split into its sections", () => {
	const out = parseBuildOutput(`junk\n${MARK.strings}\n/lib64/ld\nGCC\n${MARK.run}\nflag{x}\n${MARK.exit}0===\n`);
	assert.match(out.strings, /\/lib64\/ld/);
	assert.equal(out.run.trim(), "flag{x}");
	assert.equal(out.exit, 0);
	assert.equal(parseBuildOutput("gcc: error: no such file").exit, null, "a build that never ran");
});

// ------------------------------------------------- is it worth handing over?

const good = { strings: "/lib64/ld-linux\nGCC: (Debian)\nNope.", run: "flag{w1dth_m4tt3rs}\n", exit: 0 };

test("a challenge is kept only if the intended input prints the flag and `strings` does not", () => {
	const flag = "flag{w1dth_m4tt3rs}";
	assert.equal(challengeProblem(good, flag), null);
	assert.equal(challengeProblem({ ...good, run: "w1dth_m4tt3rs\n" }, flag), null, "the flag without its wrapper counts");
	assert.match(String(challengeProblem({ ...good, exit: null }, flag)), /did not build/);
	assert.match(String(challengeProblem({ ...good, exit: 1 }, flag)), /exited with status 1/);
	assert.match(String(challengeProblem({ ...good, run: "Nope.\n" }, flag)), /did not print the flag/);
	assert.match(String(challengeProblem({ ...good, strings: `GCC\n${flag}` }, flag)), /readable with `strings`/);
	assert.match(String(challengeProblem({ ...good, strings: "GCC\nw1dth_m4tt3rs" }, flag)), /readable with `strings`/);
});

// ------------------------------------------------------------ the sandbox

test("a challenge is built with no network, a read-only system and no privileges", () => {
	const args = runArgs("colima-ctf", "job", "/Users/me/RecallLab/labs/.build/c-1", ["sh", "build.sh"]);
	const after = (flag: string) => args[args.indexOf(flag) + 1];
	assert.deepEqual(args.slice(0, 2), ["--context", "colima-ctf"]);
	assert.equal(after("--network"), "none");
	assert.ok(args.includes("--read-only"));
	assert.equal(after("--cap-drop"), "ALL");
	assert.equal(after("--security-opt"), "no-new-privileges");
	assert.equal(after("--platform"), "linux/amd64", "x86-64, whatever the host is");
	assert.equal(after("--memory"), "512m");
	assert.equal(after("-v"), "/Users/me/RecallLab/labs/.build/c-1:/work", "only the build directory");
	assert.deepEqual(args.slice(-3), [BUILDER_IMAGE, "sh", "build.sh"]);
	assert.ok(!runArgs("", "job", "/w", ["sh"]).includes("--context"), "blank means the current context");
});

// -------------------------------------------------------- writing one end to end

/** Docker, as far as these tests are concerned: it builds, and reports what the script would. */
function fakeDocker(report: { strings?: string; run?: string; exit?: number; writeBinary?: boolean } = {}) {
	const calls: string[][] = [];
	const exec = async (_cmd: string, args: string[]) => {
		calls.push(args);
		if (args.includes("info")) return { code: 0, stdout: "27.0.0", stderr: "", timedOut: false };
		if (args.includes("inspect")) return { code: 0, stdout: "sha256:1", stderr: "", timedOut: false };
		const work = (args[args.indexOf("-v") + 1] ?? "").split(":")[0];
		if (report.writeBinary !== false) fs.writeFileSync(path.join(work, build.output), "ELF");
		const stdout = [
			MARK.strings, report.strings ?? "/lib64/ld-linux\nGCC: (Debian)",
			MARK.run, report.run ?? "flag{w1dth_m4tt3rs}",
			`${MARK.exit}${report.exit ?? 0}===`,
		].join("\n");
		return { code: 0, stdout, stderr: "", timedOut: false };
	};
	return { exec, calls };
}

const CHALLENGE = {
	title: "Widths and Windows", tier: "hard", axis: "regs", minutes: 45,
	brief: "Recover the flag.", files: [{ path: "src/crackme.c", content: "int main(void){return 0;}" }],
	build, solve: { stdin: "5eed1234\n" }, hints: ["Mind the register width."],
	flag: "flag{w1dth_m4tt3rs}", flagFormat: "flag{...}", solution: "Invert the keystream.",
};

async function writeChallenge(reply: unknown, report?: Parameters<typeof fakeDocker>[0]) {
	const vault = makeVault(0);
	vault.files.set("Arch/08 Function Parameters.md", "# Parameters\nRCX, RDX, R8, R9.");
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rl-labs-"));
	const app = { vault } as never;
	const labs = new LabStore(app, () => "_quiz/labs", () => workspace);
	const docker = fakeDocker(report);
	const sandbox = new Sandbox(() => ({ docker: "docker", context: "" }), docker.exec);
	const cli = { askJson: async () => ({ ok: true, data: reply }) };
	const tasks = new Tasks(app, cli as never, {} as never, () => "normal", () => "_quiz/banks", () => "_quiz/courses", () => "_quiz/labs", sandbox, labs);
	const res = await tasks.generateCrackme("Arch/08 Function Parameters.md", course, "hard");
	return { res, vault, workspace, labs, docker };
}

test("a challenge that builds and solves is saved, and the binary is left ready to pick up", async () => {
	const { res, vault, workspace } = await writeChallenge(CHALLENGE);
	assert.ok(!("error" in res), JSON.stringify(res));
	const lab = res as Lab;
	assert.equal(lab.kind, "binary");
	assert.deepEqual(lab.build, build);
	assert.equal(lab.flagHash, hashFlag("flag{w1dth_m4tt3rs}"));
	assert.equal(lab.tier, "hard", "the tier asked for, not the one it claimed");

	const saved = JSON.parse(vault.files.get(`_quiz/labs/${lab.id}.json`)!) as Lab & { solve?: unknown };
	assert.equal(saved.solve, undefined, "the input that solves it is the answer, so it is not stored");
	assert.ok(!JSON.stringify(saved).includes("w1dth_m4tt3rs"), "nor is the flag");
	assert.equal(saved.files[0].content, "int main(void){return 0;}", "the source is kept, to rebuild and to explain");

	const dir = path.join(workspace, lab.id);
	assert.ok(fs.existsSync(path.join(dir, "crackme")), "the binary is on disk");
	assert.match(fs.readFileSync(path.join(dir, "BRIEF.md"), "utf8"), /reads from stdin/);
	fs.rmSync(workspace, { recursive: true, force: true });
});

test("the source and the input that solves it go into the build, and nothing else does", async () => {
	const { docker, workspace } = await writeChallenge(CHALLENGE);
	const run = docker.calls.find((a) => a.includes("--network"))!;
	assert.ok(run.includes("none"));
	const work = run[run.indexOf("-v") + 1].split(":")[0];
	assert.ok(work.includes(".build"), "built under the workspace, where Docker can reach it");
	assert.ok(!fs.existsSync(work), "and cleared away afterwards");
	fs.rmSync(workspace, { recursive: true, force: true });
});

test("a challenge is refused when it cannot be built, solved, or kept from `strings`", async () => {
	const cases: [string, Parameters<typeof fakeDocker>[0], RegExp][] = [
		["it never compiled", { exit: undefined, writeBinary: false, run: "", strings: "" }, /did not print the flag/],
		["the input does not solve it", { run: "Nope.", exit: 1 }, /exited with status 1/],
		["the flag is readable", { strings: "GCC\nflag{w1dth_m4tt3rs}" }, /readable with `strings`/],
	];
	for (const [name, report, expected] of cases) {
		const { res, workspace } = await writeChallenge(CHALLENGE, report);
		assert.ok("error" in res, name);
		assert.match((res as { error: string }).error, expected, name);
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("a reply missing what a challenge needs is refused before anything is built", async () => {
	const without = async (drop: Record<string, unknown>) => {
		const { res, workspace } = await writeChallenge({ ...CHALLENGE, ...drop });
		fs.rmSync(workspace, { recursive: true, force: true });
		return "error" in res ? res.error : "accepted";
	};
	assert.match(await without({ flag: undefined }), /without a flag/);
	assert.match(await without({ solve: undefined }), /without the input that solves it/);
	assert.match(await without({ files: [] }), /without source/);
	assert.match(await without({ build: { output: "../x" } }), /not a plain file name/);
	assert.match(await without({ title: "flag{w1dth_m4tt3rs} is it" }), /still shows its flag/);
});

test("a brief that mentions the flag has it taken out rather than being thrown away", async () => {
	const { res, workspace } = await writeChallenge({ ...CHALLENGE, brief: "It prints flag{w1dth_m4tt3rs} when happy." });
	assert.ok(!("error" in res), JSON.stringify(res));
	assert.equal((res as Lab).brief, "It prints `flag{...}` when happy.");
	fs.rmSync(workspace, { recursive: true, force: true });
});
