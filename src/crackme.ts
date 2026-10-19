import { Course, Lab, LabBuild, Tier } from "./types";
import { textOf } from "./util";

/**
 * Binary challenges: a compiled x86-64 program you reverse, the way a CTF
 * hands you one. The source is never shown until you have solved it or given
 * up — the binary is the challenge.
 *
 * This module holds the parts that are pure, so they can be tested: the
 * prompt that asks for a challenge, the checks on what comes back, and the
 * script that builds it and proves it can be solved.
 */

/** The marker lines the build script prints between its sections. */
export const MARK = { strings: "===RL-STRINGS===", run: "===RL-RUN===", exit: "===RL-EXIT:" } as const;

/** The file the intended input is written to, beside the source. */
export const SOLVE_INPUT = "solve.in";

/** Compiler flags a challenge may not set: they would reach outside the build. */
const BANNED_FLAGS = /^-(?:I|L|l|B|include|isystem|specs|fplugin|Wl,|Xlinker|o$)/;

/** What each tier's challenge should ask of you. */
const TIER_SHAPE: Record<Tier, string> = {
	easy:
		"EASY — one mechanism, done properly. The flag is computed by a chain of operations whose exact " +
		"widths and orders matter (partial-register writes, zero- versus sign-extension, endianness, a " +
		"table lookup whose index you must follow). Reading the disassembly carefully is the whole task.",
	hard:
		"HARD — a transformation you must invert. A hand-rolled encoding over the flag's bytes: a key " +
		"schedule derived from constants, rotations and nibble swaps, a substitution table built at run " +
		"time, or a decoder that reads its own compact instruction encoding. Untangling obfuscated " +
		"control flow (opaque predicates, a computed jump table) belongs here too.",
	brutal:
		"BRUTAL — several stages, and no hand-holding. A bytecode interpreter with a dispatch loop running " +
		"an embedded program that builds the flag, so you reverse the machine and then its program; or a " +
		"stage whose output keys the next; or code that decodes a buffer at run time before interpreting " +
		"it. Expect the learner to spend real time in a disassembler and a debugger.",
};

/**
 * The prompt that produces one binary challenge. It asks for the kind of
 * reversing a CTF asks for — the mechanics of the note, exercised through a
 * program you have to understand — rather than a password compared against a
 * stored string.
 */
export function crackmePrompt(
	title: string,
	content: string,
	course: Course,
	tier: Tier,
	avoid: string[]
): string {
	return [
		"Write ONE reverse-engineering CTF challenge for the note below. Reply with ONLY a JSON object, no prose, no fence.",
		"",
		"The learner is handed a COMPILED x86-64 Linux binary and nothing else. They open it in a",
		"disassembler and a debugger, work out what it does, and recover a flag. They never see your source.",
		"",
		TIER_SHAPE[tier],
		"",
		"RULES",
		"- The challenge must exercise THIS NOTE'S subject matter. The reversing work should be the note's",
		"  ideas made concrete, so that someone who has understood the note can get there and someone who",
		"  has not, cannot.",
		"- NOT ALLOWED: comparing the input against a stored password, serial or flag with strcmp, memcmp or",
		"  a character loop. A challenge whose answer can be found by reading one string or one constant is",
		"  worthless. The work must be deriving the answer from a mechanism you implement.",
		"- The program reads input on stdin and prints the flag ONLY when that input is correct. Everything",
		"  else prints a refusal. The point is that working out the correct input requires reversing.",
		"- THE FLAG MUST NEVER EXIST AS A LITERAL STRING IN THE BINARY, not in a comment, a usage message or",
		"  a check. It is computed at run time from values the learner has to understand. `strings` must",
		"  reveal nothing. Recall Lab checks this and throws the challenge away if it fails.",
		"- Single C file, standard library only, no network, no files, no /proc, no time or randomness: the",
		"  same input must always give the same result, on any machine.",
		"- It must finish promptly. No sleeps, no loops that run for minutes.",
		"- Invent a distinct random flag, formatted flag{...} with 8-20 characters inside.",
		...(avoid.length
			? ["- Already used for this note, so do something else: " + avoid.join("; ") + "."]
			: []),
		"",
		"FIELDS",
		"- `files`: exactly one entry, the C source. Write it as a challenge author would: the structure",
		"  should be interesting in the disassembly, not just in the source.",
		"- `build.cflags`: how it should be compiled. `-O2 -s` to strip symbols and make it a real reversing",
		"  job; add `-no-pie` if fixed addresses suit the challenge. No -I, -L, -l or -o.",
		"- `build.output`: the program's file name, e.g. `crackme`.",
		"- `solve.stdin`: exactly what the learner must type to make it print the flag. Recall Lab runs the",
		"  built program with this and refuses the challenge unless the flag appears.",
		"- `brief`: what they are given and what done looks like. It must not give away the mechanism.",
		"- `hints`: three nudges, each at most 8 words, pointing at where to look. Never a value or a step.",
		"- `solution`: the full walkthrough, shown only after they solve it or give up.",
		"",
		"SHAPE",
		'{"title":"<short name>","tier":"' + tier + '","axis":"<axis id>","minutes":45,',
		' "brief":"<markdown>","files":[{"path":"src/crackme.c","content":"<full C source>"}],',
		' "build":{"cflags":["-O2","-s"],"output":"crackme"},"solve":{"stdin":"<the correct input>"},',
		' "hints":["...","...","..."],"flag":"flag{...}","flagFormat":"flag{...}","solution":"<markdown>"}',
		"",
		`Use an axis id from: ${course.axes.map((a) => a.id).join(", ")}`,
		"",
		`NOTE TITLE: ${title}`,
		"NOTE CONTENT:",
		"---",
		content,
		"---",
	].join("\n");
}

/** A build spec that is safe to compile, or the reason it is not. */
export function parseBuild(raw: unknown): LabBuild | string {
	const b = raw as { cflags?: unknown; output?: unknown } | null;
	if (!b || typeof b !== "object") return "it came back without build settings";
	const output = textOf(b.output).trim();
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(output) || output.startsWith(".")) return "its output name is not a plain file name";
	const cflags = Array.isArray(b.cflags) ? b.cflags.map((f) => String(f).trim()).filter(Boolean) : [];
	if (cflags.length > 24) return "it asks for too many compiler flags";
	for (const f of cflags) {
		if (!f.startsWith("-")) return `its compiler flags include "${f.slice(0, 24)}", which is not a flag`;
		if (BANNED_FLAGS.test(f)) return `its compiler flags include "${f.slice(0, 24)}", which could reach outside the build`;
	}
	return { cflags, output };
}

/**
 * The script that builds a challenge and proves it can be solved, run inside
 * the sandbox. It compiles the source, lists every string in the binary, then
 * runs it once on the intended input. The plugin reads the output and decides:
 * nothing is compared in here, so the flag never enters the container.
 */
export function buildScript(sources: string[], build: LabBuild): string {
	const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	return [
		"set -eu",
		`gcc ${build.cflags.map(quote).join(" ")} -o ${quote(build.output)} ${sources.map(quote).join(" ")}`,
		`echo ${quote(MARK.strings)}`,
		`strings -a ${quote(build.output)} || true`,
		`echo ${quote(MARK.run)}`,
		`set +e`,
		`timeout 10 ./${quote(build.output)} < ${quote(SOLVE_INPUT)} 2>&1`,
		`echo "${MARK.exit}$?==="`,
	].join("\n");
}

export interface BuildOutput {
	/** Every string in the built binary. */
	strings: string;
	/** What the program printed on the intended input. */
	run: string;
	/** Its exit status, or null if the script never got that far. */
	exit: number | null;
}

/** Splits the build script's output into its sections. */
export function parseBuildOutput(stdout: string): BuildOutput {
	const afterStrings = stdout.split(MARK.strings)[1] ?? "";
	const [strings, rest = ""] = afterStrings.split(MARK.run);
	const at = rest.lastIndexOf(MARK.exit);
	const exit = at < 0 ? null : Number.parseInt(rest.slice(at + MARK.exit.length), 10);
	return {
		strings: strings ?? "",
		run: at < 0 ? rest : rest.slice(0, at),
		exit: Number.isInteger(exit) ? exit : null,
	};
}

/**
 * Whether a built challenge is one worth handing over: it printed the flag on
 * the intended input, and the flag is nowhere in the binary as plain text.
 * Returns the reason it is not, or null when it is.
 */
export function challengeProblem(out: BuildOutput, flag: string): string | null {
	const bare = flag.replace(/^flag\{|\}$/g, "");
	if (out.exit === null) return "it did not build";
	if (out.exit !== 0) return `it exited with status ${out.exit} on the input that should solve it`;
	if (!out.run.includes(flag) && !out.run.includes(bare)) return "the input that should solve it did not print the flag";
	if (out.strings.includes(flag) || (bare.length >= 6 && out.strings.includes(bare))) {
		return "its flag is readable with `strings`, so there is nothing to reverse";
	}
	return null;
}

/** What the learner is told to do with the binary, once it is on their machine. */
export function briefFooter(lab: Lab): string {
	return [
		"",
		"---",
		"",
		`You are given one x86-64 Linux binary, \`${lab.build?.output ?? "the challenge"}\`. It reads from stdin`,
		"and prints the flag only when the input is right. Work out what it wants.",
		"",
		`Submit the flag (\`${lab.flagFormat}\`) in Recall Lab.`,
	].join("\n");
}
