import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Memory, dailyRecord, forgetReplays, settledRecord } from "../src/memory";
import type { DayLog } from "../src/types";
import { qkey, type Attempt } from "../src/types";
import { attempt } from "./helpers";

// Replays are kept and extended rather than redone, so every result here is
// checked against a replay from scratch of the same answers.

const DAY = 86_400_000;
const START = new Date(2026, 8, 1, 9, 0).getTime(); // 1 Sep 2026, local 09:00
const IDS = Array.from({ length: 12 }, (_, i) => `q${i}`);
const KEYS = new Set(IDS.map((id) => qkey("a", id)));

/** About `perDay` answers a day for `days` days, the same every run. */
function history(days: number, perDay = 6, from = 0): Attempt[] {
	let seed = 11 + from;
	const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
	const out: Attempt[] = [];
	for (let d = from; d < from + days; d++) {
		for (let k = 0; k < perDay; k++) {
			const at = new Date(START + d * DAY + k * 600_000).toISOString();
			const score = rand() < 0.7 ? 100 : rand() < 0.5 ? 60 : 0;
			out.push(attempt("a", IDS[Math.floor(rand() * IDS.length)], score, at, { ms: 3000 + Math.floor(rand() * 9000) }));
		}
	}
	return out;
}

function assertSame(cached: Memory, fresh: Memory, at: Date): void {
	for (const key of KEYS) {
		assert.equal(cached.has(key), fresh.has(key), key);
		assert.equal(cached.card(key)?.due.getTime(), fresh.card(key)?.due.getTime(), key);
		assert.equal(cached.recall(key, at), fresh.recall(key, at), key);
	}
}

test("a kept replay is reused for the same answers", () => {
	forgetReplays();
	const answers = history(10);
	const first = Memory.of(answers, 0.9);
	assert.equal(Memory.of(answers.slice(), 0.9), first, "same answers, same schedule");
	assertSame(first, new Memory(answers, 0.9), new Date(START + 10 * DAY));
	assert.notEqual(Memory.of(answers, 0.85), first, "a new target recall is its own schedule");
});

test("new answers extend the kept replay, which itself stays as it was", () => {
	forgetReplays();
	const before = history(10);
	const kept = Memory.of(before, 0.9);
	const keptDue = [...KEYS].map((k) => kept.card(k)?.due.getTime());
	const after = [...before, ...history(3, 6, 10)];
	const at = new Date(START + 13 * DAY);
	assertSame(Memory.of(after, 0.9), new Memory(after, 0.9), at);
	assert.deepEqual([...KEYS].map((k) => kept.card(k)?.due.getTime()), keptDue);
});

test("a changed answer, wherever it is, means replaying from scratch", () => {
	forgetReplays();
	const answers = history(10);
	Memory.of(answers, 0.9);
	const edited = answers.map((a, i) => (i === 5 ? { ...a, score: a.score === 100 ? 0 : 100 } : a));
	assertSame(Memory.of(edited, 0.9), new Memory(edited, 0.9), new Date(START + 10 * DAY));
	const marked = answers.map((a, i) => (i === 20 ? { ...a, gradedBy: "error" as const } : a));
	assertSame(Memory.of(marked, 0.9), new Memory(marked, 0.9), new Date(START + 10 * DAY));
});

test("a first part of a long history resumes from a checkpoint", () => {
	forgetReplays();
	const answers = history(200, 8); // 1600 answers: one checkpoint, at 1024
	Memory.of(answers, 0.9);
	const weekAgo = answers.slice(0, 1500);
	assertSame(Memory.of(weekAgo, 0.9), new Memory(weekAgo, 0.9), new Date(START + 190 * DAY));
	const early = answers.slice(0, 1000);
	assertSame(Memory.of(early, 0.9), new Memory(early, 0.9), new Date(START + 130 * DAY));
});

/** Every finished day as the record first worked it out. */
function settled(answers: Attempt[], now: Date): Record<string, DayLog> {
	forgetReplays();
	return settledRecord(answers, 0.9, KEYS, now, {}).settle;
}

test("with every finished day kept, only today is worked out, and the record matches a full one", () => {
	const answers = history(15);
	const kept = settled(answers, new Date(START + 14 * DAY + 3_600_000));
	assert.equal(Object.keys(kept).length, 14, "days 0 to 13");
	const withToday = [...answers, attempt("a", "q1", 0, new Date(START + 14 * DAY + 7_200_000).toISOString())];
	const now = new Date(START + 14 * DAY + 8 * 3_600_000);
	const { days, settle } = settledRecord(withToday, 0.9, KEYS, now, kept);
	assert.deepEqual(days, dailyRecord(withToday, 0.9, KEYS, now));
	assert.deepEqual(settle, {});
});

test("a missing day among the kept ones is worked out again and kept", () => {
	const answers = history(15);
	const now = new Date(START + 14 * DAY + 3_600_000);
	const kept = settled(answers, now);
	const hole = Object.keys(kept).sort()[6];
	const { [hole]: missing, ...rest } = kept;
	const { days, settle } = settledRecord(answers, 0.9, KEYS, now, rest);
	assert.deepEqual(days, dailyRecord(answers, 0.9, KEYS, now));
	assert.deepEqual(settle, { [hole]: missing });
});

test("a day passing is worked out from the schedule at the end of the last kept day", () => {
	const answers = history(15);
	const kept = settled(answers, new Date(START + 11 * DAY + 3_600_000));
	const now = new Date(START + 14 * DAY + 3_600_000);
	const { days, settle } = settledRecord(answers, 0.9, KEYS, now, kept);
	assert.deepEqual(days, dailyRecord(answers, 0.9, KEYS, now));
	assert.equal(Object.keys(settle).length, 3, "days 11 to 13 join the kept ones");
});

test("a kept day stays as it was, but the days after it see an answer saved late", () => {
	const answers = history(15);
	const now = new Date(START + 14 * DAY + 3_600_000);
	const kept = settled(answers, new Date(START + 13 * DAY + 3_600_000));
	// Dated late on day 12, a kept day, and saved afterwards.
	const late = attempt("a", "q3", 0, new Date(START + 12 * DAY + 14 * 3_600_000).toISOString());
	const withLate = [...answers, late];
	const days = settledRecord(withLate, 0.9, KEYS, now, kept).days;
	const full = dailyRecord(withLate, 0.9, KEYS, now);
	assert.equal(days[12].answers, kept[Object.keys(kept).sort()[12]].answers, "the kept day is not rewritten");
	assert.deepEqual(days.slice(13), full.slice(13));
});
