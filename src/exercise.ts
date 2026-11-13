import * as fs from "fs";
import * as nodePath from "path";
import { Course, Lab, LabBuild, LabFile, LabKind, Tier } from "./types";
import { SandboxImage } from "./sandbox";

/**
 * One verified exercise, whatever kind it is.
 *
 * Every challenge Recall Lab writes goes through the same loop: ask Claude
 * for one, prepare what the sandbox needs, build and check it in a throwaway
 * container, and keep it only if the check says it is sound. Reversing and
 * exploitation challenges differ only in what they ask for and what counts
 * as sound — the loop around them is identical, and it is written once here.
 *
 * A new kind of exercise is an ExerciseKind, not another copy of the loop.
 * What a kind must answer:
 *
 *   - what toolchain it is built in              image
 *   - what to ask Claude for                     prompt()
 *   - what the sandbox needs on disk             prepare()
 *   - whether what came back is worth keeping    verdict()
 *   - what the learner is told at the end        footer()
 *
 * Everything else — reading the note, validating the flag, naming the lab,
 * redacting the answer, guarding the build directory, running the container,
 * clearing up — belongs to the loop and is the same for all of them.
 */

/** The script every kind's check is written to, inside the build directory. */
export const CHECK_SCRIPT = "check.sh";

/**
 * What came back from Claude. A Lab's own fields are known; a kind's extra
 * ones (the input that solves it, the program's name) are its business, so
 * they arrive untyped and each kind validates its own in prepare().
 */
export type ExerciseReply = Partial<Lab> & { flag?: string } & Record<string, unknown>;

/** Everything the sandbox needs to build and check one challenge. */
export interface Prepared {
	/** How it is compiled, and the file the learner is handed. */
	build: LabBuild;
	/** Files the check needs beside the source, as path to contents. */
	inputs: Record<string, string>;
	/** The script that builds it and proves it is sound. */
	script: string;
}

/** What the check said, read by the kind that wrote the script. */
export interface CheckVerdict {
	/** Why it is not worth handing over, or null when it is. */
	problem: string | null;
	/**
	 * Whether the script got far enough that the compiler is not the story.
	 * When it did not, the loop adds the compiler's last words to the reason,
	 * because "it did not build" on its own explains nothing.
	 */
	compiled: boolean;
}

export interface ExerciseKind {
	/** What the finished lab is, which decides how the view treats it. */
	kind: LabKind;
	/**
	 * The toolchain it is built in. A kind that needs a compiler the C
	 * builder does not have declares its own image here, and only a vault
	 * that builds that kind ever downloads it.
	 */
	image: SandboxImage;
	/** The short tag in a lab's id, such as `ctf` or `pwn`. */
	tag: string;
	/** What the loop calls this when it fails, e.g. "build and run". */
	verb: string;
	/** How long the whole build-and-check run may take. */
	timeoutMs: number;
	/** The prompt that asks for exactly one challenge of this kind. */
	prompt(title: string, content: string, course: Course, tier: Tier, avoid: string[]): string;
	/** Everything the sandbox needs, or the reason the reply cannot be used. */
	prepare(reply: ExerciseReply, sources: LabFile[], tier: Tier): Prepared | string;
	/** Reads the check's output and decides. */
	verdict(stdout: string, flag: string, tier: Tier): CheckVerdict;
	/** What is appended to the brief, once the file is on the learner's machine. */
	footer(lab: Lab, tier: Tier): string;
}

/**
 * Writes a challenge's source into the build directory.
 *
 * A path in the reply is not trusted: `../` in one would put a file outside
 * the directory that is about to be mounted into the container, so every
 * path is resolved and checked before anything is written. Returns the
 * reason it refused, or null.
 */
export function writeSources(work: string, files: LabFile[]): string | null {
	const root = nodePath.resolve(work) + nodePath.sep;
	for (const f of files) {
		const target = nodePath.join(work, f.path);
		if (!nodePath.resolve(target).startsWith(root)) {
			return `its source path "${f.path}" tries to escape the build`;
		}
		fs.mkdirSync(nodePath.dirname(target), { recursive: true });
		fs.writeFileSync(target, f.content, "utf8");
	}
	return null;
}

/** The files a kind asked for beside the source, written the same guarded way. */
export function writeInputs(work: string, inputs: Record<string, string>): string | null {
	return writeSources(work, Object.entries(inputs).map(([path, content]) => ({ path, content })));
}

/**
 * Takes the flag out of everything shown before the challenge is solved.
 *
 * The title is deliberately left alone: a flag in the title means the
 * challenge itself is wrong, and showsFlag() is what catches that.
 */
export function redact(lab: Lab, flag: string): void {
	const shown = `\`${lab.flagFormat}\``;
	const out = (text: string) => text.split(flag).join(shown);
	lab.brief = out(lab.brief);
	lab.solution = out(lab.solution);
	lab.hints = lab.hints.map(out);
}

/**
 * Whether anything the learner sees before solving still gives the answer
 * away. Run this over what is left after redacting and trimming, not over
 * the original: what matters is what actually reaches the page.
 */
export function showsFlag(lab: Lab, flag: string): boolean {
	return [lab.brief, ...lab.hints, lab.title].join("\n").includes(flag);
}

/** The last thing a failed build said, short enough to read in a notice. */
export function lastWords(run: { stdout: string; stderr: string }, lines = 3): string {
	return (run.stderr || run.stdout).trim().split("\n").slice(-lines).join(" ").slice(0, 300);
}

/** A plain file name, with nothing in it that could point somewhere else. */
export function plainName(name: string): boolean {
	return /^[A-Za-z0-9._-]{1,64}$/.test(name) && !name.startsWith(".");
}
