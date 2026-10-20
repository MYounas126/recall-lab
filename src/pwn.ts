import { Course, Tier } from "./types";

/**
 * Exploitation challenges: a vulnerable x86-64 Linux program with a bug you
 * reach from stdin, and a win path that prints the flag. You write the
 * exploit yourself, in your own VM, with your own tools.
 *
 * Recall Lab never writes or runs an exploit. It checks the challenge is
 * sound the way a build does: the program compiles, keeps its flag out of
 * the binary, stays quiet on ordinary input, has the win path you are meant
 * to reach, and really does have the bug — which a sanitizer build reports
 * when the probe input runs through it.
 */

/** The marker lines the check script prints between its sections. */
export const SECTIONS = ["strings", "benign", "symbols", "sanitizer", "elf"] as const;
export type Section = (typeof SECTIONS)[number];
const mark = (s: string) => `===RL-${s.toUpperCase()}===`;

/** Where the two inputs are written, beside the source. */
export const BENIGN_INPUT = "benign.in";
export const PROBE_INPUT = "probe.in";

/**
 * How each tier is compiled. Recall Lab chooses this, not the generator, so
 * a tier always means the same thing and the protections are never a
 * surprise. Symbols are kept: a pwn binary you cannot find `win` in is a
 * reversing exercise wearing the wrong hat. -O0 keeps the frame layout
 * plain and stops the bug being optimised away.
 */
export const PWN_CFLAGS: Record<Tier, string[]> = {
	easy: ["-O0", "-fno-stack-protector", "-no-pie", "-w"],
	hard: ["-O0", "-fno-stack-protector", "-pie", "-fPIE", "-w"],
	brutal: ["-O0", "-fstack-protector-strong", "-pie", "-fPIE", "-Wl,-z,relro,-z,now", "-w"],
};

/** What those flags leave you facing, in words, for the brief and the lab page. */
export const PWN_PROTECTIONS: Record<Tier, string> = {
	easy: "NX on, no stack canary, no PIE — fixed addresses.",
	hard: "NX on, no stack canary, PIE — addresses move, so you need a leak.",
	brutal: "NX on, stack canary, PIE and full RELRO — the canary and the leak are both your problem.",
};

/** What each tier should make you work for. */
const TIER_SHAPE: Record<Tier, string> = {
	easy:
		"EASY — one plain overflow. A fixed-size buffer on the stack, read into with a length that is simply " +
		"too big. Nothing stands between the buffer and the saved return address.",
	hard:
		"HARD — an overflow you have to set up for. The bug is reachable but needs thought: a length " +
		"computed wrongly, an off-by-one, a loop bound taken from the input, or a second pass over the " +
		"buffer. Give the program something that prints back out, so a leak is possible.",
	brutal:
		"BRUTAL — an overflow guarded by a canary, behind a program that has to be driven. Several " +
		"interactions before the bug is reachable, and something readable that an attacker could use to " +
		"learn what they need. Do not weaken the guard; leave it to be worked around.",
};

/**
 * The prompt that produces one exploitation challenge. It asks for a
 * vulnerable program built on the note's own material, and for the two
 * inputs Recall Lab needs to check it: an ordinary one, and one that trips
 * the bug. It is never asked for an exploit.
 */
export function pwnPrompt(title: string, content: string, course: Course, tier: Tier, avoid: string[]): string {
	return [
		"Write ONE exploitation challenge for the note below. Reply with ONLY a JSON object, no prose, no fence.",
		"",
		"The learner is handed a COMPILED x86-64 Linux binary with symbols. It has a memory-safety bug they",
		"reach through stdin, and a `win` function that prints the flag but is never called on any normal",
		"path. Their job is to make it run. They write the exploit themselves; you do not.",
		"",
		TIER_SHAPE[tier],
		"",
		"RULES",
		"- The program must exercise THIS NOTE'S subject matter — the stack frame, saved registers, calling",
		"  convention, local layout, whatever the note is about — so that it rewards having understood it.",
		"- The bug is a MEMORY-SAFETY bug on the stack: a buffer written past its end. It must be reachable",
		"  from stdin alone. No other bug class: Recall Lab proves the bug is really there by building the",
		"  program with a sanitizer and feeding it `probe`, and a sanitizer only sees memory errors.",
		"- `win` decodes and prints the flag and is NEVER reached on a normal run. Nothing else prints it.",
		"- THE FLAG MUST NEVER EXIST AS A LITERAL STRING IN THE BINARY. Write it as constant expressions and",
		"  let the compiler encode it:  static const unsigned char enc[] = { 'f'^0x5a, 'l'^0x5a, ... };",
		"  `win` undoes that when it runs. `strings` must show nothing, and Recall Lab checks.",
		"- YOU CANNOT RUN ANYTHING while you write this: no shell, no python, no compiler. Work it out in",
		"  the reply, and use the constant-expression trick above rather than precomputing bytes by hand.",
		"- Do NOT choose the compiler flags or weaken any protection. Recall Lab compiles every challenge of",
		"  this tier the same way, and the protections are part of the difficulty:",
		`      ${PWN_PROTECTIONS[tier]}`,
		"- Do NOT put addresses, offsets or buffer distances in the brief, the hints or the solution's",
		"  opening. Finding them is the exercise.",
		"- Single C file, standard library only. No network, no files, no randomness, no sleeps.",
		"- Invent a distinct random flag, formatted flag{...} with 8-20 characters inside.",
		...(avoid.length ? ["- Already used for this note, so do something else: " + avoid.join("; ") + "."] : []),
		"",
		"FIELDS",
		"- `files`: exactly one entry, the C source.",
		"- `output`: the program's file name, e.g. `stack`.",
		"- `benign.stdin`: ordinary input a careful user would type. The program must handle it, print no",
		"  flag, and exit 0.",
		"- `probe.stdin`: input that runs past the end of the buffer — a long run of the same character is",
		"  usually enough. This is only so the sanitizer build can confirm the bug exists. It is NOT an",
		"  exploit, and nothing is expected to be hijacked by it.",
		"- `brief`: what they are given and what done looks like. No addresses, no offsets.",
		"- `hints`: three nudges, each at most 8 words, pointing at where to look.",
		"- `solution`: how it was meant to go, shown only once they finish or give up.",
		"",
		"SHAPE",
		'{"title":"<short name>","tier":"' + tier + '","axis":"<axis id>","minutes":60,',
		' "brief":"<markdown>","files":[{"path":"src/pwn.c","content":"<full C source>"}],"output":"stack",',
		' "benign":{"stdin":"Alice\\n"},"probe":{"stdin":"AAAAAAAA...\\n"},',
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

/**
 * The script that builds a challenge and checks it, run inside the sandbox.
 * It compiles the challenge as its tier is compiled, lists its strings, runs
 * it on ordinary input, lists its symbols, builds a second copy with the
 * address sanitizer and runs the probe through that, and reports what the
 * ELF headers say about its protections. Nothing is compared in here: the
 * plugin reads the output and judges, so the flag never enters the container.
 */
export function checkScript(sources: string[], output: string, tier: Tier): string {
	const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	const src = sources.map(q).join(" ");
	return [
		"set -eu",
		`gcc ${PWN_CFLAGS[tier].map(q).join(" ")} -o ${q(output)} ${src}`,
		`echo ${q(mark("strings"))}`,
		`strings -a ${q(output)} || true`,
		`echo ${q(mark("benign"))}`,
		"set +e",
		`timeout 10 ./${q(output)} < ${q(BENIGN_INPUT)} 2>&1; echo "[exit:$?]"`,
		`echo ${q(mark("symbols"))}`,
		`nm ${q(output)} 2>/dev/null | awk '{print $NF}' || true`,
		`echo ${q(mark("sanitizer"))}`,
		// A second build, only to confirm the bug is real. It is never handed over.
		`gcc -O0 -g -fsanitize=address -fno-omit-frame-pointer -w -o probe_build ${src} 2>&1`,
		`ASAN_OPTIONS=detect_leaks=0 timeout 20 ./probe_build < ${q(PROBE_INPUT)} 2>&1 | head -40`,
		`echo ${q(mark("elf"))}`,
		`readelf -lWd ${q(output)} 2>/dev/null | grep -E 'GNU_STACK|GNU_RELRO|BIND_NOW|Type:' || true`,
		`readelf -hW ${q(output)} 2>/dev/null | grep -E '^\\s*Type:' || true`,
	].join("\n");
}

export type CheckOutput = Record<Section, string>;

/** Splits the check script's output into its sections. */
export function parseCheck(stdout: string): CheckOutput {
	const out = {} as CheckOutput;
	for (let i = 0; i < SECTIONS.length; i++) {
		const after = stdout.split(mark(SECTIONS[i]))[1] ?? "";
		const next = SECTIONS[i + 1];
		out[SECTIONS[i]] = next ? (after.split(mark(next))[0] ?? "") : after;
	}
	return out;
}

/** What the protections should look like in the ELF, for the tier we compiled for. */
function protectionProblem(elf: string, symbols: string, tier: Tier): string | null {
	if (/GNU_STACK/.test(elf) && /GNU_STACK\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+RWE/.test(elf)) {
		return "its stack came out executable, which is not what any tier asks for";
	}
	const pie = /Type:\s+DYN/.test(elf);
	const canary = /__stack_chk_fail/.test(symbols);
	if (tier === "easy" && (pie || canary)) return "it was meant to have no PIE and no canary";
	if (tier === "hard" && (!pie || canary)) return "it was meant to have PIE and no canary";
	if (tier === "brutal" && (!pie || !canary)) return "it was meant to have PIE and a canary";
	return null;
}

/**
 * Whether a built challenge is one worth handing over. Returns the reason it
 * is not, or null when it is.
 */
export function challengeProblem(out: CheckOutput, flag: string, tier: Tier): string | null {
	const bare = flag.replace(/^flag\{|\}$/g, "");
	const leaks = (text: string) => text.includes(flag) || (bare.length >= 6 && text.includes(bare));
	if (!out.strings && !out.benign) return "it did not build";
	if (leaks(out.strings)) return "its flag is readable with `strings`, so there is nothing to exploit";
	if (leaks(out.benign)) return "it prints the flag on ordinary input, so there is nothing to do";
	if (!/\[exit:0\]/.test(out.benign)) return "it does not survive ordinary input, so there is nothing to work from";
	if (!/\bwin\b/.test(out.symbols)) return "it has no `win` symbol to aim at";
	if (!/AddressSanitizer|ERROR: AddressSanitizer/.test(out.sanitizer)) {
		return "the probe input did not trip the bug, so there may be no bug to exploit";
	}
	if (!/stack-buffer-overflow|dynamic-stack-buffer-overflow|stack-buffer-underflow/.test(out.sanitizer)) {
		const kind = /ERROR: AddressSanitizer: ([a-z-]+)/.exec(out.sanitizer)?.[1] ?? "something else";
		return `the bug is ${kind}, not a stack buffer overflow`;
	}
	return protectionProblem(out.elf, out.symbols, tier);
}

/** What the learner is told, once the binary is on their machine. */
export function briefFooter(output: string, flagFormat: string, tier: Tier): string {
	return [
		"",
		"---",
		"",
		`You are given one x86-64 Linux binary, \`${output}\`, with symbols. It reads from stdin. Somewhere in`,
		"it is a `win` function that prints the flag and is never called on its own. Reach it.",
		"",
		`Built with: ${PWN_PROTECTIONS[tier]}`,
		"",
		`Submit the flag (\`${flagFormat}\`) in Recall Lab.`,
	].join("\n");
}
