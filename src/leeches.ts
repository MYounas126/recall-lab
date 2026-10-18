import { AnswerIndex } from "./history";
import { isMature } from "./variants";
import { Attempt, Bank, ExamItem, qkey } from "./types";

/** A question you keep missing. */
export interface Leech {
	item: ExamItem;
	key: string;
	misses: number;
	/** Your most recent wrong answers to it, newest last. */
	wrong: Attempt[];
}

/**
 * Questions missed at least `threshold` times that you have not since put
 * right twice running. Missing one that often is a misunderstanding, not
 * forgetting, and more reviews will not fix it. Most missed first.
 */
export function findLeeches(banks: Bank[], index: AnswerIndex, threshold: number): Leech[] {
	const out: Leech[] = [];
	for (const bank of banks) {
		for (const q of bank.questions) {
			const history = index.attempts(bank.id, q.id);
			const wrong = history.filter((a) => a.verdict === "incorrect");
			if (wrong.length < threshold || isMature(history)) continue;
			out.push({ item: { bankId: bank.id, q }, key: qkey(bank.id, q.id), misses: wrong.length, wrong: wrong.slice(-6) });
		}
	}
	return out.sort((a, b) => b.misses - a.misses);
}
