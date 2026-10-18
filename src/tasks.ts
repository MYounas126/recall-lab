import { App, Notice, TFile, normalizePath } from "obsidian";
import { ClaudeCli } from "./claude";
import { Store } from "./store";
import { Attempt, Bank, BlurtResult, Course, Diagnosis, Lab, Question, QuestionType, TeachResult, Turn, Verdict } from "./types";
import type { Leech } from "./leeches";
import { blurtPrompt, headingsOf, parseBlurt, sectionsOf } from "./blurt";
import { parseStudent, parseTeachScore, studentPrompt, teachScorePrompt } from "./teach";
import { hashFlag, validateLab, detectToolchain, describeToolchain } from "./labs";
import type { Strictness } from "./settings";
import { hashText } from "./util";
import { answeredTo, plain } from "./answers";

export interface MarkResult {
	score: number;
	verdict: Verdict;
	feedback: string;
	missing: string[];
	improve?: string;
	/** When not correct: a question that steers toward what was missed without giving it away. */
	nudge?: string;
}

/** A second try can earn at most this share of the marks: the nudge did part of the work. */
export const SECOND_TRY_CAP = 0.75;

/**
 * The mark for an answer given again after a nudge. It keeps the better of
 * the first score and the capped second, with that try's feedback, and is
 * never "correct": an answer that needed a nudge is partly known, which
 * schedules it to come back soon. `secondWon` says which try the mark is.
 */
export function combineTries(first: MarkResult, second: MarkResult): MarkResult & { secondWon: boolean } {
	const capped = Math.round(second.score * SECOND_TRY_CAP);
	const secondWon = capped > first.score;
	const won = secondWon ? second : first;
	const score = Math.max(first.score, capped);
	return {
		score,
		verdict: score >= 40 ? "partial" : "incorrect",
		feedback: (secondWon ? `Second try: ${second.feedback}` : `Your first try stands: ${first.feedback}`).trim(),
		missing: won.missing,
		improve: won.improve,
		secondWon,
	};
}

/** The prompt that marks one written answer. Pure, so it can be tested. */
export function markPrompt(q: Question, answer: string, image: boolean, strictness: Strictness): string {
	return [
		"You are marking one exam answer. Reply with ONLY a JSON object, no prose and no code fence.",
		"",
		STRICTNESS[strictness],
		"Score as the share of rubric points genuinely made, then subtract for anything stated that is",
		"WRONG rather than merely absent — a confident false claim costs more than an omission.",
		"",
		`QUESTION: ${q.prompt}`,
		q.code ? `CODE SHOWN:\n${q.code}` : "",
		`MODEL ANSWER: ${q.expected ?? "(none given)"}`,
		`RUBRIC (each point must be made):\n${(q.rubric ?? []).map((r, i) => `${i + 1}. ${r}`).join("\n")}`,
		"",
		`THE LEARNER'S ANSWER:\n${answer || "(left blank)"}`,
		image ? "\n(The learner also attached a screenshot. Judge the written answer on its own; say in the feedback that you could not see the image.)" : "",
		"",
		'Reply exactly: {"score":<0-100>,"verdict":"correct"|"partial"|"incorrect","feedback":"<1-2 sentences addressed to the learner, naming exactly what was wrong>","missing":["<rubric points not made, verbatim>"],"improve":"<one concrete sentence on what to study>","nudge":"<see below>"}',
		'verdict is "correct" at 90+, "partial" 40-89, "incorrect" below 40.',
		'"nudge": if the verdict is not "correct", ONE short question that steers the learner toward the most important',
		"missed point WITHOUT stating it, so they can try again; empty if correct.",
	].filter(Boolean).join("\n");
}

const STRICTNESS: Record<Strictness, string> = {
	brutal:
		"Mark BRUTALLY. Award no sympathy marks: a rubric point that is not actually made is not credited, " +
		"however confident the answer sounds. Hedging, restating the question, or naming the right term without " +
		"the mechanism earns nothing for that point.",
	normal: "Mark fairly. Credit a rubric point that is clearly meant, even if loosely worded.",
	lenient: "Mark leniently. Credit the idea; penalise only outright errors.",
};

/** Everything the plugin asks Claude to do, with the file I/O kept on this side. */
export class Tasks {
	constructor(
		private app: App,
		private cli: ClaudeCli,
		private store: Store,
		private strictness: () => Strictness,
		private banksFolder: () => string,
		private coursesFolder: () => string,
		private labsFolder: () => string = () => "_quiz/labs"
	) {}

	// ---------------------------------------------------------------- marking

	async markAnswer(q: Question, answer: string, image?: string): Promise<MarkResult | { error: string }> {
		const res = await this.cli.askJson<MarkResult>(markPrompt(q, answer, Boolean(image), this.strictness()), 120000);
		if (!res.ok) return { error: res.error };
		const d = res.data;
		const verdict = d.verdict === "correct" || d.verdict === "partial" ? d.verdict : "incorrect";
		const nudge = verdict !== "correct" && d.nudge ? String(d.nudge).trim() : "";
		return {
			score: clamp(d.score),
			verdict,
			feedback: String(d.feedback ?? ""),
			missing: Array.isArray(d.missing) ? d.missing.map(String) : [],
			improve: d.improve ? String(d.improve) : undefined,
			...(nudge ? { nudge } : {}),
		};
	}

	// --------------------------------------------------------------- coaching

	async coachSession(input: {
		title: string;
		meanScore: number;
		grade: string;
		answers: { topic: string; question: string; yourAnswer: string; score: number; missed: string[] }[];
		axes: { label: string; score: number }[];
	}): Promise<string | { error: string }> {
		const prompt = [
			"A learner has just finished an exam. Write their feedback. Reply with ONLY the feedback text as",
			"markdown — no JSON, no preamble, no heading.",
			"",
			"Look for the PATTERN across the answers, which is the thing a per-question mark cannot see: a topic",
			"they keep missing, a habit of answering the adjacent question, confidence outrunning precision.",
			"Say what the pattern is, name the ONE area to fix first and why that one, and give a concrete next",
			"action. Reference their weakest skill area. Do not list every mistake — they can already see those.",
			"Three to six sentences. Address them as 'you'. Be blunt and specific; flattery costs them real marks later.",
			"",
			`EXAM: ${input.title} — ${input.meanScore}% (${input.grade})`,
			"",
			"SKILL AREAS:",
			...input.axes.map((a) => `- ${a.label}: ${a.score}%`),
			"",
			"ANSWERS:",
			...input.answers.map(
				(a, i) =>
					`${i + 1}. [${a.topic}] ${a.score}% — Q: ${oneLine(a.question)} | They said: ${oneLine(a.yourAnswer) || "(blank)"}` +
					(a.missed.length ? ` | Missed: ${a.missed.join("; ")}` : "")
			),
		].join("\n");

		const res = await this.cli.ask(prompt, 180000);
		if (!res.ok) return { error: res.error ?? "unknown error" };
		return res.text.trim();
	}

	// ------------------------------------------------------------------ labs

	/**
	 * Writes hands-on labs for a note. The flag is invented by Claude, hidden
	 * inside the artifact, and returned alongside so the plugin can store only
	 * its hash — the plaintext never reaches the vault.
	 */
	async generateLabs(notePath: string, course: Course, count: number): Promise<Lab[] | { error: string }> {
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) return { error: `${notePath} is not a note.` };
		const content = await this.app.vault.cachedRead(file);
		const title = file.basename;

		const prompt = labPrompt(title, content, notePath, course, count, describeToolchain(detectToolchain()));
		const res = await this.cli.askJson<{ labs: (Lab & { flag: string })[] }>(prompt, 480000);
		if (!res.ok) return { error: res.error };

		const raw = Array.isArray(res.data?.labs) ? res.data.labs : [];
		if (!raw.length) return { error: "Claude returned no labs." };

		const axes = new Set(course.axes.map((a) => a.id));
		const out: Lab[] = [];
		const rejected: string[] = [];
		for (const [i, r] of raw.entries()) {
			if (!r.flag || typeof r.flag !== "string") {
				rejected.push(`lab ${i + 1}: came back without a flag`);
				continue;
			}
			const lab: Lab = {
				id: `${course.id}-${slug(title)}-lab-${i + 1}`,
				courseId: course.id,
				note: notePath,
				title: String(r.title ?? `Lab ${i + 1}`),
				axis: axes.has(r.axis) ? r.axis : course.axes[0].id,
				tier: ["easy", "hard", "brutal"].includes(r.tier) ? r.tier : "hard",
				brief: String(r.brief ?? ""),
				setup: String(r.setup ?? ""),
				files: Array.isArray(r.files) ? r.files : [],
				hints: Array.isArray(r.hints) ? r.hints.map(String) : [],
				flagHash: hashFlag(r.flag),
				flagFormat: String(r.flagFormat ?? "flag{...}"),
				solution: String(r.solution ?? ""),
				minutes: typeof r.minutes === "number" ? r.minutes : undefined,
			};

			// The walkthrough and hints routinely quote the flag. Everything the
			// learner can read before solving is redacted, so the only copy left
			// is the one hidden in the artifact.
			const redact = (text: string): string =>
				text.split(r.flag).join(`\`${lab.flagFormat}\``).split(bareFlag(r.flag)).join("…");
			lab.brief = redact(lab.brief);
			lab.solution = redact(lab.solution);
			lab.hints = lab.hints.map(redact);

			const readable = [lab.brief, lab.solution, lab.setup, ...lab.hints, lab.title].join("\n");
			if (readable.includes(r.flag) || readable.includes(bareFlag(r.flag))) {
				rejected.push(`"${lab.title}": still shows its flag outside the artifact`);
				continue;
			}

			// The flag must be DERIVABLE from the artifact, never sitting in it as
			// plain text. Generators like to add an "optional self-check" that
			// strcmp's against the flag, which `strings` would hand straight over.
			const haystack = lab.files.map((f) => f.content).join("\n");
			const bare = bareFlag(r.flag);
			if (haystack.includes(r.flag) || haystack.includes(bare)) {
				rejected.push(`"${lab.title}": flag in plain text, \`strings\` would solve it`);
				continue;
			}
			if (!looksEncoded(haystack, bare) && !buildsFlag(haystack, bare)) {
				rejected.push(`"${lab.title}": its flag is not actually in the file, so it could never be solved`);
				continue;
			}

			const problem = validateLab(lab);
			if (problem) {
				rejected.push(`"${lab.title}": ${problem}`);
				continue;
			}
			out.push(lab);
		}

		if (!out.length) {
			return {
				error:
					`None of the ${raw.length} labs Claude wrote were usable. ` +
					rejected.join("; ") +
					". This note may not have enough technical content to build a challenge from.",
			};
		}
		if (rejected.length) {
			console.warn(`Recall Lab: kept ${out.length} labs, dropped ${rejected.length}:`, rejected);
		}

		for (const lab of out) {
			await this.writeFile(
				normalizePath(`${this.labsFolder()}/${lab.id}.json`),
				JSON.stringify(lab, null, 2) + "\n"
			);
		}
		return out;
	}

	// ----------------------------------------------------------- teach it back

	/** The student's next question about a note you are explaining, or its thanks when you are done. */
	async studentReply(notePath: string, turns: Turn[], questionsLeft: number): Promise<{ reply: string; done: boolean } | { error: string }> {
		const note = this.app.vault.getAbstractFileByPath(notePath);
		if (!(note instanceof TFile)) return { error: `${notePath} is not a note.` };
		const content = await this.app.vault.cachedRead(note);
		const res = await this.cli.askJson<unknown>(studentPrompt(note.basename, content, turns, questionsLeft), 120000);
		if (!res.ok) return { error: res.error };
		const reply = parseStudent(res.data);
		return typeof reply === "string" ? { error: `The student's reply was not usable: ${reply}.` } : reply;
	}

	/** Scores a whole teach-it-back conversation against the note's key points. */
	async scoreTeachBack(notePath: string, turns: Turn[]): Promise<TeachResult | { error: string }> {
		const note = this.app.vault.getAbstractFileByPath(notePath);
		if (!(note instanceof TFile)) return { error: `${notePath} is not a note.` };
		const content = await this.app.vault.cachedRead(note);
		const sections = headingsOf(content).map((h) => h.text);
		const res = await this.cli.askJson<unknown>(teachScorePrompt(note.basename, content, turns, sections), 180000);
		if (!res.ok) return { error: res.error };
		const result = parseTeachScore(res.data, sections, notePath, turns, new Date());
		return typeof result === "string" ? { error: `Claude's score was not usable: ${result}.` } : result;
	}

	// --------------------------------------------------------- write it down

	/** Compares what you wrote from memory with the note, section by section. */
	async checkBlurt(notePath: string, written: string): Promise<BlurtResult | { error: string }> {
		const note = this.app.vault.getAbstractFileByPath(notePath);
		if (!(note instanceof TFile)) return { error: `${notePath} is not a note.` };
		const content = await this.app.vault.cachedRead(note);
		// Obsidian's own reading of the headings where it has one.
		const cached = this.app.metadataCache?.getFileCache(note)?.headings;
		const headings = cached?.length ? cached.map((h) => ({ text: h.heading, level: h.level })) : headingsOf(content);
		const sections = sectionsOf(headings);
		// A note with no headings is one section, named after the note.
		if (!sections.length) sections.push({ name: note.basename, link: "" });
		const res = await this.cli.askJson<unknown>(
			blurtPrompt(note.basename, content, written, sections.map((s) => s.name)),
			180000
		);
		if (!res.ok) return { error: res.error };
		const result = parseBlurt(res.data, sections, notePath, new Date());
		return typeof result === "string" ? { error: `Claude's comparison was not usable: ${result}.` } : result;
	}

	// ---------------------------------------------------------------- clinic

	/** Asks Claude why you keep missing a question, for a lesson and a fresh question. */
	async diagnoseLeech(leech: Leech, notePath: string | undefined): Promise<Diagnosis | { error: string }> {
		const note = notePath ? this.app.vault.getAbstractFileByPath(notePath) : null;
		const content = note instanceof TFile ? await this.app.vault.cachedRead(note) : "";
		const title = note instanceof TFile ? note.basename : "(no note)";
		const res = await this.cli.askJson<unknown>(leechPrompt(leech.item.q, leech.wrong, title, content), 240000);
		if (!res.ok) return { error: res.error };
		const diagnosis = parseDiagnosis(leech.item.q, res.data, new Date());
		return typeof diagnosis === "string" ? { error: `Claude's diagnosis was not usable: ${diagnosis}.` } : diagnosis;
	}

	// --------------------------------------------------------------- variants

	/** Writes variants for some of a bank's questions into the bank file. Returns how many were added. */
	async generateVariants(bank: Bank, path: string, ids: string[], perQuestion = 2): Promise<number | { error: string }> {
		const targets = bank.questions.filter((q) => ids.includes(q.id));
		if (!targets.length) return 0;
		const { title, content } = await this.noteOf(bank);
		const res = await this.cli.askJson<{ variants?: Record<string, Question[]> }>(
			variantPrompt(title, content, targets, perQuestion),
			300000
		);
		if (!res.ok) return { error: res.error };
		return this.mergeIntoBank(path, targets, res.data?.variants, {
			field: "variants",
			label: "variants",
			check: checkVariant,
			// New variants join the ones already there.
			id: (parent, n) => `${parent.id}~v${(parent.variants?.length ?? 0) + n + 1}`,
			replace: false,
		});
	}

	/** Writes guided steps for some of a bank's problems into the bank file. Returns how many problems got steps. */
	async generateSteps(bank: Bank, path: string, ids: string[]): Promise<number | { error: string }> {
		const targets = bank.questions.filter((q) => ids.includes(q.id));
		if (!targets.length) return 0;
		const { title, content } = await this.noteOf(bank);
		const res = await this.cli.askJson<{ steps?: Record<string, Question[]> }>(stepsPrompt(title, content, targets), 300000);
		if (!res.ok) return { error: res.error };
		const added = await this.mergeIntoBank(path, targets, res.data?.steps, {
			field: "steps",
			label: "steps",
			check: checkStep,
			id: (parent, n) => `${parent.id}~s${n + 1}`,
			// A fresh set replaces an old one: steps only make sense as a whole.
			replace: true,
			minimum: 2,
		});
		return added;
	}

	/** A bank's note, for the prompts that need its content. */
	private async noteOf(bank: Bank): Promise<{ title: string; content: string }> {
		const note = bank.note ? this.app.vault.getAbstractFileByPath(bank.note) : null;
		if (!(note instanceof TFile)) return { title: bank.title, content: "" };
		return { title: note.basename, content: await this.app.vault.cachedRead(note) };
	}

	/**
	 * Saves questions Claude made for some of a bank's questions — variants or
	 * steps — into the bank file, after checking each. The file is read again
	 * just before the write, so an edit made while Claude was working is kept,
	 * and a question that changed meanwhile (the quiz rebuilt, say) gets
	 * nothing: what Claude made was for the question as it was.
	 * Returns how many questions were added to (or, for steps, how many parents
	 * got a set); with nothing usable it writes nothing and says why.
	 */
	private async mergeIntoBank(
		path: string,
		targets: Question[],
		made: Record<string, Question[]> | undefined,
		how: {
			field: "variants" | "steps";
			label: string;
			check: (parent: Question, q: Question) => string | null;
			id: (parent: Question, n: number) => string;
			replace: boolean;
			/** Fewer usable than this, and a parent gets none. */
			minimum?: number;
		}
	): Promise<number | { error: string }> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return { error: `${path} is gone.` };
		let fresh: Bank;
		try {
			fresh = JSON.parse(await this.app.vault.read(file)) as Bank;
			if (!Array.isArray(fresh?.questions)) throw new Error("it has no questions");
		} catch (e) {
			return { error: `${path} could not be read back (${(e as Error).message}).` };
		}

		let added = 0;
		const rejected: string[] = [];
		for (const target of targets) {
			const parent = fresh.questions.find((x) => x.id === target.id);
			const raw = made?.[target.id];
			if (!parent || !Array.isArray(raw)) continue;
			if (contentId(parent) !== contentId(target)) {
				rejected.push(`${parent.id}: the question changed while its ${how.label} were written`);
				continue;
			}
			const kept: Question[] = [];
			for (const q of raw) {
				const problem = how.check(parent, q);
				if (problem) {
					rejected.push(`${parent.id}: ${problem}`);
					continue;
				}
				q.id = how.id(parent, kept.length);
				kept.push(q);
			}
			if (kept.length < (how.minimum ?? 1)) continue;
			parent[how.field] = how.replace ? kept : [...(parent[how.field] ?? []), ...kept];
			added += how.replace ? 1 : kept.length;
		}
		if (rejected.length) console.warn(`Recall Lab: dropped ${rejected.length} ${how.label}:`, rejected);
		if (!added) {
			return { error: `None of Claude's ${how.label} were usable${rejected.length ? `: ${rejected.slice(0, 3).join("; ")}` : ""}.` };
		}
		await this.writeFile(path, JSON.stringify(fresh, null, 2) + "\n");
		return added;
	}

	// ------------------------------------------------------------- generation

	/** Reads a note, asks Claude for a bank, writes it, returns the bank. */
	async generateBank(
		notePath: string,
		course: Course,
		practical: boolean
	): Promise<Bank | { error: string }> {
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) return { error: `${notePath} is not a note.` };
		const content = await this.app.vault.cachedRead(file);
		const title = file.basename;

		const prompt = bankPrompt(title, content, notePath, course, practical);

		const res = await this.cli.askJson<Bank>(prompt, 420000);
		if (!res.ok) return { error: res.error };

		const bank = res.data;
		const problem = validateBank(bank, course);
		if (problem) return { error: problem };

		bank.id = bankId(course, title);
		bank.note = notePath;
		const path = normalizePath(`${this.banksFolder()}/${bank.id}.json`);
		await this.writeFile(path, JSON.stringify(bank, null, 2) + "\n");
		return bank;
	}

	/** Reads a folder's notes, asks Claude for skill axes, writes the course. */
	async generateCourse(folder: string): Promise<Course | { error: string }> {
		const notes = this.store.notesIn(folder);
		if (!notes.length) return { error: "That folder has no notes." };

		// A sample of each note is enough to characterise the subject.
		const samples: string[] = [];
		for (const path of notes.slice(0, 25)) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) continue;
			const text = await this.app.vault.cachedRead(f);
			samples.push(`### ${f.basename}\n${text.slice(0, 1200)}`);
		}

		const prompt = [
			"Define a study course from the notes below. Reply with ONLY a JSON object, no prose and no fence.",
			"",
			"Choose 5 to 7 skill AXES. They are the durable skill areas of the SUBJECT, not the chapter list —",
			"pick areas that still make sense when the folder has three times as many notes. Name them as skills",
			"a person could claim on a CV, not as note titles.",
			"",
			'{"id":"<kebab-slug>","title":"<readable course title>","folder":"<folder verbatim>",',
			' "axes":[{"id":"<kebab-slug>","label":"<Skill Area>"}]}',
			"",
			`FOLDER: ${folder}`,
			`NOTES (${notes.length} total${notes.length > 25 ? ", first 25 sampled" : ""}):`,
			...samples,
		].join("\n");

		const res = await this.cli.askJson<Course>(prompt, 240000);
		if (!res.ok) return { error: res.error };

		const course = res.data;
		if (!course?.id || !Array.isArray(course.axes) || course.axes.length < 3) {
			return { error: "Claude did not return a usable course definition." };
		}
		course.folder = folder;
		course.id = slug(course.id);
		course.axes = course.axes.map((a) => ({ id: slug(a.id), label: String(a.label) }));

		const path = normalizePath(`${this.coursesFolder()}/${course.id}.json`);
		await this.writeFile(path, JSON.stringify(course, null, 2) + "\n");
		return course;
	}

	private async writeFile(path: string, body: string): Promise<void> {
		const parts = path.split("/").slice(0, -1);
		let acc = "";
		for (const part of parts) {
			acc = acc ? `${acc}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(acc)) {
				try { await this.app.vault.createFolder(acc); } catch { /* raced */ }
			}
		}
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) await this.app.vault.modify(existing, body);
		else await this.app.vault.create(path, body);
	}
}

/**
 * Heuristic: the flag may be split, XOR'd or base64'd inside the artifact
 * rather than sitting there in plaintext, which is the whole point. Accept it
 * if a decent run of the flag's characters appears, or if the source clearly
 * builds it.
 */
/** The inside of flag{...}, which is what tends to leak into prose. */
function bareFlag(flag: string): string {
	return flag.replace(/^flag\{|\}$/g, "");
}

/**
 * The flag may be assembled character by character — immediates in a byte
 * blob, entries in an array. Accept it when most of its characters are present
 * as byte literals, which is what that looks like.
 */
function buildsFlag(haystack: string, bare: string): boolean {
	const chars = [...new Set(bare.split(""))].filter((c) => /[\x21-\x7e]/.test(c));
	if (chars.length < 4) return false;
	const present = chars.filter((c) => {
		const hex = c.charCodeAt(0).toString(16).padStart(2, "0");
		return (
			haystack.toLowerCase().includes(`0x${hex}`) ||
			haystack.includes(`'${c}'`) ||
			haystack.includes(`"${c}"`)
		);
	});
	return present.length / chars.length >= 0.7;
}

function looksEncoded(haystack: string, bare: string): boolean {
	if (bare.length < 6) return false;
	const b64 = Buffer.from(bare, "utf8").toString("base64").replace(/=+$/, "");
	if (haystack.includes(b64)) return true;
	const hex = Buffer.from(bare, "utf8").toString("hex");
	if (haystack.toLowerCase().includes(hex.toLowerCase())) return true;
	// A contiguous half of the flag is enough to show it is really in there.
	const half = bare.slice(0, Math.ceil(bare.length / 2));
	return half.length >= 5 && haystack.includes(half);
}

/** The prompt that produces hands-on labs. Pure, so it can be tested. */
export function labPrompt(
	title: string,
	content: string,
	notePath: string,
	course: Course,
	count: number,
	toolchain: string
): string {
	return [
		`Write ${count} hands-on LABS for the note below. Reply with ONLY a JSON object, no prose, no fence.`,
		count === 3
			? "Exactly one `easy`, one `hard` and one `brutal`. Easy = apply one rule carefully. Hard = combine " +
				"two or three rules, or decode something. Brutal = several steps, a trap the note warns about, " +
				"and no hand-holding."
			: `Spread them across the easy, hard and brutal tiers.`,
		"",
		"A lab is a CTF-style challenge, not a quiz question: the learner is handed ONE source file and must",
		"work out a FLAG hidden inside it by reading and reasoning about the code.",
		"",
		"RULES",
		"- Provide exactly ONE file: a source file the learner reads. No makefiles, no scripts, no archives.",
		"- IT MUST BE SOLVABLE BY READING ALONE. No compiler, no debugger, no disassembler, nothing to",
		"  install, nothing to run. Arithmetic the learner can do in their head or with a one-line python3",
		"  is fine; anything needing a build is not.",
		"- `setup` is therefore just how to open it, e.g. `cat src/challenge.c`. Never put build or install",
		"  commands in it.",
		"- You may mention in the brief that they can optionally compile or run it to check themselves, but",
		"  the challenge must never depend on that.",
		`- For reference only, this machine has: ${toolchain}`,
		"- Invent a distinct random flag per lab, formatted flag{...} with 8-20 characters inside.",
		"- The flag MUST be recoverable from the files you provide — embedded in the source, XOR'd into a",
		"  buffer, printed only on a condition, hidden in a constant. It must NOT be guessable from the",
		"  brief, and the brief must never contain it.",
		"- The work must exercise the note's actual content: tracing register widths by hand, applying the",
		"  zero-extension rule, mapping register numbers to names, decoding an instruction encoding.",
		"- THE FLAG MUST NEVER APPEAR AS A LITERAL STRING IN THE FILE, not even inside a comment, a usage",
		"  message, or an \"optional self-check\". `strings` must not reveal it. Build it from constants the",
		"  learner has to combine, or XOR it against a value they must derive. If you want to give them a",
		"  way to check their answer, compare against a hash or an encoded form, never against the flag.",
		"- `setup` is the shell commands to get going (compile, run). Keep it to a few lines. It is shown to",
		"  the learner to read before they run it, so keep it obvious and harmless.",
		"- 2 to 4 `hints`, each giving away a little more, the last one nearly telling them.",
		"- `solution` explains how it was meant to be solved, for after they finish.",
		"",
		"SHAPE",
		'{"labs":[{',
		'  "title":"<short name>","tier":"easy|hard|brutal","axis":"<axis id>","minutes":20,',
		'  "brief":"<markdown: the task, and what done looks like>",',
		'  "setup":"gcc -g -O0 -o target src/target.c\n./target",',
		'  "files":[{"path":"src/target.c","content":"<full file>","executable":false}],',
		'  "hints":["...","..."],"flag":"flag{...}","flagFormat":"flag{...}",',
		'  "solution":"<markdown walkthrough>"}]}',
		"",
		`Use axis ids from: ${course.axes.map((a) => a.id).join(", ")}`,
		"",
		`NOTE TITLE: ${title}`,
		"NOTE CONTENT:",
		"---",
		content,
		"---",
	].join("\n");
}

/** The prompt that asks Claude to diagnose a leech. Pure, so it can be tested. */
export function leechPrompt(q: Question, wrong: Attempt[], noteTitle: string, noteContent: string): string {
	const { variants: _v, steps: _s, ...question } = q;
	return [
		"A learner keeps getting the question below wrong. Diagnose why. Reply with ONLY a JSON object, no prose",
		"and no code fence.",
		"",
		"Read their wrong answers together and find the ONE misunderstanding they share: a rule they have",
		"backwards, two ideas they conflate, a step they skip. Name it plainly, addressed to them as \"you\".",
		"Then teach it in exactly three short steps, each building on the last: what the rule really is, why",
		"it holds, and how to apply it to a case like this one. Use the note's own facts and terms.",
		"",
		"Finally, write ONE fresh question on the same idea, of the same type and with every field that type",
		"needs, that someone with the misunderstanding would get wrong and someone without it would get right.",
		"",
		'SHAPE: {"misconception":"<one or two sentences>","lesson":["<step 1>","<step 2>","<step 3>"],',
		' "question":{"type":"' + q.type + '","prompt":"...", ...every field the type needs..., "explain":"..."}}',
		"",
		"THE QUESTION:",
		JSON.stringify(question, null, 1),
		"",
		"THEIR WRONG ANSWERS, OLDEST FIRST (some were to a variant of the question or to an earlier practice",
		"question on the same idea; each says so, and the variant's prompt is given):",
		...wrong.map((a, i) => `${i + 1}. ${answeredToLabel(q, a)}They said: ${a.response || "(blank)"}${a.feedback ? ` | Marked: ${a.feedback}` : ""}`),
		"",
		`NOTE TITLE: ${noteTitle}`,
		"NOTE CONTENT:",
		"---",
		noteContent,
		"---",
	].join("\n");
}

/** For the prompt: which question a wrong answer was given to, when not the original. */
function answeredToLabel(q: Question, a: Attempt): string {
	const to = answeredTo(a);
	if (to === "practice") return "[To the earlier practice question] ";
	if (to === "variant") {
		const v = q.variants?.find((x) => x.id === a.variant);
		return v ? `[To a variant: ${JSON.stringify(v.prompt)}] ` : "[To a variant] ";
	}
	return "";
}

/**
 * Turns Claude's reply into a diagnosis, checking the fresh question the
 * same way a variant is checked. Returns what is wrong as a string.
 */
export function parseDiagnosis(original: Question, data: unknown, now: Date): Diagnosis | string {
	const d = (data ?? {}) as { misconception?: unknown; lesson?: unknown; question?: unknown };
	const misconception = typeof d.misconception === "string" ? d.misconception.trim() : "";
	if (!misconception) return "it named no misconception";
	const lesson = Array.isArray(d.lesson) ? d.lesson.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 5) : [];
	if (!lesson.length) return "it gave no lesson";
	const question = d.question as Question;
	const problem = checkVariant(original, question);
	if (problem) return `its fresh question ${problem}`;
	question.id = `${original.id}~fix`;
	return { at: now.toISOString(), misconception, lesson, question };
}

/** The prompt that asks for variants of some questions. Pure, so it can be tested. */
export function variantPrompt(title: string, content: string, questions: Question[], perQuestion: number): string {
	return [
		`Write ${perQuestion} VARIANTS of each question below. Reply with ONLY a JSON object, no prose and no fence.`,
		"",
		"A variant tests exactly the same fact or skill as its original but looks different: another register,",
		"other numbers, a different scenario or wording, new distractors. Someone who only memorised the",
		"original's answer — its position, wording or shape — must not be able to answer the variant from that.",
		"Someone who understands the idea must find it no harder.",
		"",
		"RULES",
		"- Keep each variant's \"type\" the same as its original's, with every field that type needs.",
		"- Every fact must come from the note. Vary the surface, never the truth.",
		"- For mcq, \"answer\" is a 0-based index into \"choices\" and must point at the option your \"explain\"",
		"  justifies. Vary which position the right answer sits in.",
		"",
		'SHAPE: {"variants":{"<original id>":[{"type":"...","prompt":"...", ...every field the type needs..., "explain":"..."}]}}',
		"",
		"QUESTIONS:",
		JSON.stringify(questions.map(({ variants: _v, steps: _s, ...q }) => q), null, 1),
		"",
		`NOTE TITLE: ${title}`,
		"NOTE CONTENT:",
		"---",
		content,
		"---",
	].join("\n");
}

/**
 * Checks one variant against its original, and fills in what it shares with
 * it — tier, topic, axis and ref — since it tests the same idea. Returns
 * what is wrong, or null if it is usable.
 */
export function checkVariant(original: Question, v: Question): string | null {
	if (!v || typeof v !== "object") return "is not a question";
	if (v.type !== original.type) return `is a ${v.type} question, not a ${original.type}`;
	if (!v.prompt?.trim()) return "has no prompt";
	v.tier = original.tier;
	v.topic = original.topic;
	if (original.axis) v.axis = original.axis;
	if (original.ref) v.ref = original.ref;
	if (!v.explain) v.explain = "";
	// A variant or a practice question is asked as it is: steps echoed from
	// the original were never checked, and could not be marked.
	delete v.variants;
	delete v.steps;
	return checkFields(v);
}

/**
 * Checks the fields a question's type needs, fixing what can be fixed: an
 * mcq answer index that its explanation contradicts, a select-all set with
 * indices out of range, a written answer with no rubric.
 */
export function checkFields(q: Question): string | null {
	if (q.type === "mcq") {
		if (!Array.isArray(q.choices) || q.choices.length < 2) return "has no options";
		if (typeof q.answer !== "number" || q.answer < 0 || q.answer >= q.choices.length) return "has no valid answer index";
		const fixed = reconcileAnswer(q);
		if (fixed !== null) q.answer = fixed;
	}
	if (q.type === "multi") {
		if (!Array.isArray(q.choices) || !Array.isArray(q.answer)) return "has no answer set";
		q.answer = (q.answer as number[]).filter((n) => n >= 0 && n < q.choices!.length);
		if (!q.answer.length) return "has no answer set";
	}
	if (q.type === "short" || q.type === "command" || q.type === "image") {
		if (!q.expected) return "has no model answer";
		if (!q.rubric?.length) q.rubric = [q.expected];
	}
	return checkInteractive(q);
}

/** Types a guided step may use: ones marked on the device, so each step is checked at once. */
const STEP_TYPES: readonly QuestionType[] = ["mcq", "multi", "cloze", "order", "match", "hotspot", "trace"];

/**
 * Checks one guided step. Steps are marked on the device, so only offline
 * types are allowed; they inherit the problem's topic, axis and ref.
 */
export function checkStep(problem: Question, s: Question): string | null {
	if (problem.tier !== "brutal") return "belongs to a question that is not a brutal problem";
	if (!s || typeof s !== "object") return "is not a question";
	if (!STEP_TYPES.includes(s.type)) return `is a ${s.type} question, which cannot be checked at once`;
	if (!s.prompt?.trim()) return "has no prompt";
	s.tier = "easy";
	s.topic = problem.topic;
	if (problem.axis) s.axis = problem.axis;
	if (problem.ref) s.ref = problem.ref;
	if (!s.explain) s.explain = "";
	delete s.variants;
	delete s.steps;
	return checkFields(s);
}

/** The prompt that breaks brutal problems into guided steps. Pure, so it can be tested. */
export function stepsPrompt(title: string, content: string, problems: Question[]): string {
	return [
		"Break each problem below into 3 to 5 smaller STEPS that walk a learner up to solving it. Reply with ONLY",
		"a JSON object, no prose and no fence.",
		"",
		"Each step is one small question whose answer is a piece the full problem needs, in the order you would",
		"work it out. Together they must not simply hand over the final answer: the learner still has to put",
		"the pieces together afterwards, unaided.",
		"",
		"RULES",
		`- Every step must be one of these types, which are marked instantly: ${STEP_TYPES.join(", ")}.`,
		"  Give each every field its type needs (choices and a 0-based answer for mcq, {{blanks}} for cloze, ...).",
		"- Every fact must come from the note.",
		"",
		'SHAPE: {"steps":{"<problem id>":[{"type":"mcq","prompt":"...","choices":["..."],"answer":0,"explain":"..."}]}}',
		"",
		"PROBLEMS:",
		JSON.stringify(problems.map(({ variants: _v, steps: _s, ...q }) => q), null, 1),
		"",
		`NOTE TITLE: ${title}`,
		"NOTE CONTENT:",
		"---",
		content,
		"---",
	].join("\n");
}

/** The exact prompt the plugin sends for a bank. Pure, so it can be tested. */
export function bankPrompt(
	title: string,
	content: string,
	notePath: string,
	course: Course,
	practical: boolean
): string {
	return [
		"Write a question bank for the note below. Reply with ONLY a JSON object, no prose and no code fence.",
		"",
		"RULES",
		"- Cover the WHOLE note: every section, table and callout.",
		"- Three levels in one bank: easy (recall), hard (application), brutal (synthesis and hands-on).",
		`  Aim for about ${practical ? "18 easy, 18 hard, 10 brutal" : "22 easy, 16 hard, 10 brutal"} for a dense note; fewer for a short one.`,
		practical
			? "- The learner has just finished reading this note and wants to APPLY it. Weight heavily toward doing: predict the output, decode this, write the command, spot the bug, what happens if."
			: "- Balance recall and application.",
		"- One fact per question. Never bundle two facts into one question.",
		`- Set "axis" on every question to one of: ${course.axes.map((a) => a.id).join(", ")}.`,
		"- Vary which position the correct answer sits in.",
		"- CHECK EACH ANSWER INDEX. \"answer\" is a 0-based index into \"choices\", and it must point at the",
		"  option your own \"explain\" text justifies. Re-read every one before you reply.",
		"- Every short/command question needs \"expected\" and \"rubric\". \"accept\" is optional and must only",
		"  match genuinely correct answers; a non-match just sends it for marking, so be conservative.",
		"- \"ref\" must be a heading that really exists in the note, written as \"<note title>#<heading text>\".",
		"- Where the note's content suits them, also use these hands-on types. They are marked instantly, so",
		"  every answer must be exact:",
		"  - \"hotspot\": code in \"code\" (no line numbers in it) and a question about one line: which is wrong,",
		"    vulnerable, or does something. \"lines\" lists the 1-based answer line(s).",
		"  - \"trace\": for assembly or step-by-step code. \"code\" holds the instructions; \"trace\" is 2-5 steps,",
		"    each the 1-based \"line\" just executed and the values that then hold. Registers in hex, flags 0 or 1.",
		"  - \"order\": \"items\" lists 3-7 steps of a procedure in the correct order; they are shown shuffled.",
		"  - \"match\": \"pairs\" lists 3-6 [left, right] pairs, every right side different.",
		"  Use them only where they genuinely fit, at most about a quarter of the bank. A note with no code",
		"  gets no hotspot or trace questions.",
		"",
		"SHAPE",
		'{"id":"<bank id>","title":"<short title>","note":"<note path>","questions":[',
		' {"id":"q1","tier":"easy","type":"mcq","topic":"<slug>","axis":"<axis id>","prompt":"<markdown>",',
		'  "code":"<optional>","choices":["a","b","c","d"],"answer":0,"explain":"<why>","ref":"<note#heading>"},',
		' {"id":"q2","tier":"hard","type":"multi","topic":"...","axis":"...","prompt":"...","choices":[...],"answer":[0,2],"explain":"..."},',
		' {"id":"q3","tier":"brutal","type":"short","topic":"...","axis":"...","prompt":"...","expected":"...","rubric":["..."],"explain":"..."},',
		' {"id":"q4","tier":"hard","type":"command","topic":"...","axis":"...","prompt":"...","expected":"...","rubric":["..."],"accept":["^regex$"],"explain":"..."},',
		' {"id":"q5","tier":"hard","type":"hotspot","topic":"...","axis":"...","prompt":"Which line copies without a bounds check?","code":"...","lines":[3],"explain":"..."},',
		' {"id":"q6","tier":"brutal","type":"trace","topic":"...","axis":"...","prompt":"Step through and give each value.","code":"mov eax, 0x10\\nadd eax, 1","trace":[{"line":1,"expect":{"eax":"0x10"}},{"line":2,"expect":{"eax":"0x11","ZF":"0"}}],"explain":"..."},',
		' {"id":"q7","tier":"easy","type":"order","topic":"...","axis":"...","prompt":"Put these steps in order.","items":["first","second","third"],"explain":"..."},',
		' {"id":"q8","tier":"easy","type":"match","topic":"...","axis":"...","prompt":"Match each register to its number.","pairs":[["RAX","0"],["RCX","1"],["RDX","2"]],"explain":"..."}',
		"]}",
		"",
		`Use exactly: "id": ${JSON.stringify(bankId(course, title))}, "note": ${JSON.stringify(notePath)}, "title": ${JSON.stringify(`${course.title} · ${title}`)}`,
		"",
		`NOTE TITLE: ${title}`,
		"NOTE CONTENT:",
		"---",
		content,
		"---",
	].join("\n");
}

function bankId(course: Course, title: string): string {
	return `${course.id}-${slug(title)}`;
}

function slug(s: string): string {
	return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function oneLine(s: string): string {
	return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

function clamp(n: number): number {
	const v = Number(n);
	if (!Number.isFinite(v)) return 0;
	return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * Catches the model picking the wrong index while writing a correct
 * explanation — seen in the wild: answer pointed at "Android Studio" while the
 * explanation said "the Android OS". If exactly one option is clearly named by
 * the explanation and it is not the chosen one, trust the explanation.
 */
export function reconcileAnswer(q: Question): number | null {
	const explain = normaliseChoice(q.explain ?? "");
	if (!explain || !q.choices) return null;

	// An explanation that rules an option OUT ("not D", "rather than D") names a
	// distractor, so matching on it would move a correct answer to a wrong one.
	// Those are left alone rather than guessed at.
	if (/\b(not|rather than|instead of|unlike|never|isn't|doesn't|does not)\b/.test(explain)) return null;

	const named = q.choices
		.map((c, i) => ({ i, text: normaliseChoice(c) }))
		.filter((c) => c.text.length >= 8 && explain.includes(c.text));
	if (named.length !== 1) return null;
	return named[0].i === q.answer ? null : named[0].i;
}

function normaliseChoice(c: string): string {
	return String(c).toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

/** A whole number written as a string, read as a number; anything else as it was. */
function asNumber(v: unknown): number {
	return typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : (v as number);
}

const TYPES: readonly QuestionType[] = [
	"mcq", "multi", "short", "command", "image", "hotspot", "trace", "order", "match", "cloze",
];

/**
 * Checks one of the hands-on types and tidies what it can: values come back
 * as strings, whatever JSON type the generator used. Returns what is wrong,
 * or null if it is usable.
 */
export function checkInteractive(q: Question): string | null {
	const codeLines = (q.code ?? "").split("\n").length;
	switch (q.type) {
		case "hotspot":
			if (!q.code?.trim()) return "has no code to click";
			if (!Array.isArray(q.lines) || !q.lines.length) return "has no answer lines";
			q.lines = [...new Set(q.lines.map(asNumber))];
			if (q.lines.some((l) => !Number.isInteger(l) || l < 1 || l > codeLines)) return "points at a line outside its code";
			return null;
		case "trace":
			if (!q.code?.trim()) return "has no code to step through";
			if (!Array.isArray(q.trace) || !q.trace.length) return "has no steps";
			for (const step of q.trace) {
				if (step) step.line = asNumber(step.line);
				if (!Number.isInteger(step?.line) || step.line < 1 || step.line > codeLines) return "has a step outside its code";
				if (!step.expect || typeof step.expect !== "object" || !Object.keys(step.expect).length) {
					return "has a step with nothing to fill in";
				}
				// JSON numbers past 2^53 were already rounded when the file was
				// parsed, and a 64-bit register needs every bit.
				const values = Object.values(step.expect as Record<string, unknown>);
				if (values.some((v) => typeof v === "number" && !Number.isSafeInteger(v) && Number.isInteger(v))) {
					return "has a value too large to read exactly (write it as a string)";
				}
				step.expect = Object.fromEntries(Object.entries(step.expect).map(([k, v]) => [k, String(v)]));
			}
			return null;
		case "order":
			if (!Array.isArray(q.items) || q.items.length < 3) return "needs at least three items";
			q.items = q.items.map(String);
			if (new Set(q.items.map((s) => s.trim().toLowerCase())).size !== q.items.length) return "repeats an item";
			return null;
		case "match":
			if (!Array.isArray(q.pairs) || q.pairs.length < 3) return "needs at least three pairs";
			if (q.pairs.some((p) => !Array.isArray(p) || p.length !== 2)) return "has a malformed pair";
			q.pairs = q.pairs.map(([l, r]) => [String(l), String(r)]);
			// Compared as the dropdown shows them: `*rsp` and `rsp` must not
			// both read rsp.
			if (new Set(q.pairs.map(([, r]) => plain(r).trim().toLowerCase())).size !== q.pairs.length) {
				return "has two pairs with the same answer";
			}
			return null;
		case "cloze":
			return q.cloze && /\{\{[^}]+\}\}/.test(q.cloze) ? null : "has no blanks";
		default:
			return null;
	}
}

/**
 * Rejects a bank that would break the view, before it reaches the vault. A
 * broken hands-on question is dropped rather than failing the whole bank,
 * which would cost a full rebuild.
 */
export function validateBank(bank: Bank, course: Course): string | null {
	if (!bank || !Array.isArray(bank.questions) || !bank.questions.length) return "Claude returned no questions.";
	const axes = new Set(course.axes.map((a) => a.id));
	const seen = new Set<string>();
	const broken = new Set<Question>();
	for (const [i, q] of bank.questions.entries()) {
		if (!q.id || seen.has(q.id)) q.id = `q${i + 1}`;
		seen.add(q.id);
		if (!["easy", "hard", "brutal"].includes(q.tier)) q.tier = "easy";
		if (!TYPES.includes(q.type)) q.type = "short";
		if (!q.topic) q.topic = "general";
		if (!q.axis || !axes.has(q.axis)) q.axis = course.axes[0].id;
		if (!q.explain) q.explain = "";
		const problem = checkInteractive(q);
		if (problem) {
			console.warn(`Recall Lab: dropped ${q.id}: its ${q.type} question ${problem}.`);
			broken.add(q);
			continue;
		}
		if (q.type === "mcq") {
			if (!Array.isArray(q.choices) || q.choices.length < 2) return `Question ${q.id} is multiple choice with no options.`;
			if (typeof q.answer !== "number" || q.answer < 0 || q.answer >= q.choices.length) {
				return `Question ${q.id} has no valid answer index.`;
			}
			const fixed = reconcileAnswer(q);
			if (fixed !== null) {
				console.warn(`Recall Lab: ${q.id} pointed at "${q.choices[q.answer]}" but its explanation describes "${q.choices[fixed]}" — corrected.`);
				q.answer = fixed;
			}
		}
		if (q.type === "multi") {
			if (!Array.isArray(q.choices) || !Array.isArray(q.answer) || !q.answer.length) {
				return `Question ${q.id} is select-all with no answer set.`;
			}
			q.answer = (q.answer as number[]).filter((n) => n >= 0 && n < q.choices!.length);
			if (!q.answer.length) return `Question ${q.id} has an out-of-range answer set.`;
		}
		if ((q.type === "short" || q.type === "command" || q.type === "image") && !(q.rubric?.length)) {
			q.rubric = [q.expected ?? "A correct, complete answer."];
		}
	}
	if (broken.size) bank.questions = bank.questions.filter((q) => !broken.has(q));
	if (!bank.questions.length) return "None of the questions Claude wrote were usable.";

	// Each question's id comes from its content, so rebuilding a quiz gives a
	// changed question a new id, and a fresh history, while an unchanged one
	// keeps its own. Numbering them q1, q2… handed a rebuilt quiz's new q3 the
	// old q3's answers and schedule.
	const taken = new Set<string>();
	for (const q of bank.questions) {
		const base = contentId(q);
		let id = base;
		for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
		taken.add(id);
		q.id = id;
	}
	return null;
}

/** Fields that do not change which question it is: its id, explanation and bookkeeping. */
const NOT_IDENTITY = new Set([
	"id", "explain", "ref", "topic", "axis", "tier", "timestamp", "slide", "rubric", "expected", "accept", "variants", "steps",
]);

/**
 * A question's id derived from what it asks: its type, prompt, code and
 * answer data, with keys sorted so the generator's field order does not
 * matter. Editing an explanation keeps the id; changing the question makes
 * a new one.
 */
export function contentId(q: Question): string {
	const fields = q as unknown as Record<string, unknown>;
	const core = Object.keys(fields)
		.filter((k) => !NOT_IDENTITY.has(k))
		.sort()
		.map((k) => [k, fields[k]]);
	return `q-${hashText(JSON.stringify(core))}`;
}
