import { Attempt, Bank, Question } from "./types";

/**
 * Whether a problem is walked through its steps before being asked whole:
 * it has steps, and is new to you or was not right last time. Once you get
 * it right it is asked unaided, as the steps are scaffolding, not the test.
 */
export function needsGuidance(q: Question, history: Attempt[]): boolean {
	if (!q.steps?.length) return false;
	const last = history[history.length - 1];
	return !last || last.verdict !== "correct";
}

/** Per bank, its brutal problems with no guided steps yet: what a steps run would write for. */
export function needingSteps(banks: Bank[]): { bank: Bank; questions: Question[] }[] {
	return banks
		.map((bank) => ({ bank, questions: bank.questions.filter((q) => q.tier === "brutal" && !q.steps?.length) }))
		.filter((b) => b.questions.length > 0);
}
