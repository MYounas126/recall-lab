export type Tier = "easy" | "hard" | "brutal";
export const TIERS: Tier[] = ["easy", "hard", "brutal"];

export type QuestionType = "mcq" | "multi" | "short" | "command" | "image";

/** A single question in a bank. */
export interface Question {
	id: string;
	tier: Tier;
	type: QuestionType;
	/** Short slug used to aggregate weak areas, e.g. "width-suffixes". */
	topic: string;
	/** Markdown shown as the question. */
	prompt: string;
	/** Optional code/disassembly shown in a monospace block under the prompt. */
	code?: string;
	/** mcq / multi only. */
	choices?: string[];
	/** mcq: index of the correct choice. multi: indices of all correct choices. */
	answer?: number | number[];
	/** short / command: regexes (case-insensitive) that count as an instant pass. */
	accept?: string[];
	/** short / command / image: the model answer, used for AI grading and reveal. */
	expected?: string;
	/** Points a full-credit answer must make. Drives AI grading and the reveal. */
	rubric?: string[];
	/** Shown after answering, whatever the verdict. */
	explain: string;
	/** Where in the note this is covered, e.g. "03 Registers#2.5 The width suffixes". */
	ref?: string;
	/** Lecture timestamp, e.g. "P1 02:21". */
	timestamp?: string;
	/** Slide number in the source deck. */
	slide?: number;
	/** Which course skill axis this question feeds. Falls back to the course's topic map. */
	axis?: string;
}

/** One spoke of the skill radar. */
export interface SkillAxis {
	id: string;
	label: string;
	/** Topics that count toward this axis when a question carries no explicit `axis`. */
	topics?: string[];
}

/**
 * A course groups the banks under one vault folder and defines the skill axes
 * the radar is drawn from.
 */
export interface Course {
	id: string;
	title: string;
	/** Vault folder whose notes belong to this course. */
	folder: string;
	axes: SkillAxis[];
}

export interface Bank {
	id: string;
	title: string;
	/** Vault path of the note this bank drills. */
	note?: string;
	questions: Question[];
}

/**
 * A question's identity across the whole vault. Question ids are only unique
 * within their bank — generated banks all number theirs q1, q2… — so anything
 * tracked per question must key on the bank as well.
 */
export function qkey(bankId: string, questionId: string): string {
	return `${bankId}::${questionId}`;
}

/** A question paired with the bank it belongs to, as an exam asks it. */
export interface ExamItem {
	bankId: string;
	q: Question;
}

export type Verdict = "correct" | "partial" | "incorrect";

/** How sure you said you were. "unsure" is a plain Submit: no claim either way. */
export type Confidence = "guess" | "unsure" | "sure";

export interface Attempt {
	ts: string;
	sessionId: string;
	bankId: string;
	questionId: string;
	tier: Tier;
	type: QuestionType;
	topic: string;
	/** What the learner actually entered. For image answers, a short note, not the bytes. */
	response: string;
	score: number;
	verdict: Verdict;
	feedback: string;
	missing: string[];
	/**
	 * "local" = deterministic marking, "ai" = model-graded, "self" = self-reported,
	 * "error" = the marking failed; kept for the record, never scheduled or scored.
	 */
	gradedBy: "local" | "ai" | "self" | "error";
	ms: number;
	/** How sure you said you were. Absent on answers from before it was asked, and on skips. */
	confidence?: Confidence;
	/**
	 * What you typed from memory before the options were shown, in
	 * recall-first mode: empty if you only thought of it, absent when the
	 * options were shown straight away.
	 */
	recalled?: string;
}

export interface SessionSummary {
	id: string;
	ts: string;
	bankId: string;
	bankTitle?: string;
	/** "mixed" for an exam that ramps through all three levels; "review" for a spaced review. */
	tier: Tier | "mixed" | "review";
	asked: number;
	meanScore: number;
	grade: string;
	weakTopics: string[];
	/** Claude's end-of-session coaching, once it has come back. */
	coaching?: string;
	/** True until Claude's coaching comes back. */
	coachingPending?: boolean;
}

export interface ProgressFile {
	version: 1;
	attempts: Attempt[];
	sessions: SessionSummary[];
	/** Vault paths of notes marked Complete, with when. */
	completed?: Record<string, string>;
	/** Lab progress, keyed by lab id. */
	labs?: Record<string, LabProgress>;
	/**
	 * Finished days by local date (YYYY-MM-DD), kept as first worked out so a
	 * later change of settings cannot rewrite the streak.
	 */
	days?: Record<string, DayLog>;
}

/** How one finished day went. */
export interface DayLog {
	/** Answers given that day. */
	answers: number;
	/** Whether nothing was left overdue when the day ended. */
	clear: boolean;
}

export const EMPTY_PROGRESS: ProgressFile = { version: 1, attempts: [], sessions: [], completed: {}, labs: {} };

export function letterGrade(score: number): string {
	if (score >= 93) return "A";
	if (score >= 90) return "A-";
	if (score >= 87) return "B+";
	if (score >= 83) return "B";
	if (score >= 80) return "B-";
	if (score >= 77) return "C+";
	if (score >= 70) return "C";
	if (score >= 60) return "D";
	return "F";
}

// ---------------------------------------------------------------- labs

/** One file a lab materialises into its workspace. */
export interface LabFile {
	path: string;
	content: string;
	/** chmod +x after writing — setup scripts need it. */
	executable?: boolean;
}

/**
 * A hands-on lab. The flag's plaintext is never stored here: it lives only
 * inside the generated artifact, so the only way to get it is to do the work.
 */
export interface Lab {
	id: string;
	courseId: string;
	/** Vault path of the note this lab drills. */
	note: string;
	title: string;
	axis: string;
	tier: Tier;
	/** Markdown: what to do, and what counts as done. */
	brief: string;
	/** Shell commands to get started, shown for review — never run by the plugin. */
	setup: string;
	files: LabFile[];
	/** Revealed one at a time, each costing marks. */
	hints: string[];
	/** sha256 of the flag, lowercase hex. The flag itself is not stored. */
	flagHash: string;
	/** e.g. "flag{...}" — shown as a placeholder. */
	flagFormat: string;
	/** How it was meant to be solved. Shown after a solve or a give-up. */
	solution: string;
	/** Roughly how long it should take, in minutes. */
	minutes?: number;
}

export interface LabProgress {
	labId: string;
	/** Wrong flags submitted. */
	attempts: number;
	hintsUsed: number;
	solvedAt?: string;
	gaveUpAt?: string;
	firstOpenedAt?: string;
}

/** Full marks for a clean solve; hints and wrong flags cost. */
export function labScore(p: LabProgress): number {
	if (!p.solvedAt) return 0;
	const hintCost = p.hintsUsed * 15;
	const attemptCost = Math.max(0, p.attempts - 1) * 5;
	return Math.max(25, 100 - hintCost - attemptCost);
}
