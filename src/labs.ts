import { App, TFile, normalizePath } from "obsidian";
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
		if (clean.startsWith("/") || clean.split("/").includes("..")) {
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
	for (const tool of PROBE) {
		try {
			execFileSync("/usr/bin/which", [tool], { stdio: ["ignore", "pipe", "ignore"] });
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
