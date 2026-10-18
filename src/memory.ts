import { createEmptyCard, fsrs, Rating, type Card, type FSRS, type Grade } from "ts-fsrs";
import { Attempt, ExamItem, Tier, qkey } from "./types";

const DAY = 86_400_000;

/** A question's key, from the item an exam asks. */
export function keyOf(item: ExamItem): string {
	return qkey(item.bankId, item.q.id);
}

/**
 * The FSRS rating for one answer. A miss is Again and a partial answer Hard.
 * A right answer you were only guessing at is not knowledge yet, so it is
 * rated as a miss. Right, sure and quicker than usual is Easy; any other
 * right answer is Good.
 */
export function ratingFor(a: Attempt, quick = false): Grade {
	// By score, not verdict: Hard is a passing grade in FSRS, so a mostly-wrong
	// "partial" (a select-all answer with one right pick in five) must not count
	// as remembered. A guess is checked before Hard for the same reason: a
	// partly-right guess must not pass where a fully-right one does not.
	if (a.score < 60 || a.confidence === "guess") return Rating.Again;
	if (a.score < 90) return Rating.Hard;
	if (a.confidence === "sure" && quick) return Rating.Easy;
	return Rating.Good;
}

/** Correct answers of a type needed before "quicker than usual" means anything. */
const PACE_BASELINE = 5;

/**
 * Judges whether an answer was quick: at or under the median time of your
 * earlier correct answers to the same type of question. Only earlier answers
 * count, so a later answer never changes how an earlier one was rated.
 */
export class Pace {
	private sorted = new Map<string, number[]>();

	quick(a: Attempt): boolean {
		const prior = this.sorted.get(a.type) ?? [];
		if (prior.length < PACE_BASELINE) return false;
		return a.ms <= prior[Math.floor(prior.length / 2)];
	}

	add(a: Attempt): void {
		if (a.verdict !== "correct" || !Number.isFinite(a.ms)) return;
		const list = this.sorted.get(a.type) ?? [];
		let lo = 0;
		let hi = list.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (list[mid] < a.ms) lo = mid + 1;
			else hi = mid;
		}
		list.splice(lo, 0, a.ms);
		this.sorted.set(a.type, list);
	}
}

/**
 * Answers that say nothing about memory: a marking that failed (Claude could
 * not be reached) is kept in the log for the record, but never scheduled or
 * scored as a miss.
 */
export function counts(a: Attempt): boolean {
	return a.gradedBy !== "error";
}

/**
 * Spaced-repetition state for every question ever answered, rebuilt by
 * replaying the answer log in order. attempts.json stays the only record: the
 * schedule is derived from it, so it can be recomputed at any time — or the
 * algorithm swapped — without migrating anything.
 */
export class Memory {
	private cards = new Map<string, Card>();
	/** When each question was first answered, in ms. */
	private first = new Map<string, number>();
	private scheduler: FSRS;

	/**
	 * @param retention the chance of still remembering a question when it
	 *   comes due, which sets how far apart reviews are.
	 * @param until replay only the answers given up to this moment, to see
	 *   memory as it stood then.
	 */
	constructor(attempts: Attempt[], retention: number, until?: Date) {
		this.scheduler = fsrs({
			request_retention: retention,
			// Fuzz spreads out reviews so a batch learned together does not all
			// fall due on one day. Its seed comes from the review itself, so a
			// replay lands on the same dates every time.
			enable_fuzz: true,
			// Sessions are days apart, not minutes, so intraday learning steps
			// would only hold a question back a whole session.
			enable_short_term: false,
		});
		const cutoff = until ? until.getTime() : Infinity;
		const ordered = attempts.slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
		const pace = new Pace();
		for (const a of ordered) {
			const at = Date.parse(a.ts);
			if (Number.isNaN(at) || at > cutoff || !counts(a)) continue;
			const key = qkey(a.bankId, a.questionId);
			const when = new Date(at);
			const card = this.cards.get(key) ?? createEmptyCard<Card>(when);
			const rating = ratingFor(a, pace.quick(a));
			const next = this.scheduler.next(card, when, rating).card;
			// Without short-term steps, Again waits as long as the post-lapse
			// stability (4 days after three reviews, 8 after five). A miss should
			// come back the next day, so cap it there.
			if (rating === Rating.Again) next.due = new Date(Math.min(next.due.getTime(), at + DAY));
			this.cards.set(key, next);
			pace.add(a);
			if (!this.first.has(key)) this.first.set(key, at);
		}
	}

	/** Whether this question has ever been answered. */
	has(key: string): boolean {
		return this.cards.has(key);
	}

	card(key: string): Card | undefined {
		return this.cards.get(key);
	}

	/** The chance, 0–1, of recalling this question right now; null if never answered. */
	recall(key: string, now: Date): number | null {
		const card = this.cards.get(key);
		return card ? this.scheduler.get_retrievability(card, now, false) : null;
	}

	isDue(key: string, now: Date): boolean {
		const card = this.cards.get(key);
		return Boolean(card && card.due.getTime() <= now.getTime());
	}

	/** How many questions were answered for the first time at or after `since`. */
	introducedSince(since: Date): number {
		let n = 0;
		for (const t of this.first.values()) if (t >= since.getTime()) n += 1;
		return n;
	}

	/**
	 * The first moment after `now` that one of these questions falls due, or
	 * null if none will. Only keys in scope count, so answers left behind by a
	 * deleted quiz never surface as phantom reviews.
	 */
	nextDue(now: Date, keys: Set<string>): Date | null {
		let next: number | null = null;
		for (const [key, card] of this.cards) {
			if (!keys.has(key)) continue;
			const t = card.due.getTime();
			if (t > now.getTime() && (next === null || t < next)) next = t;
		}
		return next === null ? null : new Date(next);
	}

	/**
	 * How many of these questions fall due on each of the next `days` days,
	 * counted from local midnight today. Day 0 includes everything overdue.
	 */
	forecast(now: Date, days: number, keys: Set<string>): number[] {
		const out = new Array<number>(days).fill(0);
		for (const [key, card] of this.cards) {
			if (!keys.has(key)) continue;
			const day = Math.max(0, dayOffset(card.due, now));
			if (day < days) out[day] += 1;
		}
		return out;
	}
}

/** The keys of every question in these items. */
export function keysOf(items: ExamItem[]): Set<string> {
	return new Set(items.map(keyOf));
}

/** "within the hour", "in 3 hours", "tomorrow", "in 4 days" or "on 21 Oct". */
export function describeWhen(target: Date, now: Date): string {
	const ms = target.getTime() - now.getTime();
	if (ms <= 0) return "now";
	const days = Math.round((startOfDay(target).getTime() - startOfDay(now).getTime()) / DAY);
	if (days === 0) {
		if (ms < 3_600_000) return "within the hour";
		const hours = Math.round(ms / 3_600_000);
		return `in ${hours} hour${hours === 1 ? "" : "s"}`;
	}
	if (days === 1) return "tomorrow";
	if (days < 7) return `in ${days} days`;
	return `on ${target.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/**
 * How many calendar days `date` is after `now`'s day: 0 today, 1 tomorrow.
 * Counted in calendar days, not 24-hour blocks, so a 23- or 25-hour day at a
 * daylight-saving change does not shift what falls on it.
 */
export function dayOffset(date: Date, now: Date): number {
	return Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / DAY);
}

/** Local midnight at the start of `now`'s day. */
export function startOfDay(now: Date): Date {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d;
}

/**
 * The last moment of `now`'s day. Reviews count what is due by then, not
 * this minute: FSRS keeps the time of day of the last answer, so a question
 * due at 18:00 could otherwise not be cleared in a morning session.
 */
export function endOfDay(now: Date): Date {
	const d = new Date(now);
	d.setHours(23, 59, 59, 999);
	return d;
}

export interface ReviewPlan {
	/** Answered before and due now, most at risk of being forgotten first. */
	due: ExamItem[];
	/** Never answered, within what is left of today's allowance of new questions. */
	fresh: ExamItem[];
}

const TIER_ORDER: Record<Tier, number> = { easy: 0, hard: 1, brutal: 2 };

/**
 * Today's review. Everything due comes first, most at risk first, so ending a
 * session early still covers what matters most. Then new questions, up to the
 * day's allowance, and only from notes marked complete or already examined:
 * never from a note not read yet. Completed notes go first, oldest first, and
 * within a note easy questions come before hard ones.
 */
export function planReview(p: {
	items: ExamItem[];
	memory: Memory;
	now: Date;
	newPerDay: number;
	/** Note path → when it was marked complete. */
	completed: Record<string, string>;
	/** The note a bank drills, if it has one. */
	noteOf: (bankId: string) => string | undefined;
}): ReviewPlan {
	const { items, memory, now } = p;
	const due = items
		.filter((it) => memory.isDue(keyOf(it), endOfDay(now)))
		.map((it) => ({ it, r: memory.recall(keyOf(it), now) ?? 0 }))
		.sort((a, b) => a.r - b.r)
		.map((e) => e.it);

	const allowance = Math.max(0, p.newPerDay - memory.introducedSince(startOfDay(now)));
	if (!allowance) return { due, fresh: [] };

	const started = new Set(items.filter((it) => memory.has(keyOf(it))).map((it) => it.bankId));
	const rank = (it: ExamItem): number | null => {
		const done = p.completed[p.noteOf(it.bankId) ?? ""];
		if (done) {
			const t = Date.parse(done);
			return Number.isNaN(t) ? 0 : t;
		}
		return started.has(it.bankId) ? Number.MAX_SAFE_INTEGER : null;
	};
	const fresh = items
		.filter((it) => !memory.has(keyOf(it)))
		.map((it, i) => ({ it, i, r: rank(it) }))
		.filter((e): e is { it: ExamItem; i: number; r: number } => e.r !== null)
		.sort((a, b) => a.r - b.r || TIER_ORDER[a.it.q.tier] - TIER_ORDER[b.it.q.tier] || a.i - b.i)
		.slice(0, allowance)
		.map((e) => e.it);
	return { due, fresh };
}
