import { headingKey } from "./notemap";
import { TeachResult, Turn } from "./types";
import { textOf } from "./util";

/** The conversation so far, as the prompts show it. */
function transcript(turns: Turn[]): string {
	return turns.map((t) => `${t.who === "you" ? "TEACHER" : "STUDENT"}: ${t.text.trim()}`).join("\n\n");
}

/**
 * The prompt for the student's next reply. Claude plays a bright beginner
 * who has not read the note but, knowing what it covers, asks about exactly
 * what the explanation skipped, got vague, or got wrong. Pure, so it can be
 * tested.
 */
export function studentPrompt(title: string, content: string, turns: Turn[], questionsLeft: number): string {
	return [
		"You are playing a curious, bright beginner being taught a topic by a learner. Reply with ONLY a JSON",
		"object, no prose and no code fence.",
		"",
		"You have NOT read the note below; act as if you only know what the teacher has told you. But use the",
		"note to choose your question: ask about the most important thing their explanation so far skipped,",
		"left vague, or got wrong. Ask ONE short, natural question, the kind a real beginner would, in plain",
		"words. Never hint at the answer, never lecture, never correct them directly.",
		"",
		`You may ask ${questionsLeft} more question${questionsLeft === 1 ? "" : "s"}. If the explanation already covers the note's`,
		'key ideas well, say thanks briefly and set "done" to true instead of asking.',
		"",
		'SHAPE: {"reply":"<your question, or brief thanks>","done":false}',
		"",
		"CONVERSATION SO FAR:",
		transcript(turns),
		"",
		`NOTE TITLE: ${title}`,
		"NOTE CONTENT:",
		"---",
		content,
		"---",
	].join("\n");
}

/** The student's reply, or what is wrong with it. */
export function parseStudent(data: unknown): { reply: string; done: boolean } | string {
	const d = (data ?? {}) as { reply?: unknown; done?: unknown };
	const reply = typeof d.reply === "string" ? d.reply.trim() : "";
	if (!reply) return "the student said nothing";
	return { reply, done: d.done === true };
}

/** The prompt that scores the whole explanation against the note. Pure, so it can be tested. */
export function teachScorePrompt(title: string, content: string, turns: Turn[], sections: string[]): string {
	return [
		"A learner explained the note below to a beginner, answering the beginner's questions along the way.",
		"Score how well they covered it. Reply with ONLY a JSON object, no prose and no code fence.",
		"",
		"First list the note's KEY POINTS to yourself: the 5 to 12 ideas someone must grasp to understand it.",
		"Then decide which the teacher conveyed correctly anywhere in the conversation, in any words. A point",
		"stated wrongly counts as missed. Ignore the student's lines except as context.",
		"",
		'"score": the share of key points covered, 0-100. "feedback": two or three sentences addressed to the',
		'teacher as "you": what they explained well and the most important thing to work on. For each missed',
		'point, give "heading": the section of the note it comes from, exactly as listed below, or "" if none.',
		"",
		'SHAPE: {"score":70,"feedback":"...","covered":["<point>"],"missed":[{"point":"<point>","heading":"<section>"}]}',
		"",
		"SECTIONS:",
		...sections.map((s) => `- ${s}`),
		"",
		"CONVERSATION:",
		transcript(turns),
		"",
		`NOTE TITLE: ${title}`,
		"NOTE CONTENT:",
		"---",
		content,
		"---",
	].join("\n");
}

/**
 * The score of a teach-it-back, checked: the score is clamped (or worked out
 * from the points if missing), and a section named for a missed point is kept
 * only if the note really has it. Returns what is wrong as a string.
 */
export function parseTeachScore(data: unknown, sections: string[], note: string, turns: Turn[], now: Date): TeachResult | string {
	const d = (data ?? {}) as { score?: unknown; feedback?: unknown; covered?: unknown; missed?: unknown };
	const byKey = new Map(sections.map((s) => [headingKey(s), s]));
	// A point may come as a string or as {"point": "..."}, in either list.
	const pointOf = (m: unknown) => (typeof m === "string" ? m : textOf((m as { point?: unknown })?.point)).trim();
	const covered = Array.isArray(d.covered) ? d.covered.map(pointOf).filter(Boolean) : [];
	const missed = Array.isArray(d.missed)
		? d.missed
			.map((m) => {
				const point = pointOf(m);
				const raw = (m as { heading?: unknown })?.heading;
				const heading = typeof raw === "string" ? byKey.get(headingKey(raw)) : undefined;
				return point ? { point, ...(heading ? { heading } : {}) } : null;
			})
			.filter((m): m is { point: string; heading?: string } => m !== null)
		: [];
	if (!covered.length && !missed.length) return "it listed no key points";

	const given = Number(d.score);
	const score = Number.isFinite(given)
		? Math.max(0, Math.min(100, Math.round(given)))
		: Math.round((covered.length / (covered.length + missed.length)) * 100);
	return {
		note,
		at: now.toISOString(),
		score,
		feedback: typeof d.feedback === "string" ? d.feedback.trim() : "",
		covered,
		missed,
		turns: turns.filter((t) => t.who === "you").length,
	};
}
