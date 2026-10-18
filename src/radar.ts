import { Bank, Course, SkillAxis } from "./types";

/** A question's score for the radar, 0–100, or null if it has never been answered. */
export type QuestionScore = (bankId: string, questionId: string) => number | null;

export interface AxisScore {
	axis: SkillAxis;
	/** 0-100, counting questions never answered as zero. */
	score: number;
	/** How many questions in this course feed the axis. */
	total: number;
	seen: number;
	/** The score at an earlier moment, drawn as a dashed outline. */
	before?: number;
}

/** Attaches each axis's earlier score, for the radar's dashed outline. */
export function withBefore(now: AxisScore[], before: AxisScore[]): AxisScore[] {
	return now.map((s, i) => ({ ...s, before: before[i]?.score }));
}

/** Which axis a question belongs to: its own `axis`, else the course topic map. */
export function axisFor(course: Course, topic: string, explicit?: string): string | null {
	if (explicit) return explicit;
	for (const a of course.axes) {
		if (a.topics?.includes(topic)) return a.id;
	}
	return null;
}

/**
 * The vault-wide radar: one spoke per course, scored by the mean of that
 * course's own axes. Answers "where am I across everything I study", where the
 * per-course radar answers "where am I inside this subject".
 */
export function scoreCourses(
	courses: Course[],
	banksFor: (c: Course) => Bank[],
	scoreOf: QuestionScore
): AxisScore[] {
	return courses.map((course) => {
		const banks = banksFor(course);
		const inner = scoreAxes(course, banks, scoreOf);
		const withQuestions = inner.filter((a) => a.total > 0);
		const score = withQuestions.length
			? Math.round(withQuestions.reduce((s, a) => s + a.score, 0) / withQuestions.length)
			: 0;
		return {
			axis: { id: course.id, label: course.title },
			score,
			total: banks.reduce((n, b) => n + b.questions.length, 0),
			seen: inner.reduce((n, a) => n + a.seen, 0),
		};
	});
}

/**
 * The axis to work on next: the lowest-scoring one you have actually been
 * tested on. An axis sitting at 0% only because it has never come up is not a
 * weakness, and pointing you at it would be bad advice.
 */
export function weakestTested(scores: AxisScore[]): AxisScore | null {
	const tested = scores.filter((s) => s.total > 0 && s.seen > 0);
	if (!tested.length) return null;
	return tested.slice().sort((a, b) => a.score - b.score)[0];
}

/** Axes with questions that you have never been asked. */
export function untested(scores: AxisScore[]): AxisScore[] {
	return scores.filter((s) => s.total > 0 && s.seen === 0);
}

/**
 * Scores each of a course's axes as the mean of its questions' scores, with
 * questions never answered counting as zero: the number answers "how much of
 * this area do I own", not "how did I do on the few I tried".
 */
export function scoreAxes(course: Course, banks: Bank[], scoreOf: QuestionScore): AxisScore[] {
	const items = banks.flatMap((b) => b.questions.map((q) => ({ bankId: b.id, q })));

	return course.axes.map((axis) => {
		const qs = items.filter((it) => axisFor(course, it.q.topic, it.q.axis) === axis.id);

		if (!qs.length) return { axis, score: 0, total: 0, seen: 0 };

		let sum = 0;
		let seen = 0;
		for (const it of qs) {
			const m = scoreOf(it.bankId, it.q.id);
			if (m !== null) {
				seen += 1;
				sum += m;
			}
		}
		return { axis, score: Math.round(sum / qs.length), total: qs.length, seen };
	});
}

interface RadarOptions {
	size?: number;
	/** Rings drawn behind the shape. */
	rings?: number;
	title?: string;
}

/**
 * Draws the skill radar as inline SVG into `parent`. Colours come from
 * Obsidian's own theme variables, so it follows light and dark mode without a
 * second stylesheet. It is built as DOM nodes, not an HTML string, so no axis
 * label is ever parsed as markup.
 */
export function renderRadar(parent: HTMLElement, scores: AxisScore[], opts: RadarOptions = {}): void {
	const size = opts.size ?? 440;
	const rings = opts.rings ?? 4;
	// Axis labels are long ("Dynamic Analysis & Instrumentation (adb, Emulator,
	// Frida)"), so the wheel is kept small inside a wide box and the labels are
	// wrapped. Painting outside the viewBox is not an option: the scrolling
	// panel clips it.
	const w = size * 1.85;
	const h = size * 1.3;
	const cx = w / 2;
	const cy = h / 2;
	const radius = size * 0.38;
	const n = scores.length;

	if (n < 3) {
		parent.createDiv({ cls: "rl-radar-empty", text: `A radar needs at least three axes; this course has ${n}.` });
		return;
	}

	// Start at twelve o'clock and go clockwise.
	const angle = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
	const pt = (i: number, r: number) => [cx + Math.cos(angle(i)) * r, cy + Math.sin(angle(i)) * r];
	const poly = (r: number) =>
		scores.map((_, i) => pt(i, r).map((v) => v.toFixed(1)).join(",")).join(" ");

	const svg = parent.createSvg("svg", {
		cls: "rl-radar",
		attr: { viewBox: `0 0 ${w} ${h}`, width: "100%", role: "img", "aria-label": "Skill radar" },
	});

	// Grid rings and spokes.
	for (let r = 1; r <= rings; r++) {
		svg.createSvg("polygon", { cls: "rl-radar-ring", attr: { points: poly((radius * r) / rings) } });
	}
	for (let i = 0; i < n; i++) {
		const [x, y] = pt(i, radius);
		svg.createSvg("line", {
			cls: "rl-radar-spoke",
			attr: { x1: cx, y1: cy, x2: x.toFixed(1), y2: y.toFixed(1) },
		});
	}

	const outline = (value: (s: AxisScore) => number) =>
		scores
			.map((s, i) => pt(i, (radius * Math.max(0, Math.min(100, value(s)))) / 100).map((v) => v.toFixed(1)).join(","))
			.join(" ");

	// Where it stood earlier, dashed, behind the shape: the gap between the
	// two is what has faded, or grown, since. Left out when nothing moved.
	if (scores.some((s) => s.before !== undefined && Math.abs(s.before - s.score) >= 1)) {
		svg.createSvg("polygon", { cls: "rl-radar-ghost", attr: { points: outline((s) => s.before ?? 0) } });
	}

	// The shape itself.
	svg.createSvg("polygon", { cls: "rl-radar-shape", attr: { points: outline((s) => s.score) } });

	// Vertex dots, so a zero axis is still visible. Untested axes are hollow, to
	// separate "you got these wrong" from "you have not been asked yet".
	scores.forEach((s, i) => {
		const r = (radius * Math.max(0, Math.min(100, s.score))) / 100;
		const [x, y] = pt(i, r);
		const cls = s.seen === 0 ? "rl-radar-dot rl-radar-dot-untested" : "rl-radar-dot";
		svg.createSvg("circle", { cls, attr: { cx: x.toFixed(1), cy: y.toFixed(1), r: 3.5 } });
	});

	// Labels, wrapped and anchored so they never overlap the wheel or the edge.
	const LINE = 15;
	scores.forEach((s, i) => {
		const [x, y] = pt(i, radius + 22);
		const a = angle(i);
		const cos = Math.cos(a);
		const sin = Math.sin(a);
		const anchor = Math.abs(cos) < 0.25 ? "middle" : cos > 0 ? "start" : "end";

		const lines = wrapLabel(s.axis.label, 22);
		const sub = !s.total ? "no questions yet" : s.seen === 0 ? "not tested yet" : `${s.score}%`;

		// Above the wheel the block grows upward, below it downward, and at the
		// sides it is centred on the spoke.
		const block = lines.length * LINE + LINE;
		let top: number;
		if (sin < -0.5) top = y - block + LINE;
		else if (sin > 0.5) top = y + LINE;
		else top = y - block / 2 + LINE;

		lines.forEach((line, k) => {
			svg.createSvg("text", {
				cls: "rl-radar-label",
				attr: { x: x.toFixed(1), y: (top + k * LINE).toFixed(1), "text-anchor": anchor },
			}).textContent = line;
		});
		svg.createSvg("text", {
			cls: "rl-radar-value",
			attr: { x: x.toFixed(1), y: (top + lines.length * LINE).toFixed(1), "text-anchor": anchor },
		}).textContent = sub;
	});
}

/** Greedy word wrap, so a long axis name becomes two or three short lines. */
export function wrapLabel(text: string, maxChars: number): string[] {
	const words = String(text).split(/\s+/).filter(Boolean);
	if (!words.length) return [""];
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		const candidate = line ? `${line} ${word}` : word;
		if (candidate.length > maxChars && line) {
			lines.push(line);
			line = word;
		} else {
			line = candidate;
		}
	}
	if (line) lines.push(line);
	// Three lines is the most that fits beside the wheel; fold the rest in.
	if (lines.length > 3) {
		const kept = lines.slice(0, 2);
		kept.push(lines.slice(2).join(" ").slice(0, maxChars - 1) + "…");
		return kept;
	}
	return lines;
}
