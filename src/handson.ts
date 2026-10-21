import { Lab, LabProgress, SkillAxis, Tier, labScore } from "./types";

/**
 * What you have actually done, as opposed to what you can answer.
 *
 * The radar measures recall: the score you would expect on a skill area's
 * questions if asked right now. Labs measure something else — whether you
 * have taken the thing apart with your own hands — and the two can disagree
 * sharply. Answering four questions about the stack is not the same as
 * having overflowed one.
 *
 * These are kept apart deliberately. Folding a solved lab into a spoke would
 * break what a spoke means, since a lab is not a question that can come due
 * again. So this reads alongside the radar instead of inside it.
 */

export interface AxisPractice {
	axis: SkillAxis;
	/** Labs in this course that feed this axis. */
	total: number;
	solved: number;
	/** Opened, not solved, not given up: work in progress. */
	started: number;
	gaveUp: number;
	/** Mean score over the labs solved, or null if none are. */
	score: number | null;
	/** The hardest tier solved here, or null. */
	best: Tier | null;
}

const HARDER: Record<Tier, number> = { easy: 0, hard: 1, brutal: 2 };

/** Each axis's hands-on record, in the course's own axis order. */
export function practice(axes: SkillAxis[], labs: Lab[], progress: Record<string, LabProgress>): AxisPractice[] {
	const known = new Set(axes.map((a) => a.id));
	return axes.map((axis) => {
		// A lab whose axis no longer exists falls to the first, as questions do.
		const mine = labs.filter((l) => (known.has(l.axis) ? l.axis : axes[0]?.id) === axis.id);
		const solved: Lab[] = [];
		let started = 0;
		let gaveUp = 0;
		let sum = 0;
		let best: Tier | null = null;
		for (const lab of mine) {
			const p = progress[lab.id];
			if (p?.solvedAt) {
				solved.push(lab);
				sum += labScore(p);
				if (!best || HARDER[lab.tier] > HARDER[best]) best = lab.tier;
			} else if (p?.gaveUpAt) gaveUp += 1;
			else if (p?.firstOpenedAt) started += 1;
		}
		return {
			axis,
			total: mine.length,
			solved: solved.length,
			started,
			gaveUp,
			score: solved.length ? Math.round(sum / solved.length) : null,
			best,
		};
	});
}

/** How an axis's hands-on record reads, for the line beside its radar score. */
export function describePractice(p: AxisPractice): string {
	if (!p.total) return "no labs yet";
	if (p.solved) {
		const tier = p.best === "brutal" ? "brutal" : p.best === "hard" ? "hard" : "easy";
		return `${p.solved} of ${p.total} solved · ${p.score}% · hardest ${tier}`;
	}
	if (p.started) return `${p.started} of ${p.total} open`;
	if (p.gaveUp) return `${p.gaveUp} given up`;
	return `${p.total} never opened`;
}

/**
 * The gap worth pointing at: an area you answer well but have never proved
 * by hand. That is the one the radar flatters, because recognising something
 * and being able to do it are not the same.
 */
export function knownButUntried(
	practised: AxisPractice[],
	scores: { axis: SkillAxis; score: number; seen: number }[],
	answeredAtLeast = 50
): AxisPractice[] {
	const by = new Map(scores.map((s) => [s.axis.id, s]));
	return practised.filter((p) => {
		const s = by.get(p.axis.id);
		return Boolean(s && s.seen > 0 && s.score >= answeredAtLeast && p.total > 0 && p.solved === 0);
	});
}

/** The opposite, and the nicer one: proved by hand, whatever the questions say. */
export function provenByHand(practised: AxisPractice[]): AxisPractice[] {
	return practised.filter((p) => p.solved > 0);
}
