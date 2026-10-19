import { App, normalizePath } from "obsidian";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Lab, LabProgress } from "./types";
import { execFileSync } from "child_process";

/** Lowercase hex sha256 — how a flag is checked without ever storing it. */
export function hashFlag(flag: string): string {
	return createHash("sha256").update(normaliseFlag(flag)).digest("hex");
}

/** Trims and collapses whitespace so a pasted flag with stray spaces still works. */
export function normaliseFlag(flag: string): string {
	return String(flag).trim().replace(/\s+/g, "");
}

export function checkFlag(lab: Lab, submitted: string): boolean {
	if (!lab.flagHash) return false;
	return hashFlag(submitted) === lab.flagHash.toLowerCase();
}

/** The most words a lab hint may have: a nudge, not a step. */
export const HINT_MAX_WORDS = 12;

/**
 * Whether a hint reads like a CTF hint: a few words pointing at where to
 * look or which idea matters ("Mind the register width."), not a step to
 * follow or a value to copy. This is a backstop, not a judge of meaning:
 * the prompt asks for nudges, and this drops what is plainly not one — too
 * long, a value of four or more hex digits or six decimal ones, or a flag.
 */
export function isNudge(hint: string): boolean {
	const words = String(hint).trim().split(/\s+/).filter(Boolean);
	if (!words.length || words.length > HINT_MAX_WORDS) return false;
	return !/0x[0-9a-f]{4,}|\b\d{6,}\b|\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b|flag\{/i.test(hint);
}

/** Whether a hint gives this lab's flag away: some word in it is the flag. */
export function leaksFlag(lab: Lab, hint: string): boolean {
	return String(hint).split(/\s+/).some((w) => {
		const word = w.replace(/^[^\w{]+|[^\w}]+$/g, "");
		return word.length > 0 && checkFlag(lab, word);
	});
}

/** The hints that are nudges, at most `max` of them. */
export function nudges(hints: unknown, max = 3): string[] {
	return (Array.isArray(hints) ? hints : []).map((h) => String(h).trim()).filter(isNudge).slice(0, max);
}

/** Whether a lab's hints read like walkthrough steps, and are worth shortening. */
export function hintsNeedShortening(lab: Lab): boolean {
	return Array.isArray(lab.hints) && lab.hints.some((h) => !isNudge(h));
}

/**
 * How a lab hides its flag, as Claude reports it: bytes written in the file
 * (`cipher`), the bytes the learner works out (`key`, applied in turn and
 * repeated), and how one turns into the other. With it, a flag that is
 * properly hidden, XOR'd against a value the learner has to derive, can be
 * confirmed as solvable without running anything. It is checked and then
 * dropped, never stored: the key is the answer.
 */
export interface FlagCheck {
	op: "xor" | "add" | "sub";
	cipher: number[];
	key: number[];
}

/** A byte from Claude's JSON, which may come as 47, "47" or "0x2f". */
function byteOf(v: unknown): number | null {
	const n = typeof v === "string" ? Number(v.trim()) : v;
	return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
}

/** A well-formed check, or null. */
export function parseCheck(raw: unknown): FlagCheck | null {
	const c = raw as { op?: unknown; cipher?: unknown; key?: unknown } | null;
	if (!c || typeof c !== "object" || !["xor", "add", "sub"].includes(String(c.op))) return null;
	const bytes = (v: unknown) => {
		if (!Array.isArray(v) || !v.length) return null;
		const out = v.map(byteOf);
		return out.every((b): b is number => b !== null) ? out : null;
	};
	const cipher = bytes(c.cipher);
	const key = bytes(c.key);
	return cipher && key ? { op: String(c.op) as FlagCheck["op"], cipher, key } : null;
}

/** What a check's cipher becomes under its key: what the learner gets out. `add` and `sub` wrap at 256. */
export function decodeCheck(check: FlagCheck): string {
	return String.fromCharCode(...check.cipher.map((b, i) => {
		const k = check.key[i % check.key.length];
		return check.op === "xor" ? b ^ k : check.op === "add" ? (b + k) & 0xff : (b - k + 256) & 0xff;
	}));
}

/**
 * The numbers a source file writes, in order: 0x2f and \x2f, decimals, and
 * character literals such as 'f'. Enough to find a byte array or a string
 * of escapes, in C, Python, JavaScript or assembly.
 */
export function numbersIn(text: string): number[] {
	const out: number[] = [];
	for (const [t] of text.matchAll(/0x[0-9a-f]+|\\x[0-9a-f]{2}|'(?:\\.|[^'\\])'|\b\d+\b/gi)) {
		if (t.startsWith("'")) {
			const body = t.slice(1, -1);
			const escapes: Record<string, number> = { "\\n": 10, "\\t": 9, "\\0": 0, "\\\\": 92, "\\'": 39 };
			out.push(body.length === 1 ? body.charCodeAt(0) : escapes[body] ?? body.charCodeAt(1));
		} else if (/^\\x/i.test(t)) out.push(parseInt(t.slice(2), 16));
		else if (/^0x/i.test(t)) out.push(parseInt(t.slice(2), 16));
		else out.push(parseInt(t, 10));
	}
	return out;
}

/** Whether these bytes are written in the file, in order and unbroken: as numbers, or as one hex string. */
export function writtenInOrder(text: string, bytes: number[]): boolean {
	if (!bytes.length) return false;
	const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
	if (bytes.length >= 4 && text.toLowerCase().includes(hex)) return true;
	const nums = numbersIn(text);
	for (let i = 0; i + bytes.length <= nums.length; i++) {
		if (bytes.every((b, j) => nums[i + j] === b)) return true;
	}
	return false;
}

/**
 * Whether a lab's check shows its flag can be worked out from its file: the
 * cipher is written there and decodes to the flag, or to what is between
 * its braces. True when it does, null when there is no check, and otherwise
 * what is wrong with it.
 */
export function verifyCheck(raw: unknown, fileText: string, flag: string): true | string | null {
	if (raw === undefined || raw === null) return null;
	const check = parseCheck(raw);
	if (!check) return "its check is malformed";
	const out = decodeCheck(check);
	if (out !== flag && out !== flag.replace(/^flag\{|\}$/g, "")) return "its check does not decode to its flag";
	if (!writtenInOrder(fileText, check.cipher)) return "the bytes its check names are not in the file";
	return true;
}

/** A flag's character codes, to find it written as a byte array: whole, or just what is between its braces. */
export function flagCodes(flag: string): number[][] {
	const codes = (s: string) => [...s].map((c) => c.charCodeAt(0));
	return [codes(flag), codes(flag.replace(/^flag\{|\}$/g, ""))];
}

/** Rejects a lab that would be unusable or unsafe to hand over. */
export function validateLab(lab: Lab): string | null {
	if (!lab?.id) return "the lab has no id";
	if (!lab.brief?.trim()) return "the lab has no brief";
	if (!/^[0-9a-f]{64}$/i.test(lab.flagHash ?? "")) return "the lab has no valid flag hash";
	if (!Array.isArray(lab.files) || !lab.files.length) return "the lab has no files";

	for (const f of lab.files) {
		if (!f.path || typeof f.content !== "string") return "a lab file is malformed";
		// Nothing may escape the lab's own directory.
		const clean = f.path.replace(/\\/g, "/");
		if (clean.startsWith("/") || /^[a-z]:/i.test(clean) || clean.split("/").includes("..")) {
			return `lab file path "${f.path}" tries to escape the workspace`;
		}
	}
	lab.hints = Array.isArray(lab.hints) ? lab.hints.slice(0, 4) : [];
	lab.flagFormat = lab.flagFormat || "flag{...}";
	return null;
}

/**
 * Reads labs from the vault and lays their files out on disk. Nothing here
 * ever executes a lab's code: files are written, and the learner runs them.
 */
export class LabStore {
	constructor(
		private app: App,
		private labsFolder: () => string,
		private workspace: () => string
	) {}

	async list(): Promise<Lab[]> {
		const folder = normalizePath(this.labsFolder());
		const labs: Lab[] = [];
		for (const file of this.app.vault.getFiles()) {
			if (!file.path.startsWith(folder + "/") || file.extension !== "json") continue;
			try {
				const lab = JSON.parse(await this.app.vault.cachedRead(file)) as Lab;
				if (lab?.id && lab.flagHash) labs.push(lab);
			} catch (e) {
				console.error(`Recall Lab: could not parse lab ${file.path}`, e);
			}
		}
		return labs.sort((a, b) => a.title.localeCompare(b.title));
	}

	forNote(labs: Lab[], notePath: string): Lab[] {
		return labs.filter((l) => l.note === notePath);
	}

	/** Absolute path of a lab's workspace directory. */
	dir(lab: Lab): string {
		const root = this.workspace().replace(/^~(?=$|\/)/, os.homedir());
        return path.join(root, lab.id);
	}

	exists(lab: Lab): boolean {
		try {
			return fs.existsSync(this.dir(lab));
		} catch {
			return false;
		}
	}

	/** Writes the lab's files to disk. Returns the directory. */
	materialise(lab: Lab): string {
		const dir = this.dir(lab);
		fs.mkdirSync(dir, { recursive: true });

		for (const f of lab.files) {
			const target = path.join(dir, f.path);
			// Belt and braces: validateLab already rejected traversal, but the
			// resolved path is checked again before anything is written.
			if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) {
				throw new Error(`refusing to write outside the lab directory: ${f.path}`);
			}
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, f.content, "utf8");
			if (f.executable) fs.chmodSync(target, 0o755);
		}

		const brief = [
			`# ${lab.title}`,
			"",
			lab.brief,
			"",
			"## Getting started",
			"",
			"```bash",
			lab.setup.trim(),
			"```",
			"",
			`Submit the flag (\`${lab.flagFormat}\`) in Recall Lab.`,
			"",
			"---",
			"",
			"*Written by Recall Lab. Read any script before you run it.*",
		].join("\n");
		fs.writeFileSync(path.join(dir, "BRIEF.md"), brief, "utf8");
		return dir;
	}
}

/** Lab progress lives alongside quiz progress, keyed by lab id. */
export function blankProgress(labId: string): LabProgress {
	return { labId, attempts: 0, hintsUsed: 0, firstOpenedAt: new Date().toISOString() };
}


/**
 * What is actually installed. Labs that assume a Linux toolchain fail on
 * macOS — no gdb, and Apple's objdump rejects `-b binary` — so the generator
 * is told the truth rather than guessing.
 */
export interface Toolchain {
	found: string[];
	missing: string[];
	/** True when objdump is Apple's LLVM build, which cannot disassemble raw blobs. */
	appleObjdump: boolean;
}

const PROBE = ["gcc", "clang", "gdb", "lldb", "objdump", "otool", "python3", "nasm", "radare2", "rizin"];
let cached: Toolchain | null = null;

export function detectToolchain(): Toolchain {
	if (cached) return cached;
	const found: string[] = [];
	const missing: string[] = [];
	const which = process.platform === "win32" ? "where.exe" : "/usr/bin/which";
	for (const tool of PROBE) {
		try {
			execFileSync(which, [tool], { stdio: ["ignore", "pipe", "ignore"] });
			found.push(tool);
		} catch {
			missing.push(tool);
		}
	}
	let appleObjdump = false;
	if (found.includes("objdump")) {
		try {
			const v = execFileSync("objdump", ["--version"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
			appleObjdump = /Apple|LLVM/i.test(v);
		} catch {
			// leave it false; the prompt will simply not claim anything
		}
	}
	cached = { found, missing, appleObjdump };
	return cached;
}

/** A plain-English description of the toolchain, for the lab prompt. */
export function describeToolchain(t: Toolchain): string {
	const lines = [
		`Available: ${t.found.join(", ") || "(none detected)"}.`,
		`NOT installed, so never require them: ${t.missing.join(", ") || "(nothing)"}.`,
	];
	if (t.appleObjdump) {
		lines.push(
			"objdump is Apple's LLVM build: it REJECTS `-b binary` and `-m i386:x86-64`, so raw .bin blobs " +
				"cannot be disassembled with it. To make machine code readable, emit the bytes inside a C file " +
				"(e.g. a __attribute__((section)) array or inline asm), compile with gcc, and disassemble the " +
				"resulting object with plain `objdump -d --x86-asm-syntax=intel`."
		);
	}
	if (t.missing.includes("gdb") && t.found.includes("lldb")) {
		lines.push("There is no gdb. Use lldb: `lldb ./prog`, `b main`, `run`, `register read`, `p/x $rax`, `register write eax 0xff`.");
	}
	return lines.join(" ");
}
