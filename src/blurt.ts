import { AnswerIndex } from "./history";
import { headingKey, refHeading } from "./notemap";
import { Store } from "./store";
import { BlurtResult, ExamItem } from "./types";

/** The headings of a note, in order, outside frontmatter and code. */
export function headingsOf(content: string): string[] {
	const out: string[] = [];
	let inFence = false;
	for (const raw of content.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n")) {
		const line = raw.trim();
		if (/^(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		const h = inFence ? null : /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
		if (h) out.push(h[1].trim());
	}
	return out;
}

/** The prompt that compares what you wrote from memory with the note. Pure, so it can be tested. */
export function blurtPrompt(title: string, content: string, written: string, sections: string[]): string {
	return [
		"A learner wrote down everything they could remember about a note, from memory, before being quizzed.",
		"Compare it with the note. Reply with ONLY a JSON object, no prose and no code fence.",
		"",
		"For each section of the note, listed below, decide whether they recalled its main idea. A section counts",
		"as covered when its main idea is there in any words; small details do not matter. For each section left",
		"out, give in one short line its main point: the thing they should have remembered.",
		"",
		'Then "score": the share of the note\'s important content they recalled, 0-100. And "feedback": two or three',
		'sentences addressed to them as "you": what they recalled well, and the biggest gap.',
		"",
		"Use the section names exactly as listed.",
		"",
		'SHAPE: {"score":62,"feedback":"...","covered":["<section>"],"missed":[{"heading":"<section>","point":"<one line>"}]}',
		"",
		"SECTIONS:",
		...sections.map((s) => `- ${s}`),
		"",
		"WHAT THEY WROTE FROM MEMORY:",
		"---",
		written.trim() || "(nothing)",
		"---",
		"",
		`NOTE TITLE: ${title}`,
		"NOTE CONTENT:",
		"---",
		content,
		"---",
	].join("\n");
}

/**
 * Checks Claude's comparison against the note's real sections: a section it
 * names that the note does not have is dropped, and a missing score is
 * worked out from the sections covered. Returns what is wrong as a string.
 */
export function parseBlurt(data: unknown, sections: string[], note: string, now: Date): BlurtResult | string {
	const d = (data ?? {}) as { score?: unknown; feedback?: unknown; covered?: unknown; missed?: unknown };
	const byKey = new Map(sections.map((s) => [headingKey(s), s]));
	const known = (h: unknown) => (typeof h === "string" ? byKey.get(headingKey(h)) : undefined);

	const covered = Array.isArray(d.covered) ? d.covered.map(known).filter((h): h is string => Boolean(h)) : [];
	const missed = Array.isArray(d.missed)
		? d.missed
			.map((m) => {
				const heading = known((m as { heading?: unknown })?.heading);
				const point = String((m as { point?: unknown })?.point ?? "").trim();
				return heading ? { heading, point } : null;
			})
			.filter((m): m is { heading: string; point: string } => m !== null)
		: [];
	if (!covered.length && !missed.length) return "it named none of the note's sections";

	const given = Number(d.score);
	const score = Number.isFinite(given)
		? Math.max(0, Math.min(100, Math.round(given)))
		: Math.round((covered.length / (covered.length + missed.length)) * 100);
	return {
		note,
		at: now.toISOString(),
		score,
		feedback: typeof d.feedback === "string" ? d.feedback.trim() : "",
		covered: [...new Set(covered)],
		missed,
	};
}

/**
 * The exam after a write-it-down: questions from the sections you left out
 * come first, then the usual pick fills the rest.
 */
export function blurtExam(items: ExamItem[], index: AnswerIndex, total: number, missed: string[]): ExamItem[] {
	const left = new Set(missed.map(headingKey));
	const first = items.filter((it) => {
		const h = refHeading(it.q.ref);
		return h !== null && left.has(headingKey(h));
	});
	const taken = new Set(first);
	const rest = items.filter((it) => !taken.has(it));
	const want = Math.max(0, total - first.length);
	const picked = Store.pickExam(rest, index, want);
	// pickExam passes a thin tier's shortfall only to harder tiers, so a small
	// paper can come up short; top it up from what is left.
	const chosen = new Set(picked);
	const topUp = rest.filter((it) => !chosen.has(it)).slice(0, want - picked.length);
	return [...first, ...picked, ...topUp].slice(0, total);
}
