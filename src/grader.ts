import { Question, Verdict } from "./types";

export interface LocalResult {
	score: number;
	verdict: Verdict;
	feedback: string;
	missing: string[];
}

/** Marks the question types that need no help from Claude. */
export function gradeLocally(q: Question, response: string, chosen: number[]): LocalResult | null {
	switch (q.type) {
		case "mcq":
			return gradeMcq(q, chosen);
		case "multi":
			return gradeMulti(q, chosen);
		case "short":
		case "command":
			return gradeByPattern(q, response);
		default:
			return null;
	}
}

function gradeMcq(q: Question, chosen: number[]): LocalResult {
	const correct = typeof q.answer === "number" ? q.answer : -1;
	const picked = chosen[0];
	const ok = picked === correct;
	return {
		score: ok ? 100 : 0,
		verdict: ok ? "correct" : "incorrect",
		feedback: ok ? "" : `The answer is **${q.choices?.[correct] ?? "—"}**.`,
		missing: ok ? [] : [q.topic],
	};
}

/**
 * Select-all is marked by Jaccard overlap, so picking three of four right
 * options scores better than picking one right and one wrong — but anything
 * short of the exact set is still "partial", never "correct".
 */
function gradeMulti(q: Question, chosen: number[]): LocalResult {
	const want = new Set(Array.isArray(q.answer) ? q.answer : []);
	const got = new Set(chosen);
	const hits = [...got].filter((i) => want.has(i)).length;
	const union = new Set([...want, ...got]).size || 1;
	const score = Math.round((hits / union) * 100);
	const exact = score === 100;
	const missedIdx = [...want].filter((i) => !got.has(i));
	const wrongIdx = [...got].filter((i) => !want.has(i));

	const parts: string[] = [];
	if (missedIdx.length) parts.push(`missed ${missedIdx.map((i) => `**${q.choices?.[i]}**`).join(", ")}`);
	if (wrongIdx.length) parts.push(`wrongly picked ${wrongIdx.map((i) => `**${q.choices?.[i]}**`).join(", ")}`);

	return {
		score,
		verdict: exact ? "correct" : score > 0 ? "partial" : "incorrect",
		feedback: exact ? "" : `You ${parts.join(" and ")}.`,
		missing: exact ? [] : [q.topic],
	};
}

/**
 * Fast path for written answers: if the response matches one of the bank's
 * accept patterns it is right, and Claude is never troubled. Returns null when
 * there is no match, which sends the answer to the grading queue instead of
 * marking it wrong — a correct answer phrased unusually must not be failed by
 * a regex.
 */
function gradeByPattern(q: Question, response: string): LocalResult | null {
	const text = normalise(response);
	if (!text) {
		return {
			score: 0,
			verdict: "incorrect",
			feedback: "You left this blank.",
			missing: [q.topic],
		};
	}
	for (const pattern of q.accept ?? []) {
		try {
			if (new RegExp(pattern, "i").test(text)) {
				return { score: 100, verdict: "correct", feedback: "", missing: [] };
			}
		} catch (e) {
			console.error(`Recall Lab: bad accept pattern on ${q.id}: ${pattern}`, e);
		}
	}
	return null;
}

/** Collapses whitespace so `mov  eax,0` and `mov eax, 0` compare equal. */
export function normalise(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}
