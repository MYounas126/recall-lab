import { Bank, Question } from "./types";

/** A short stable id for a piece of text: 32-bit FNV-1a, as 8 hex digits. */
export function hashText(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/** The id of the pseudo-bank that holds a note's highlight questions. */
export function highlightBankId(path: string): string {
	return `hl:${path}`;
}

const HIGHLIGHT = /==([^=\n]+?)==/g;

/** Splits a line into sentences, each keeping its own punctuation. */
function sentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+(?=[A-Z0-9`*=[(])/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Turns ==highlighted== text in a note into fill-in-the-blank questions: one
 * per sentence holding a highlight, each highlight a blank. Made on the
 * device with no Claude involved, and rebuilt from the note every time. A
 * question's id comes from its text, so a sentence keeps its review history
 * from one session to the next, and editing it starts a fresh one.
 *
 * Skipped: frontmatter, fenced code, highlights shorter than 2 or longer than
 * 60 characters, and sentences with fewer than three words around the blanks
 * — too little to recall anything from.
 */
export function highlightQuestions(path: string, content: string): Question[] {
	const title = path.split("/").pop()!.replace(/\.md$/, "");
	const out: Question[] = [];
	const seen = new Set<string>();
	let heading = "";
	let inFence = false;

	const body = content.replace(/^---\n[\s\S]*?\n---\n/, "");
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		if (/^(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const h = /^#{1,6}\s+(.*)$/.exec(line);
		if (h) {
			heading = h[1].replace(HIGHLIGHT, "$1").trim();
			continue;
		}
		if (!line.includes("==")) continue;

		const text = line.replace(/^>\s*/, "").replace(/^([-*+]|\d+[.)])\s+/, "");
		for (const sentence of sentences(text)) {
			const blanks = [...sentence.matchAll(HIGHLIGHT)].map((m) => m[1].trim());
			if (!blanks.length || blanks.some((b) => b.length < 2 || b.length > 60)) continue;
			const cloze = sentence.replace(HIGHLIGHT, (_m, inner: string) => `{{${inner.trim()}}}`);
			const context = cloze.replace(/\{\{[^}]+\}\}/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
			if (context.split(" ").filter(Boolean).length < 3) continue;

			const id = `hl-${hashText(cloze)}`;
			if (seen.has(id)) continue;
			seen.add(id);
			out.push({
				id,
				tier: "easy",
				type: "cloze",
				topic: "highlights",
				prompt: "Fill in the blank.",
				cloze,
				explain: sentence.replace(HIGHLIGHT, "**$1**"),
				...(heading ? { ref: `${title}#${heading}` } : {}),
			});
		}
	}
	return out;
}

/** A note's highlight questions as a bank of their own; null if it has none. */
export function highlightBank(path: string, content: string): Bank | null {
	const questions = highlightQuestions(path, content);
	if (!questions.length) return null;
	const title = path.split("/").pop()!.replace(/\.md$/, "");
	return { id: highlightBankId(path), title: `Highlights · ${title}`, note: path, questions };
}
