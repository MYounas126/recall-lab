import { AnswerIndex } from "./history";
import { ExamItem, TIERS, Tier, idOf } from "./types";

/**
 * Tier gates. A quiz's Hard questions are asked once you own enough of its
 * Easy ones, and its Brutal questions once you own enough of its Hard ones.
 * "Own" counts a question never answered as zero, so a gate opens when you
 * have covered the tier below, not when you have aced the few you tried.
 * Each quiz has its own gates: mastering one note opens nothing in another.
 */

/** The share of the tier below, 0–100, that opens each tier. */
export interface GateRule {
	hard: number;
	brutal: number;
}

/** One quiz's tiers: how much of each you own, and which are open. */
export interface Gate {
	/** 0–100, rounded; null when the quiz has no questions in the tier. */
	mastery: Record<Tier, number | null>;
	open: Record<Tier, boolean>;
}

const NAME: Record<Tier, string> = { easy: "Easy", hard: "Hard", brutal: "Brutal" };

/** The gate of one quiz, from its questions. */
export function gateOf(items: ExamItem[], index: AnswerIndex, rule: GateRule): Gate {
	const mastery: Record<Tier, number | null> = { easy: null, hard: null, brutal: null };
	for (const tier of TIERS) {
		const mine = items.filter((it) => it.q.tier === tier);
		if (!mine.length) continue;
		const sum = mine.reduce((s, it) => s + (index.mastery(it.bankId, idOf(it)) ?? 0), 0);
		mastery[tier] = Math.round(sum / mine.length);
	}
	// A tier with no questions has nothing to own, so it never holds the next one shut.
	const hard = mastery.easy === null || mastery.easy >= rule.hard;
	const brutal = hard && (mastery.hard === null || mastery.hard >= rule.brutal);
	return { mastery, open: { easy: true, hard, brutal } };
}

/** Each quiz's gate, for items that may come from several quizzes. */
export function gatesOf(items: ExamItem[], index: AnswerIndex, rule: GateRule): Map<string, Gate> {
	const byBank = new Map<string, ExamItem[]>();
	for (const it of items) {
		const list = byBank.get(it.bankId);
		if (list) list.push(it);
		else byBank.set(it.bankId, [it]);
	}
	return new Map([...byBank].map(([id, list]) => [id, gateOf(list, index, rule)]));
}

/** Whether an item's tier is open in its own quiz. */
export function isOpen(item: ExamItem, gates: Map<string, Gate>): boolean {
	return gates.get(item.bankId)?.open[item.q.tier] ?? true;
}

/** The tiers a gate keeps shut that have questions in them, easiest first. */
export function lockedTiers(gate: Gate): Tier[] {
	return TIERS.filter((t) => !gate.open[t] && gate.mastery[t] !== null);
}

/** The tiers that are open now but were not before, per quiz. */
export function opened(before: Map<string, Gate>, after: Map<string, Gate>): Map<string, Tier[]> {
	const out = new Map<string, Tier[]>();
	for (const [id, was] of before) {
		const now = after.get(id);
		if (!now) continue;
		const tiers = TIERS.filter((t) => !was.open[t] && now.open[t] && now.mastery[t] !== null);
		if (tiers.length) out.set(id, tiers);
	}
	return out;
}

/** "Hard", "Hard and Brutal". */
export function tierNames(tiers: Tier[]): string {
	return tiers.map((t) => NAME[t]).join(" and ");
}

/**
 * What is locked and what it takes to open it, in a sentence, or null when
 * nothing with questions in it is locked. Given the gate from before a
 * session, it also says where you stood then.
 */
export function whyLocked(gate: Gate, rule: GateRule, since?: Gate): string | null {
	const locked = lockedTiers(gate);
	if (!locked.length) return null;
	// The lowest shut gate is the one to work on.
	const below: Tier = gate.open.hard ? "hard" : "easy";
	const need = below === "easy" ? rule.hard : rule.brutal;
	const owned = gate.mastery[below] ?? 0;
	const was = since?.mastery[below];
	const then = was !== null && was !== undefined && was !== owned ? ` (${was}% before)` : "";
	const lead = `${tierNames(locked)} ${locked.length > 1 ? "are" : "is"} locked.`;
	const subject = locked.length > 1 ? NAME[locked[0]] : "It";
	return `${lead} ${subject} opens once you own ${need}% of this quiz's ${NAME[below]} questions; you own ${owned}%${then}.`;
}
