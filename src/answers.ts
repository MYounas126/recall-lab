import { Response } from "./grader";
import { Question } from "./types";
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


/** Markdown reduced to plain text, for places that cannot render it, such as a dropdown. */
export function plain(text: string): string {
	return text.replace(/[`*_]|\[\[|\]\]/g, "");
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
