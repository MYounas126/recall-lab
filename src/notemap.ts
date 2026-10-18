import { Memory, endOfDay } from "./memory";
import { Bank, qkey } from "./types";

/** How well you remember one section of a note: the questions whose `ref` points at its heading. */
export interface SectionMemory {
	questions: number;
	answered: number;
	/** Due by the end of today. */
	due: number;
	/** Mean expected score of the answered questions, 0–100; null if none answered. */
	score: number | null;
}

/** A note's memory at a glance, for its footer. */
export interface NoteMemory {
	questions: number;
	due: number;
	/** When any of its questions was last answered, in ms; null if never. */
	lastAnswered: number | null;
	sections: Map<string, SectionMemory>;
}

/**
 * A heading reduced to its words, so a `ref` written by the quiz generator
 * still finds the heading on the page: case, punctuation and markdown are
 * ignored, so "4.1 The **width** suffixes:" and "4.1 The width suffixes" match.
 */
export function headingKey(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The heading a `ref` points at: "03 Registers#4.1 Widths" → "4.1 Widths". Null if it names none. */
export function refHeading(ref: string | undefined): string | null {
	if (!ref || !ref.includes("#")) return null;
	const last = ref.slice(ref.lastIndexOf("#") + 1).trim();
	return last || null;
}

/**
 * The memory of one note, built from the banks that drill it. Each section is
 * found through its questions' `ref`; questions without one count toward the
 * note but no section.
 */
export function noteMemory(
	banks: Bank[],
	memory: Memory,
	scoreOf: (bankId: string, questionId: string) => number | null,
	lastSeen: (bankId: string, questionId: string) => number,
	now: Date
): NoteMemory {
	const today = endOfDay(now);
	const sections = new Map<string, { questions: number; answered: number; due: number; total: number }>();
	let questions = 0;
	let due = 0;
	let lastAnswered: number | null = null;

	for (const bank of banks) {
		for (const q of bank.questions) {
			const key = qkey(bank.id, q.id);
			const isDue = memory.isDue(key, today);
			const score = scoreOf(bank.id, q.id);
			const seen = lastSeen(bank.id, q.id);
			questions += 1;
			if (isDue) due += 1;
			if (seen && (lastAnswered === null || seen > lastAnswered)) lastAnswered = seen;

			const heading = refHeading(q.ref);
			if (!heading) continue;
			const k = headingKey(heading);
			const s = sections.get(k) ?? { questions: 0, answered: 0, due: 0, total: 0 };
			s.questions += 1;
			if (isDue) s.due += 1;
			if (score !== null) {
				s.answered += 1;
				s.total += score;
			}
			sections.set(k, s);
		}
	}

	const out = new Map<string, SectionMemory>();
	for (const [k, s] of sections) {
		out.set(k, {
			questions: s.questions,
			answered: s.answered,
			due: s.due,
			score: s.answered ? Math.round(s.total / s.answered) : null,
		});
	}
	return { questions, due, lastAnswered, sections: out };
}

/** The dot colour for a section: green from 80, amber from 50, red below; grey if never answered. */
export function dotLevel(score: number | null): "none" | "good" | "fair" | "poor" {
	if (score === null) return "none";
	if (score >= 80) return "good";
	if (score >= 50) return "fair";
	return "poor";
}

/** The tooltip on a heading's dot. */
export function describeSection(s: SectionMemory): string {
	const parts = [
		s.score === null ? "Not answered yet" : `Expected score ${s.score}%`,
		`${s.answered} of ${s.questions} question${s.questions === 1 ? "" : "s"} answered`,
	];
	if (s.due) parts.push(`${s.due} due today`);
	return parts.join(" · ");
}
