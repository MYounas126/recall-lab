import { AnswerIndex } from "./history";
import { headingKey, refHeading } from "./notemap";
import { Store } from "./store";
import { BlurtResult, ExamItem } from "./types";

export interface Heading {
	text: string;
	level: number;
}

/**
 * The headings of a note, in order, as Obsidian reads them: not in
 * frontmatter (even an empty one), fenced or indented code, or %% comments,
 * and a closing run of # only when a space comes before it, so "Why C#"
 * keeps its #. Obsidian's own metadata cache is preferred where there is one;
 * this is for when there is not.
 */
export function headingsOf(content: string): Heading[] {
	const lines = content.replace(/\r\n?/g, "\n").split("\n");
	let i = 0;
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((l, k) => k > 0 && /^(---|\.\.\.)\s*$/.test(l));
		if (end > 0) i = end + 1;
	}
	const out: Heading[] = [];
	let fence: string | null = null;
	let comment = false;
	for (; i < lines.length; i++) {
		const raw = lines[i];
		const line = raw.trim();
		if (fence) {
			if (line.startsWith(fence)) fence = null;
			continue;
		}
		const open = /^(`{3,}|~{3,})/.exec(line);
		if (open) {
			fence = open[1];
			continue;
		}
		// %% opens and closes a comment, which may run over several lines.
		if ((line.match(/%%/g) ?? []).length % 2 === 1) {
			comment = !comment;
			continue;
		}
		if (comment || /^( {4}|\t)/.test(raw)) continue;
		const h = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
		if (h) out.push({ text: h[2].trim(), level: h[1].length });
	}
	return out;
}

export interface Section {
	/** Unique within the note: "Flags > Example" where two headings read "Example". */
	name: string;
	/** Where it is, as a heading link: "Example", or "Flags#Example" for a repeated heading. */
	link: string;
}

/**
 * A note's sections, each with a name of its own. A heading used more than
 * once is named, and linked, through the heading above it, so two
 * "Example" sections stay two.
 */
export function sectionsOf(headings: Heading[]): Section[] {
	const uses = new Map<string, number>();
	for (const h of headings) uses.set(headingKey(h.text), (uses.get(headingKey(h.text)) ?? 0) + 1);
	const above: Heading[] = [];
	const taken = new Set<string>();
	const out: Section[] = [];
	for (const h of headings) {
		while (above.length && above[above.length - 1].level >= h.level) above.pop();
		const parent = above[above.length - 1];
		above.push(h);
		const repeated = (uses.get(headingKey(h.text)) ?? 0) > 1 && parent;
		const base = repeated ? `${parent.text} > ${h.text}` : h.text;
		let name = base;
		for (let n = 2; taken.has(headingKey(name)); n++) name = `${base} (${n})`;
		taken.add(headingKey(name));
		out.push({ name, link: repeated ? `${parent.text}#${h.text}` : h.text });
	}
	return out;
}

/** The heading a left-out section's questions point at with their `ref`: the last part of its link. */
export function missedHeading(m: { heading: string; link?: string }): string {
	const target = m.link || m.heading;
	return target.slice(target.lastIndexOf("#") + 1);
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
export function parseBlurt(data: unknown, sections: Section[], note: string, now: Date): BlurtResult | string {
	const d = (data ?? {}) as { score?: unknown; feedback?: unknown; covered?: unknown; missed?: unknown };
	const byKey = new Map(sections.map((s) => [headingKey(s.name), s]));
	const known = (h: unknown) => (typeof h === "string" ? byKey.get(headingKey(h)) : undefined);

	const covered = Array.isArray(d.covered)
		? d.covered.map(known).filter((s): s is Section => Boolean(s)).map((s) => s.name)
		: [];
	const missed = Array.isArray(d.missed)
		? d.missed
			.map((m) => {
				const section = known((m as { heading?: unknown })?.heading);
				const point = String((m as { point?: unknown })?.point ?? "").trim();
				return section ? { heading: section.name, point, link: section.link } : null;
			})
			.filter((m): m is { heading: string; point: string; link: string } => m !== null)
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
