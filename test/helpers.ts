import { TFile, TFolder } from "./obsidian-shim";
import type { Attempt, Question } from "../src/types";

/** A multiple-choice question whose first option is right. */
export function question(id: string, extra: Partial<Question> = {}): Question {
	return {
		id, tier: "easy", type: "mcq", topic: "t", prompt: `Question ${id}`,
		choices: ["right", "wrong"], answer: 0, explain: "", axis: "a1", ...extra,
	};
}

/** One recorded answer; the verdict follows the score the way marking does. */
export function attempt(
	bankId: string, questionId: string, score: number,
	ts = "2026-10-01T09:00:00.000Z", extra: Partial<Attempt> = {}
): Attempt {
	return {
		ts, sessionId: "s", bankId, questionId, tier: "easy", type: "mcq", topic: "t",
		response: "", score, verdict: score >= 90 ? "correct" : score >= 40 ? "partial" : "incorrect",
		feedback: "", missing: [], gradedBy: "local", ms: 5000, ...extra,
	};
}

/**
 * An in-memory vault. Reads and writes take real time, so concurrent
 * read-modify-writes interleave the way they can inside Obsidian.
 */
export function makeVault(delayMs = 5) {
	const files = new Map<string, string>();
	const folders = new Set<string>();
	const sleep = () => new Promise((r) => setTimeout(r, delayMs));
	return {
		files,
		getAbstractFileByPath(p: string) {
			if (files.has(p)) return new TFile(p);
			if (folders.has(p)) return new TFolder(p);
			return null;
		},
		getFiles() {
			return [...files.keys()].map((p) => new TFile(p));
		},
		getMarkdownFiles() {
			return [...files.keys()].filter((p) => p.endsWith(".md")).map((p) => new TFile(p));
		},
		async read(f: TFile) {
			await sleep();
			return files.get(f.path) ?? "";
		},
		async cachedRead(f: TFile) {
			await sleep();
			return files.get(f.path) ?? "";
		},
		async modify(f: TFile, body: string) {
			await sleep();
			files.set(f.path, body);
		},
		/** Reads, changes and writes with nothing in between, as Obsidian's does. */
		async process(f: TFile, fn: (data: string) => string) {
			await sleep();
			const next = fn(files.get(f.path) ?? "");
			files.set(f.path, next);
			return next;
		},
		async create(p: string, body: string) {
			await sleep();
			if (files.has(p)) throw new Error(`File already exists: ${p}`);
			files.set(p, body);
			return new TFile(p);
		},
		async createFolder(p: string) {
			folders.add(p);
		},
	};
}

/** Records the DOM a renderer builds through Obsidian's createDiv/createSvg helpers. */
export class MockEl {
	children: MockEl[] = [];
	attrs: Record<string, string> = {};
	cls: string[] = [];
	textContent: string | null = null;

	constructor(public tag: string) {}

	createDiv(o?: { cls?: string; text?: string }): MockEl {
		const e = new MockEl("div");
		if (o?.cls) e.cls.push(...o.cls.split(" "));
		if (o?.text) e.textContent = o.text;
		this.children.push(e);
		return e;
	}

	createSvg(tag: string, o?: { cls?: string | string[]; attr?: Record<string, unknown> }): MockEl {
		const e = new MockEl(tag);
		// As in Obsidian: SVG classes go through classList.add, one token each.
		if (o?.cls) e.addClass(...(Array.isArray(o.cls) ? o.cls : [o.cls]));
		for (const [k, v] of Object.entries(o?.attr ?? {})) e.attrs[k] = String(v);
		this.children.push(e);
		return e;
	}

	addClass(...tokens: string[]): void {
		for (const t of tokens) {
			if (/\s/.test(t)) throw new Error(`InvalidCharacterError: the token ('${t}') contains HTML space characters`);
			this.cls.push(t);
		}
	}

	/** Every element below this one, depth first. */
	all(): MockEl[] {
		return this.children.flatMap((c) => [c, ...c.all()]);
	}
}
