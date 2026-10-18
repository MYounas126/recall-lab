import { Response, clozePieces } from "./grader";
import { Attempt, Question } from "./types";
import { shuffled } from "./util";

/**
 * An answer while it is being given, for every question type. The parts the
 * marker reads come from Response; the rest only the screen needs.
 */
export interface AnswerState extends Response {
	/** An image answer, as a data URL. */
	image?: string;
	/** Typed from memory before the options were shown, in recall-first mode. */
	recalled?: string;
	/** trace: how many steps have been checked. */
	traceChecked?: number;
}

/** Why an answer cannot be submitted yet, or null if it can. */
export function notReady(q: Question, s: AnswerState): string | null {
	if ((q.type === "mcq" || q.type === "multi") && !s.chosen.length) return "Pick an answer first.";
	if (q.type === "hotspot" && !s.chosen.length) return "Click a line first.";
	if (q.type === "trace" && (s.traceChecked ?? 0) < (q.trace?.length ?? 0)) return "Check every step first.";
	return null;
}

/** An answer as a line of text, for the record and for Claude's coaching. */
export function describeResponse(q: Question, s: AnswerState): string {
	switch (q.type) {
		case "mcq":
		case "multi":
			return s.chosen.map((i) => q.choices?.[i] ?? "").join(" | ");
		case "hotspot":
			return s.chosen.length ? `line ${s.chosen.slice().sort((a, b) => a - b).join(", ")}` : "";
		case "order":
			return (s.order ?? []).map((i) => q.items?.[i] ?? "").join(" → ");
		case "match":
			return (q.pairs ?? [])
				.map(([left], i) => `${left} → ${(s.matches?.[i] ?? -1) >= 0 ? q.pairs![s.matches![i]][1] : "?"}`)
				.join("; ");
		case "cloze":
			return (s.blanks ?? []).join(" | ");
		case "trace":
			return (q.trace ?? [])
				.map((step, i) => `line ${step.line}: ${Object.keys(step.expect).map((n, k) => `${n}=${s.cells?.[i]?.[k] ?? ""}`).join(", ")}`)
				.join("; ");
		default:
			return s.text;
	}
}


/**
 * A question in one line, for lists. A cloze shows its sentence with the
 * blanks empty, since its prompt is only ever "Fill in the blank."; any
 * other type shows the first line of its prompt.
 */
export function questionLine(q: Question): string {
	if (q.type === "cloze" && q.cloze) return clozePieces(q.cloze).join("＿＿＿");
	return q.prompt.split("\n")[0];
}

/**
 * What the question gives you to work with, beyond its prompt and code, as
 * markdown: a cloze's sentence, an order question's steps and a match
 * question's left-hand items, the last two alphabetically so as not to
 * give the answer away.
 */
export function questionDetail(q: Question): string {
	const sorted = (xs: string[]) => xs.slice().sort((a, b) => plain(a).localeCompare(plain(b)));
	if (q.type === "cloze" && q.cloze) return clozePieces(q.cloze).join("＿＿＿");
	if (q.type === "order" && q.items?.length) return sorted(q.items).map((it) => `- ${it}`).join("\n");
	if (q.type === "match" && q.pairs?.length) return sorted(q.pairs.map(([left]) => left)).map((it) => `- ${it}`).join("\n");
	return "";
}

/**
 * Whose answer this was, when not the question's own: a variant asked in its
 * place, or the leech clinic's practice question. Null for the question itself.
 */
export function answeredTo(a: Attempt): "variant" | "practice" | null {
	if (!a.variant) return null;
	return a.variant.endsWith("~fix") ? "practice" : "variant";
}

/** Inline code spans: a run of backticks, the code, and the same run again. */
const CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

/**
 * Markdown reduced to the text it shows, for places that cannot render it,
 * such as a dropdown or a blank's answer. Code keeps its contents, a link
 * its text, and emphasis markers go only where they pair up, so PROT_EXEC
 * and `*rsp` stay as written.
 */
export function plain(text: string): string {
	const code: string[] = [];
	const masked = text.replace(CODE_SPAN, (_m, _ticks: string, inner: string) => {
		code.push(inner.trim());
		return `\uE000${code.length - 1}\uE001`;
	});
	const shown = masked
		.replace(/!?\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
		.replace(/!?\[\[([^\]]*)\]\]/g, (_m, target: string) => target.replace(/#\^?/g, " > "))
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
		.replace(/(?<!\*)\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/g, "$1")
		.replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}_])/gu, "$1")
		.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
		.replace(/==(?=\S)([\s\S]*?\S)==/g, "$1");
	return shown.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => code[Number(i)]);
}

/** The positions 0…n-1 in a random order other than the right one, when there is another. */
export function scrambled(n: number): number[] {
	const ids = Array.from({ length: n }, (_, i) => i);
	for (let tries = 0; tries < 10; tries++) {
		const s = shuffled(ids);
		if (n < 2 || s.some((v, i) => v !== i)) return s;
	}
	return ids.reverse();
}

/** A blank's width in characters, rounded up so it does not give the answer's length away. */
export function blankSize(answers: string[]): number {
	const longest = Math.max(...answers.map((a) => a.length));
	return longest <= 6 ? 8 : longest <= 12 ? 14 : 22;
}
