import { Bank, Question } from "./types";
import { plain } from "./answers";
import { hashText } from "./util";

/** The id of the pseudo-bank that holds a note's highlight questions. */
export function highlightBankId(path: string): string {
	return `hl:${path}`;
}

/** Whether a bank is a note's highlight questions rather than a quiz. */
export function isHighlightBank(bankId: string): boolean {
	return bankId.startsWith("hl:");
}

/**
 * A highlight as Obsidian draws one: no space just inside either ==, so
 * `a == b` in prose or base64 padding (`a2V5==`) is not a highlight. Run on
 * text with its code spans masked, so code such as `0 == '0'` never is.
 */
const HIGHLIGHT = /(?<![=\\])==(?=[^\s=])([^=\n]*?[^\s=])==(?!=)/g;

/** Inline code spans; masked while looking for highlights. */
const CODE_SPAN = /(`+)([^`]|[^`].*?[^`])\1(?!`)/g;

/** Splits a line into sentences, each keeping its own punctuation. */
function sentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+(?=[A-Z0-9`*=[(\uE004])/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Turns ==highlighted== text in a note into fill-in-the-blank questions: one
 * per sentence holding a highlight, each highlight a blank whose answer is
 * the text as it shows (`**RAX**` is answered RAX). Made on the device with
 * no Claude involved, and rebuilt from the note every time. A question's id
 * comes from its text, so a sentence keeps its review history from one
 * session to the next, and editing it starts a fresh one.
 *
 * Skipped: frontmatter, fenced code, table rows, highlights shorter than 2
 * or longer than 60 characters, sentences holding {, } or | (which would
 * break the blanks), and sentences with fewer than three words around the
 * blanks — too little to recall anything from.
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
		if (!line.includes("==") || line.startsWith("|")) continue;

		const text = line
			.replace(/^(>\s*)+/, "") // quotes and callouts, however deep
			.replace(/^\[![^\]]*\][+-]?\s*/, "") // a callout's [!type]
			.replace(/^([-*+]|\d+[.)])\s+/, "")
			.replace(/^\[[ xX]\]\s+/, ""); // a task's box
		// Code spans are set aside so nothing in them reads as a highlight.
		const spans: string[] = [];
		const masked = text.replace(CODE_SPAN, (m) => {
			spans.push(m);
			return `\uE004${spans.length - 1}\uE005`;
		});
		const unmask = (s: string) => s.replace(/\uE004(\d+)\uE005/g, (_m, i: string) => spans[Number(i)]);

		for (const sentence of sentences(masked)) {
			const blanks = [...sentence.matchAll(HIGHLIGHT)].map((m) => plain(unmask(m[1])).trim());
			if (!blanks.length || blanks.some((b) => b.length < 2 || b.length > 60)) continue;
			// The sentence as it shows, blanks aside; code keeps its backticks
			// so it is still drawn as code.
			let k = 0;
			const around = unmask(plain(sentence.replace(HIGHLIGHT, () => `\uE002${k++}\uE003`)));
			if (/[{}|]/.test(around) || blanks.some((b) => /[{}|]/.test(b))) continue;
			const cloze = around.replace(/\uE002(\d+)\uE003/g, (_m, i: string) => `{{${blanks[Number(i)]}}}`);
			const context = around.replace(/\uE002\d+\uE003/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
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
				explain: around.replace(/\uE002(\d+)\uE003/g, (_m, i: string) => `**${blanks[Number(i)]}**`),
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
