import { Attempt, Confidence, qkey } from "./types";

export interface Calibration {
	level: Confidence;
	answers: number;
	right: number;
}

/**
 * How often you were right at each level of confidence you claimed: the
 * check on whether "sure" really means sure. Levels never used are left out.
 */
export function calibration(attempts: Attempt[]): Calibration[] {
	const levels: Confidence[] = ["sure", "unsure", "guess"];
	return levels
		.map((level) => {
			// A failed marking was never right or wrong, so it says nothing either way.
			const mine = attempts.filter((a) => a.confidence === level && a.gradedBy !== "error");
			return { level, answers: mine.length, right: mine.filter((a) => a.verdict === "correct").length };
		})
		.filter((c) => c.answers > 0);
}

/**
 * Every answer, indexed by question once so a lookup does not rescan the
 * whole history. Keyed by bank as well as question, because question ids
 * repeat from bank to bank: answering q1 in one bank says nothing about q1 in
 * another.
 */
export class AnswerIndex {
	private byKey = new Map<string, Attempt[]>();

	constructor(attempts: Attempt[]) {
		for (const a of attempts) {
			// A failed marking says nothing about what you know.
			if (a.gradedBy === "error") continue;
			const k = qkey(a.bankId, a.questionId);
			const list = this.byKey.get(k);
			if (list) list.push(a);
			else this.byKey.set(k, [a]);
		}
	}

	/** This question's answers, in the order they were given. */
	attempts(bankId: string, questionId: string): Attempt[] {
		return this.byKey.get(qkey(bankId, questionId)) ?? [];
	}

	/**
	 * Mastery of one question: the mean of its three most recent scores, so a
	 * lucky guess does not erase a history of getting it wrong. Null if it has
	 * never been answered.
	 */
	mastery(bankId: string, questionId: string): number | null {
		const last = this.attempts(bankId, questionId).slice(-3);
		if (!last.length) return null;
		return last.reduce((s, a) => s + a.score, 0) / last.length;
	}

	/** When this question was last answered, in ms since the epoch; 0 if never. */
	lastSeen(bankId: string, questionId: string): number {
		const list = this.attempts(bankId, questionId);
		return list.length ? Date.parse(list[list.length - 1].ts) : 0;
	}
}
