import { AnswerIndex } from "./history";
import { Attempt, Bank, ExamItem, Question } from "./types";

/**
 * A question is mature once its last two answers were both right, and not
 * guesses. By then its look — the option's position, its wording — can carry
 * the answer on its own, so a variant tests the idea better than the original.
 */
export function isMature(history: Attempt[]): boolean {
	const last = history.slice(-2);
	return last.length === 2 && last.every((a) => a.verdict === "correct" && a.confidence !== "guess");
}

/**
 * The variant to ask in place of a mature question: the one asked longest
 * ago, or never. Null to ask the original — when it is not mature yet, or
 * has no variants.
 */
export function pickVariant(q: Question, history: Attempt[]): Question | null {
	if (!q.variants?.length || !isMature(history)) return null;
	const lastAsked = new Map<string, number>();
	for (const a of history) if (a.variant) lastAsked.set(a.variant, Date.parse(a.ts));
	return q.variants.slice().sort((a, b) => (lastAsked.get(a.id) ?? 0) - (lastAsked.get(b.id) ?? 0))[0];
}

/**
 * Swaps each mature question for its next variant. The item keeps the
 * original's id in `of`, so the answer is recorded, and scheduled, under it.
 */
export function withVariants(items: ExamItem[], index: AnswerIndex): ExamItem[] {
	return items.map((it) => {
		const v = pickVariant(it.q, index.attempts(it.bankId, it.q.id));
		return v ? { bankId: it.bankId, q: v, of: it.q.id } : it;
	});
}

/** Per bank, its mature questions with no variants yet: what a variants run would write for. */
export function needingVariants(banks: Bank[], index: AnswerIndex): { bank: Bank; questions: Question[] }[] {
	return banks
		.map((bank) => ({
			bank,
			questions: bank.questions.filter((q) => !q.variants?.length && isMature(index.attempts(bank.id, q.id))),
		}))
		.filter((b) => b.questions.length > 0);
}
