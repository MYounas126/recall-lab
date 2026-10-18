import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Rating } from "ts-fsrs";
import { Memory, Pace, dayOffset, describeWhen, keyOf, keysOf, planReview, ratingFor } from "../src/memory";
import { AnswerIndex } from "../src/history";
import { Store } from "../src/store";
import { qkey, type Bank } from "../src/types";
import { attempt, question } from "./helpers";

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 18, 12, 0); // local noon, 18 Oct 2026
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const memoryOf = (...attempts: ReturnType<typeof attempt>[]) => new Memory(attempts, 0.9);

test("a miss rates Again, a partial answer Hard, a correct one Good", () => {
	assert.equal(ratingFor(attempt("a", "q1", 0)), Rating.Again);
	assert.equal(ratingFor(attempt("a", "q1", 60)), Rating.Hard);
	assert.equal(ratingFor(attempt("a", "q1", 100)), Rating.Good);
});

test("the rating follows the score: a mostly-wrong 'partial' is a miss", () => {
	assert.equal(ratingFor(attempt("a", "q1", 20)), Rating.Again, "one right pick in five is not remembered");
	assert.equal(ratingFor(attempt("a", "q1", 59)), Rating.Again);
	assert.equal(ratingFor(attempt("a", "q1", 89)), Rating.Hard);
	assert.equal(ratingFor(attempt("a", "q1", 90)), Rating.Good);
});

test("a failed marking is never scheduled or scored", () => {
	const failed = attempt("a", "q1", 0, ago(1), { gradedBy: "error" });
	const m = memoryOf(failed);
	assert.ok(!m.has(qkey("a", "q1")), "not a review");
	assert.equal(m.introducedSince(new Date(0)), 0, "not a new question met");
	assert.equal(new AnswerIndex([failed]).mastery("a", "q1"), null, "no mastery");
	const known = memoryOf(...[60, 30, 15, 5].map((d) => attempt("a", "q1", 100, ago(d))), failed);
	const clean = memoryOf(...[60, 30, 15, 5].map((d) => attempt("a", "q1", 100, ago(d))));
	assert.equal(known.card(qkey("a", "q1"))!.due.getTime(), clean.card(qkey("a", "q1"))!.due.getTime(), "the schedule is untouched");
});

test("a miss comes back the next day, however mature the question was", () => {
	const reviews = [90, 60, 30, 15, 5].map((d) => attempt("a", "q1", 100, ago(d)));
	const m = memoryOf(...reviews, attempt("a", "q1", 0, ago(0)));
	const gap = (m.card(qkey("a", "q1"))!.due.getTime() - NOW.getTime()) / DAY;
	assert.ok(gap <= 1.0001, `back after ${gap.toFixed(2)} days`);
});

test("a question due later today is in today's review", () => {
	const yesterdayEvening = new Date(2026, 9, 17, 18, 0).toISOString();
	const memory = memoryOf(attempt("a", "q1", 0, yesterdayEvening)); // back a day later: 18:00 today
	const morning = new Date(2026, 9, 18, 8, 0);
	assert.ok(!memory.isDue(qkey("a", "q1"), morning), "not due this minute");
	const bank = { id: "a", title: "A", questions: [question("q1")] };
	const p = planReview({ items: Store.itemsOf([bank]), memory, now: morning, newPerDay: 0, completed: {}, noteOf: () => undefined });
	assert.deepEqual(p.due.map(keyOf), [qkey("a", "q1")], "but due today, so a morning session clears it");
});

test("days are counted on the calendar, also across a daylight-saving change", () => {
	const tz = process.env.TZ;
	process.env.TZ = "Europe/London"; // clocks go back on Sun 25 Oct 2026: a 25-hour day
	try {
		const now = new Date(2026, 9, 24, 12, 0); // Sat noon
		assert.equal(dayOffset(new Date(2026, 9, 30, 23, 30), now), 6, "Fri 23:30 is 6 days after Sat");
		assert.equal(dayOffset(new Date(2026, 9, 25, 0, 30), now), 1);
		assert.equal(dayOffset(new Date(2026, 9, 24, 23, 59), now), 0);
	} finally {
		if (tz === undefined) delete process.env.TZ;
		else process.env.TZ = tz;
	}
});

test("confidence tunes the rating", () => {
	const right = (confidence: "guess" | "unsure" | "sure") => attempt("a", "q1", 100, ago(0), { confidence });
	assert.equal(ratingFor(right("guess")), Rating.Again, "a lucky guess is not knowledge yet");
	assert.equal(ratingFor(right("unsure")), Rating.Good);
	assert.equal(ratingFor(right("sure")), Rating.Good, "sure but slow stays Good");
	assert.equal(ratingFor(right("sure"), true), Rating.Easy, "sure and quick is Easy");
	assert.equal(ratingFor(attempt("a", "q1", 0, ago(0), { confidence: "sure" }), true), Rating.Again);
});

test("a partly-right guess is a miss too, not a pass", () => {
	const partial = (confidence: "guess" | "sure") => attempt("a", "q1", 70, ago(0), { verdict: "partial", confidence });
	assert.equal(ratingFor(partial("guess")), Rating.Again, "no better than a fully-right guess");
	assert.equal(ratingFor(partial("sure"), true), Rating.Hard, "sure does not lift a partial answer");
});

test("quick means at or under your usual time, once there is a usual time", () => {
	const pace = new Pace();
	const fast = attempt("a", "x", 100, ago(0), { ms: 1000 });
	for (let i = 0; i < 4; i++) pace.add(attempt("a", `q${i}`, 100, ago(0), { ms: 5000 }));
	assert.equal(pace.quick(fast), false, "four answers are not a baseline yet");
	pace.add(attempt("a", "q4", 100, ago(0), { ms: 5000 }));
	assert.equal(pace.quick(fast), true);
	assert.equal(pace.quick(attempt("a", "x", 100, ago(0), { ms: 9000 })), false);
	assert.equal(pace.quick(attempt("a", "x", 100, ago(0), { ms: 1000, type: "short" })), false, "each type has its own pace");
	pace.add(attempt("a", "q5", 0, ago(0), { ms: 1 }));
	assert.equal(pace.quick(attempt("a", "x", 100, ago(0), { ms: 5000 })), true, "misses do not set the pace");
});

test("right, sure and quick is spaced out further than plain right", () => {
	const warmup = [0, 1, 2, 3, 4].map((i) => attempt("w", `q${i}`, 100, ago(1), { ms: 5000 }));
	const m = memoryOf(
		...warmup,
		attempt("a", "easy", 100, ago(0), { ms: 1000, confidence: "sure" }),
		attempt("a", "good", 100, ago(0), { ms: 1000, confidence: "unsure" }),
	);
	const due = (id: string) => m.card(qkey("a", id))!.due.getTime();
	assert.ok(due("easy") > due("good"));
});

test("a correct answer is spaced out further than a missed one", () => {
	const m = memoryOf(attempt("a", "right", 100, ago(0)), attempt("a", "wrong", 0, ago(0)));
	const gap = (id: string) => (m.card(qkey("a", id))!.due.getTime() - NOW.getTime()) / DAY;
	assert.ok(gap("right") > gap("wrong"), `right ${gap("right")}d vs wrong ${gap("wrong")}d`);
	assert.ok(gap("wrong") <= 1.5, "a missed question should come back within about a day");
});

test("replaying the same history gives the same schedule", () => {
	const history = [attempt("a", "q1", 100, ago(20)), attempt("a", "q1", 100, ago(15)), attempt("a", "q1", 60, ago(3))];
	const due = () => new Memory(history, 0.9).card(qkey("a", "q1"))!.due.getTime();
	assert.equal(due(), due());
});

test("memory is per bank: answering a/q1 says nothing about b/q1", () => {
	const m = memoryOf(attempt("a", "q1", 100, ago(1)));
	assert.ok(m.has(qkey("a", "q1")));
	assert.ok(!m.has(qkey("b", "q1")));
	assert.equal(m.recall(qkey("b", "q1"), NOW), null);
});

test("recall fades with time", () => {
	const m = memoryOf(attempt("a", "q1", 100, ago(2)));
	const soon = m.recall(qkey("a", "q1"), NOW)!;
	const later = m.recall(qkey("a", "q1"), new Date(NOW.getTime() + 30 * DAY))!;
	assert.ok(soon > later && later > 0 && soon <= 1);
});

test("replaying up to a moment ignores later answers", () => {
	const history = [attempt("a", "q1", 100, ago(10)), attempt("a", "q2", 100, ago(1))];
	const then = new Memory(history, 0.9, new Date(NOW.getTime() - 5 * DAY));
	assert.ok(then.has(qkey("a", "q1")));
	assert.ok(!then.has(qkey("a", "q2")));
});

test("forecast and nextDue only count questions in scope", () => {
	const m = memoryOf(attempt("a", "q1", 0, ago(0)), attempt("gone", "q1", 0, ago(0)));
	const scope = new Set([qkey("a", "q1")]);
	assert.equal(m.forecast(NOW, 3, scope).reduce((x, y) => x + y, 0), 1);
	assert.ok(m.nextDue(NOW, scope));
	assert.equal(m.nextDue(NOW, new Set()), null);
});

// ------------------------------------------------------------ planReview

const started: Bank = {
	id: "a", title: "A", note: "C/a.md",
	questions: [question("q1"), question("q2"), question("q3"), question("q4"), question("q5", { tier: "hard" })],
};
const completedNote: Bank = { id: "b", title: "B", note: "C/b.md", questions: [question("q1")] };
const unread: Bank = { id: "c", title: "C", note: "C/c.md", questions: [question("q1")] };
const banks = [started, completedNote, unread];
const noteOf = (id: string) => banks.find((b) => b.id === id)?.note;

function plan(newPerDay: number) {
	const memory = memoryOf(
		attempt("a", "q1", 100, ago(30)),
		attempt("a", "q2", 0, ago(3)),
		attempt("a", "q3", 100, new Date(NOW.getTime() - 3_600_000).toISOString()), // first answered today
	);
	return {
		memory,
		plan: planReview({
			items: Store.itemsOf(banks), memory, now: NOW, newPerDay,
			completed: { "C/b.md": ago(5) }, noteOf,
		}),
	};
}

test("everything due comes first, closest to forgotten at the top", () => {
	const { plan: p, memory } = plan(0);
	assert.deepEqual(p.due.map(keyOf).sort(), [qkey("a", "q1"), qkey("a", "q2")]);
	const recalls = p.due.map((it) => memory.recall(keyOf(it), NOW)!);
	assert.ok(recalls[0] <= recalls[1]);
	assert.equal(p.fresh.length, 0);
});

test("new questions come only from completed or examined notes, completed first", () => {
	const { plan: p } = plan(10);
	const fresh = p.fresh.map(keyOf);
	assert.equal(fresh[0], qkey("b", "q1"), "the completed note leads");
	assert.ok(!fresh.includes(qkey("c", "q1")), "a note never read is never drawn from");
	assert.deepEqual(fresh.slice(1), [qkey("a", "q4"), qkey("a", "q5")], "easy before hard");
});

test("the day's allowance counts new questions already met today", () => {
	// a/q3 was first answered today, so an allowance of 2 leaves room for 1.
	assert.equal(plan(2).plan.fresh.length, 1);
	assert.equal(plan(1).plan.fresh.length, 0);
});

test("keysOf covers every item", () => {
	assert.equal(keysOf(Store.itemsOf(banks)).size, 7);
});

test("describeWhen speaks plainly", () => {
	const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
	assert.equal(describeWhen(at(0.5), NOW), "within the hour");
	assert.equal(describeWhen(at(3), NOW), "in 3 hours");
	assert.equal(describeWhen(at(24), NOW), "tomorrow");
	assert.equal(describeWhen(at(24 * 4), NOW), "in 4 days");
	assert.match(describeWhen(at(24 * 30), NOW), /^on /);
	assert.equal(describeWhen(at(-1), NOW), "now");
});
