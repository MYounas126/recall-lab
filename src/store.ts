import { App, Notice, normalizePath, TFile } from "obsidian";
import {
	Attempt,
	Bank,
	Course,
	ExamItem,
	LabProgress,
	DayLog,
	EMPTY_PROGRESS,
	ProgressFile,
	SessionSummary,
	Tier,
	TIERS,
} from "./types";
import { AnswerIndex } from "./history";
import { highlightBank, highlightBankId } from "./highlights";
import { SerialQueue, shuffled } from "./util";

/** Reads banks and courses, and persists attempts, sessions and lab progress. */
export class Store {
	/** Every change to attempts.json goes through this, one at a time. */
	private writes = new SerialQueue();

	constructor(
		private app: App,
		private banksFolder: () => string,
		private progressFolder: () => string,
		private coursesFolder: () => string = () => "_quiz/courses"
	) {}

	private get vault() {
		return this.app.vault;
	}

	private progressPath(): string {
		return normalizePath(`${this.progressFolder()}/attempts.json`);
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = normalizePath(path).split("/").filter(Boolean);
		let acc = "";
		for (const part of parts) {
			acc = acc ? `${acc}/${part}` : part;
			if (!this.vault.getAbstractFileByPath(acc)) {
				try {
					await this.vault.createFolder(acc);
				} catch {
					// Another call created it between the check and the create.
				}
			}
		}
	}

	// ---------- banks ----------

	/** Where each bank was read from, by id: a hand-made bank need not be named after its id. */
	private bankPaths = new Map<string, string>();

	async listBanks(): Promise<Bank[]> {
		const folder = normalizePath(this.banksFolder());
		const banks: Bank[] = [];
		for (const file of this.vault.getFiles()) {
			if (!file.path.startsWith(folder + "/") || file.extension !== "json") continue;
			try {
				const bank = JSON.parse(await this.vault.cachedRead(file)) as Bank;
				if (bank && Array.isArray(bank.questions) && bank.id) {
					banks.push(bank);
					this.bankPaths.set(bank.id, file.path);
				}
			} catch (e) {
				console.error(`Recall Lab: could not parse bank ${file.path}`, e);
			}
		}
		return banks.sort((a, b) => a.title.localeCompare(b.title));
	}

	/** The file a bank lives in, as last listed; by default, the one named after its id. */
	bankPath(bankId: string): string {
		return this.bankPaths.get(bankId) ?? normalizePath(`${this.banksFolder()}/${bankId}.json`);
	}

	async listCourses(): Promise<Course[]> {
		const folder = normalizePath(this.coursesFolder());
		const courses: Course[] = [];
		for (const file of this.vault.getFiles()) {
			if (!file.path.startsWith(folder + "/") || file.extension !== "json") continue;
			try {
				const course = JSON.parse(await this.vault.cachedRead(file)) as Course;
				if (course?.id && Array.isArray(course.axes)) courses.push(course);
			} catch (e) {
				console.error(`Recall Lab: could not parse course ${file.path}`, e);
			}
		}
		return courses.sort((a, b) => a.title.localeCompare(b.title));
	}

	/** The banks whose note lives under this course's folder. */
	static banksForCourse(course: Course, banks: Bank[]): Bank[] {
		const prefix = course.folder.replace(/\/+$/, "") + "/";
		return banks.filter((b) => b.note?.startsWith(prefix));
	}

	/** Top-level vault folders that hold at least one note — the candidate courses. */
	folderTree(): { path: string; notes: number }[] {
		const counts = new Map<string, number>();
		for (const f of this.vault.getMarkdownFiles()) {
			const top = f.path.includes("/") ? f.path.split("/")[0] : null;
			if (!top || top.startsWith("_")) continue;
			counts.set(top, (counts.get(top) ?? 0) + 1);
		}
		return [...counts.entries()]
			.map(([path, notes]) => ({ path, notes }))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	/** Every note directly inside a folder, at any depth below it. */
	notesIn(folder: string): string[] {
		const prefix = folder.replace(/\/+$/, "") + "/";
		return this.vault
			.getMarkdownFiles()
			.map((f) => f.path)
			.filter((p) => p.startsWith(prefix))
			.sort();
	}

	/** Notes under a course folder that no bank points at yet. */
	notesWithoutBank(course: Course, banks: Bank[]): string[] {
		const prefix = course.folder.replace(/\/+$/, "") + "/";
		const covered = new Set(banks.map((b) => b.note).filter(Boolean) as string[]);
		return this.vault
			.getMarkdownFiles()
			.map((f) => f.path)
			.filter((path) => path.startsWith(prefix) && !covered.has(path))
			.sort();
	}

	/**
	 * Fill-in-the-blank questions made from the ==highlights== in every note of
	 * these courses, one pseudo-bank per note. Kept apart from listBanks so a
	 * note with only highlights still counts as having no quiz yet.
	 */
	async listHighlightBanks(courses: Course[]): Promise<Bank[]> {
		const out: Bank[] = [];
		const done = new Set<string>();
		for (const course of courses) {
			for (const path of this.notesIn(course.folder)) {
				if (done.has(path)) continue;
				done.add(path);
				const file = this.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) continue;
				const bank = highlightBank(path, await this.vault.cachedRead(file));
				if (bank) out.push(bank);
			}
		}
		return out;
	}

	async bankForNote(path: string): Promise<Bank | null> {
		const banks = await this.listBanks();
		return banks.find((b) => b.note === path) ?? null;
	}

	// ---------- progress ----------

	async readProgress(): Promise<ProgressFile> {
		try {
			return await this.readStrict();
		} catch (e) {
			console.error("Recall Lab: attempts.json could not be read; showing an empty log", e);
			return freshProgress();
		}
	}

	/**
	 * Reads attempts.json, failing loudly when the file exists but cannot be
	 * parsed. Writes go through this: treating an unreadable file as empty and
	 * writing that back would wipe the whole history.
	 */
	private async readStrict(): Promise<ProgressFile> {
		const file = this.vault.getAbstractFileByPath(this.progressPath());
		if (!(file instanceof TFile)) return freshProgress();
		let parsed: Partial<ProgressFile>;
		try {
			parsed = JSON.parse(await this.vault.read(file)) as Partial<ProgressFile>;
		} catch (e) {
			throw new Error(`${this.progressPath()} could not be read, so Recall Lab left it untouched instead of overwriting it (${String(e)})`);
		}
		// Every field is carried through, not just the ones read here: a field
		// dropped on read is erased by the next write. Completed notes and lab
		// progress were lost exactly that way.
		return {
			...parsed,
			version: 1,
			attempts: parsed.attempts ?? [],
			sessions: parsed.sessions ?? [],
			completed: parsed.completed ?? {},
			labs: parsed.labs ?? {},
		};
	}

	private async writeProgress(data: ProgressFile): Promise<void> {
		await this.ensureFolder(this.progressFolder());
		const path = this.progressPath();
		const body = JSON.stringify(data, null, 2);
		const file = this.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.vault.modify(file, body);
		else await this.vault.create(path, body);
	}

	/**
	 * Reads attempts.json, applies one change and writes it back. Each change
	 * awaits between its read and its write, so two run side by side would read
	 * the same snapshot and the later write would silently drop the earlier
	 * change — coaching landing while a lab is solved, say. The queue runs them
	 * one at a time. A change that returns false skips the write.
	 */
	private update(change: (data: ProgressFile) => boolean | void): Promise<ProgressFile> {
		return this.writes.run(async () => {
			let data: ProgressFile;
			try {
				data = await this.readStrict();
			} catch (e) {
				new Notice(`Recall Lab: ${(e as Error).message}. Your last change was not saved.`, 15000);
				throw e;
			}
			if (change(data) !== false) await this.writeProgress(data);
			return data;
		});
	}

	/**
	 * Saves one answer the moment it is marked, so leaving a session early —
	 * or Obsidian closing mid-session — loses nothing already answered.
	 */
	async recordAttempt(attempt: Attempt): Promise<void> {
		await this.update((data) => {
			data.attempts.push(attempt);
		});
	}

	/** Saves a finished session's summary; its answers were saved as they came. */
	async recordSession(summary: SessionSummary): Promise<ProgressFile> {
		return this.update((data) => {
			data.sessions.push(summary);
		});
	}

	/** Stores a session's coaching once it lands. False if the session is gone. */
	async saveCoaching(sessionId: string, coaching: string): Promise<boolean> {
		let found = false;
		await this.update((data) => {
			const session = data.sessions.find((s) => s.id === sessionId);
			if (!session) return false;
			session.coachingPending = false;
			session.coaching = coaching;
			found = true;
		});
		return found;
	}

	/**
	 * Moves highlight answers from a note's old path to its new one — or, for
	 * a folder, from every note under it. Returns how many answers moved.
	 */
	async moveHighlightHistory(from: string, to: string, folder: boolean): Promise<number> {
		const oldId = highlightBankId(from);
		const newId = highlightBankId(to);
		let moved = 0;
		await this.update((data) => {
			for (const a of data.attempts) {
				if (a.bankId === oldId && !folder) a.bankId = newId;
				else if (folder && a.bankId.startsWith(`${oldId}/`)) a.bankId = newId + a.bankId.slice(oldId.length);
				else continue;
				moved += 1;
			}
			return moved > 0;
		});
		return moved;
	}

	/** Keeps finished days' records. A day already kept is never changed. */
	async keepDays(days: Record<string, DayLog>): Promise<void> {
		await this.update((data) => {
			data.days = data.days ?? {};
			let added = false;
			for (const [key, day] of Object.entries(days)) {
				if (data.days[key]) continue;
				data.days[key] = day;
				added = true;
			}
			return added;
		});
	}

	// ---------- exam composition ----------

	/** Every question in these banks, each paired with its own bank. */
	static itemsOf(banks: Bank[]): ExamItem[] {
		return banks.flatMap((b) => b.questions.map((q) => ({ bankId: b.id, q })));
	}

	/**
	 * What to ask next: unseen questions first, then the weakest, then the
	 * longest untouched. Within those groups the order is shuffled so repeat
	 * sessions do not become a memorised sequence.
	 */
	static pickQuestions(items: ExamItem[], index: AnswerIndex, tier: Tier, count: number, weakOnly = false): ExamItem[] {
		let scored = items
			.filter((it) => it.q.tier === tier)
			.map((it) => ({
				it,
				mastery: index.mastery(it.bankId, it.q.id),
				seen: index.lastSeen(it.bankId, it.q.id),
			}))
			.filter((e) => (weakOnly ? (e.mastery ?? 0) < 80 : true));

		scored = shuffled(scored);
		scored.sort((a, b) => {
			const am = a.mastery ?? -1;
			const bm = b.mastery ?? -1;
			if (am !== bm) return am - bm;
			return a.seen - b.seen;
		});
		return scored.slice(0, count).map((e) => e.it);
	}

	// ---------- note completion ----------

	// ---------- labs ----------

	async labProgress(labId: string): Promise<LabProgress> {
		const data = await this.readProgress();
		return data.labs?.[labId] ?? { labId, attempts: 0, hintsUsed: 0 };
	}

	async saveLabProgress(p: LabProgress): Promise<void> {
		await this.update((data) => {
			data.labs = data.labs ?? {};
			data.labs[p.labId] = p;
		});
	}

	async markComplete(path: string): Promise<void> {
		await this.update((data) => {
			data.completed = data.completed ?? {};
			data.completed[path] = new Date().toISOString();
		});
	}

	async isComplete(path: string): Promise<boolean> {
		const data = await this.readProgress();
		return Boolean(data.completed?.[path]);
	}

	/**
	 * One exam that ramps through all three levels instead of making you pick a
	 * tier: easy first to warm up, then hard, then brutal. Within each level the
	 * weakest and least-recently-seen questions come first, so a repeat exam is
	 * not the same paper. The items may span several banks, as a course exam's do.
	 */
	static pickExam(items: ExamItem[], index: AnswerIndex, total: number): ExamItem[] {
		const split: Record<Tier, number> = {
			easy: Math.round(total * 0.45),
			hard: Math.round(total * 0.35),
			brutal: 0,
		};
		split.brutal = Math.max(0, total - split.easy - split.hard);

		const out: ExamItem[] = [];
		for (const tier of TIERS) {
			const want = split[tier];
			if (want <= 0) continue;
			const got = Store.pickQuestions(items, index, tier, want, false);
			out.push(...got);
			// A thin tier donates its shortfall to the next one.
			const short = want - got.length;
			if (short > 0 && tier !== "brutal") split[tier === "easy" ? "hard" : "brutal"] += short;
		}
		// Donations only flow to harder tiers, so a bank thin in hard or brutal
		// questions would still come up short; top up from what is left.
		for (const tier of TIERS) {
			if (out.length >= total) break;
			const taken = new Set(out);
			const rest = items.filter((it) => !taken.has(it));
			out.push(...Store.pickQuestions(rest, index, tier, total - out.length, false));
		}
		return out;
	}

	/** Every question, easy first — the "full exam". */
	static fullExam(items: ExamItem[]): ExamItem[] {
		const rank: Record<string, number> = { easy: 0, hard: 1, brutal: 2 };
		return items.slice().sort((a, b) => rank[a.q.tier] - rank[b.q.tier]);
	}
}

/**
 * An empty progress file with its own objects. Spreading EMPTY_PROGRESS would
 * share its `completed` and `labs` maps, so the first write into one would
 * leak into every later "empty" read.
 */
function freshProgress(): ProgressFile {
	return { ...EMPTY_PROGRESS, attempts: [], sessions: [], completed: {}, labs: {} };
}

