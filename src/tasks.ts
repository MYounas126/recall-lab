import { App, Notice, TFile, normalizePath } from "obsidian";
import { ClaudeCli } from "./claude";
import { Store } from "./store";
import { Bank, Course, Lab, Question, Verdict } from "./types";
import { hashFlag, validateLab, detectToolchain, describeToolchain } from "./labs";
import type { Strictness } from "./settings";
import { hashText } from "./util";

export interface MarkResult {
	score: number;
	verdict: Verdict;
	feedback: string;
	missing: string[];
	improve?: string;
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
		const prompt = [
			"You are marking one exam answer. Reply with ONLY a JSON object, no prose and no code fence.",
			"",
			STRICTNESS[this.strictness()],
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
			'Reply exactly: {"score":<0-100>,"verdict":"correct"|"partial"|"incorrect","feedback":"<1-2 sentences addressed to the learner, naming exactly what was wrong>","missing":["<rubric points not made, verbatim>"],"improve":"<one concrete sentence on what to study>"}',
			'verdict is "correct" at 90+, "partial" 40-89, "incorrect" below 40.',
		].filter(Boolean).join("\n");

		const res = await this.cli.askJson<MarkResult>(prompt, 120000);
		if (!res.ok) return { error: res.error };
		const d = res.data;
		return {
			score: clamp(d.score),
			verdict: d.verdict === "correct" || d.verdict === "partial" ? d.verdict : "incorrect",
			feedback: String(d.feedback ?? ""),
			missing: Array.isArray(d.missing) ? d.missing.map(String) : [],
			improve: d.improve ? String(d.improve) : undefined,
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
		"",
		"SHAPE",
		'{"id":"<bank id>","title":"<short title>","note":"<note path>","questions":[',
		' {"id":"q1","tier":"easy","type":"mcq","topic":"<slug>","axis":"<axis id>","prompt":"<markdown>",',
		'  "code":"<optional>","choices":["a","b","c","d"],"answer":0,"explain":"<why>","ref":"<note#heading>"},',
		' {"id":"q2","tier":"hard","type":"multi","topic":"...","axis":"...","prompt":"...","choices":[...],"answer":[0,2],"explain":"..."},',
		' {"id":"q3","tier":"brutal","type":"short","topic":"...","axis":"...","prompt":"...","expected":"...","rubric":["..."],"explain":"..."},',
		' {"id":"q4","tier":"hard","type":"command","topic":"...","axis":"...","prompt":"...","expected":"...","rubric":["..."],"accept":["^regex$"],"explain":"..."}',
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

/** Rejects a bank that would break the view, before it reaches the vault. */
export function validateBank(bank: Bank, course: Course): string | null {
	if (!bank || !Array.isArray(bank.questions) || !bank.questions.length) return "Claude returned no questions.";
	const axes = new Set(course.axes.map((a) => a.id));
	const seen = new Set<string>();
	for (const [i, q] of bank.questions.entries()) {
		if (!q.id || seen.has(q.id)) q.id = `q${i + 1}`;
		seen.add(q.id);
		if (!["easy", "hard", "brutal"].includes(q.tier)) q.tier = "easy";
		if (!["mcq", "multi", "short", "command", "image"].includes(q.type)) q.type = "short";
		if (!q.topic) q.topic = "general";
		if (!q.axis || !axes.has(q.axis)) q.axis = course.axes[0].id;
		if (!q.explain) q.explain = "";
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
