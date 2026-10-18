import { Question, Verdict } from "./types";

export interface LocalResult {
	score: number;
	verdict: Verdict;
	feedback: string;
	missing: string[];
}

/** Everything an answer can carry, whatever the question type. */
export interface Response {
	text: string;
	/** mcq and multi: original choice indices. hotspot: 1-based line numbers. */
	chosen: number[];
	/** order: original item indices, in the order you arranged them. */
	order?: number[];
	/** match: for each left-hand item, the pair whose right side you chose; -1 for none. */
	matches?: number[];
	/** cloze: what you typed in each blank. */
	blanks?: string[];
	/** trace: for each step, what you typed for each name, in the order the step lists them. */
	cells?: string[][];
}

/** Marks the question types that need no help from Claude. */
export function gradeLocally(q: Question, r: Response): LocalResult | null {
	switch (q.type) {
		case "mcq":
			return gradeMcq(q, r.chosen);
		case "multi":
			return gradeMulti(q, r.chosen);
		case "short":
		case "command":
			return gradeByPattern(q, r.text);
		case "hotspot":
			return gradeHotspot(q, r.chosen);
		case "order":
			return gradeOrder(q, r.order ?? []);
		case "match":
			return gradeMatch(q, r.matches ?? []);
		case "cloze":
			return gradeCloze(q, r.blanks ?? []);
		case "trace":
			return gradeTrace(q, r.cells ?? []);
		default:
			return null;
	}
}

/**
 * The verdict for the part-by-part types: correct only when every part is,
 * partial from half, and incorrect below that. A fully reversed order still
 * keeps one item "in order", so any credit at all cannot mean partial.
 */
function verdictFor(score: number): Verdict {
	return score >= 100 ? "correct" : score >= 50 ? "partial" : "incorrect";
}

function result(q: Question, score: number, feedback: string): LocalResult {
	const verdict = verdictFor(score);
	return { score, verdict, feedback: verdict === "correct" ? "" : feedback, missing: verdict === "correct" ? [] : [q.topic] };
}

/** Click the bug: the lines you picked against the lines that are the answer, by overlap. */
function gradeHotspot(q: Question, chosen: number[]): LocalResult {
	const want = new Set(q.lines ?? []);
	const got = new Set(chosen);
	const hits = [...got].filter((l) => want.has(l)).length;
	const score = Math.round((hits / (new Set([...want, ...got]).size || 1)) * 100);
	const code = (q.code ?? "").split("\n");
	const show = (l: number) => `line ${l}: \`${(code[l - 1] ?? "").trim()}\``;
	return result(q, score, `The answer is ${[...want].sort((a, b) => a - b).map(show).join("; ")}.`);
}

/** The length of the longest run of items already in the right relative order. */
export function longestInOrder(seq: number[]): number {
	const tails: number[] = [];
	for (const x of seq) {
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (tails[mid] < x) lo = mid + 1;
			else hi = mid;
		}
		tails[lo] = x;
	}
	return tails.length;
}

/**
 * Order the steps: credit for the longest stretch you had in the right
 * relative order, so one step put in early costs one step, not everything
 * after it.
 */
function gradeOrder(q: Question, order: number[]): LocalResult {
	const items = q.items ?? [];
	const score = items.length && order.length === items.length ? Math.round((longestInOrder(order) / items.length) * 100) : 0;
	return result(q, score, `The order is:\n${items.map((it, i) => `${i + 1}. ${it}`).join("\n")}`);
}

/** Match: one point per left-hand item paired with its own right-hand side. */
function gradeMatch(q: Question, matches: number[]): LocalResult {
	const pairs = q.pairs ?? [];
	const wrong = pairs.filter((_, i) => matches[i] !== i);
	const score = pairs.length ? Math.round(((pairs.length - wrong.length) / pairs.length) * 100) : 0;
	return result(q, score, wrong.map(([l, r]) => `**${l}** goes with **${r}**.`).join(" "));
}

/** The blanks in cloze text, in order, each as its list of accepted answers. */
export function clozeBlanks(cloze: string): string[][] {
	return [...cloze.matchAll(/\{\{([^}]+)\}\}/g)].map((m) =>
		m[1].split("|").map((s) => s.trim()).filter(Boolean)
	);
}

/** The cloze text cut at its blanks: one more piece than there are blanks. */
export function clozePieces(cloze: string): string[] {
	return cloze.split(/\{\{[^}]+\}\}/);
}

/** Text answers compare without case, quotes, extra spaces or a trailing full stop. */
export function sameText(given: string, want: string): boolean {
	const n = (s: string) =>
		s.toLowerCase().replace(/[`"'“”‘’]/g, "").replace(/\s+/g, " ").replace(/[.,;:!?]+$/, "").trim();
	return n(given) !== "" && n(given) === n(want);
}

/** Fill in the blank: one point per blank that matches any of its accepted answers. */
function gradeCloze(q: Question, blanks: string[]): LocalResult {
	const want = clozeBlanks(q.cloze ?? "");
	const right = want.filter((alts, i) => alts.some((a) => sameText(blanks[i] ?? "", a))).length;
	const score = want.length ? Math.round((right / want.length) * 100) : 0;
	const answers = want.map((alts) => `**${alts[0]}**`).join(", ");
	return result(q, score, `The blank${want.length === 1 ? " is" : "s are"} ${answers}.`);
}

/**
 * Reads a register-style value: decimal, 0x or h-suffixed hex, 0b binary, or
 * a flag word (set/clear, true/false, on/off). Null if it is none of these.
 */
export function parseValue(s: string): bigint | null {
	const t = s.trim().toLowerCase().replace(/[_\s]/g, "");
	if (/^(true|set|on|yes)$/.test(t)) return BigInt(1);
	if (/^(false|clear|cleared|off|no)$/.test(t)) return BigInt(0);
	const neg = t.startsWith("-");
	const body = neg ? t.slice(1) : t;
	let v: bigint | null = null;
	if (/^0x[0-9a-f]+$/.test(body) || /^0b[01]+$/.test(body)) v = BigInt(body);
	else if (/^[0-9a-f]+h$/.test(body)) v = BigInt(`0x${body.slice(0, -1)}`);
	else if (/^\d+$/.test(body)) v = BigInt(body);
	if (v === null) return null;
	return neg ? -v : v;
}

function wrapTo(x: bigint, bits: number): bigint {
	const m = BigInt(2) ** BigInt(bits);
	return ((x % m) + m) % m;
}

/**
 * Whether a typed value matches the expected one. Numbers compare by value
 * whatever their base, so 16, 0x10 and 10h agree; BigInt keeps 64-bit
 * registers exact. -1 and 0xFFFFFFFF are the same bits in a 32-bit register,
 * so a negative answer counts if it matches at 32 or 64 bits. Anything else
 * compares as text, ignoring case.
 */
export function sameValue(given: string, want: string): boolean {
	const a = parseValue(given);
	const b = parseValue(want);
	if (a !== null && b !== null) {
		if (a === b) return true;
		return (a < 0 || b < 0) && [32, 64].some((bits) => wrapTo(a, bits) === wrapTo(b, bits));
	}
	const n = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
	return n(given) !== "" && n(given) === n(want);
}

/** Step-through trace: one point per value right, across every step. */
function gradeTrace(q: Question, cells: string[][]): LocalResult {
	let total = 0;
	const wrong: string[] = [];
	(q.trace ?? []).forEach((step, s) => {
		Object.entries(step.expect).forEach(([name, want], k) => {
			total += 1;
			if (!sameValue(cells[s]?.[k] ?? "", want)) wrong.push(`after line ${step.line}, **${name}** = \`${want}\``);
		});
	});
	const score = total ? Math.round(((total - wrong.length) / total) * 100) : 0;
	return result(q, score, `Not right: ${wrong.join("; ")}.`);
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
