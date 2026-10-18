import { App, normalizePath, TFile } from "obsidian";
import {
	Attempt,
	Bank,
	Course,
	LabProgress,
	EMPTY_PROGRESS,
	ProgressFile,
	Question,
	SessionSummary,
	Tier,
	TIERS,
	letterGrade,
} from "./types";
import { shuffled } from "./util";

/** Reads banks, persists attempts, and regenerates the human-readable gradebook. */
export class Store {
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

	async listBanks(): Promise<Bank[]> {
		const folder = normalizePath(this.banksFolder());
		const banks: Bank[] = [];
		for (const file of this.vault.getFiles()) {
			if (!file.path.startsWith(folder + "/") || file.extension !== "json") continue;
			try {
				const bank = JSON.parse(await this.vault.cachedRead(file)) as Bank;
				if (bank && Array.isArray(bank.questions) && bank.id) banks.push(bank);
			} catch (e) {
				console.error(`Recall Lab: could not parse bank ${file.path}`, e);
			}
		}
		return banks.sort((a, b) => a.title.localeCompare(b.title));
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

	async bankForNote(path: string): Promise<Bank | null> {
		const banks = await this.listBanks();
		return banks.find((b) => b.note === path) ?? null;
	}

	// ---------- progress ----------

	async readProgress(): Promise<ProgressFile> {
		const file = this.vault.getAbstractFileByPath(this.progressPath());
		if (!(file instanceof TFile)) return { ...EMPTY_PROGRESS, attempts: [], sessions: [] };
		try {
			const parsed = JSON.parse(await this.vault.read(file)) as ProgressFile;
			return {
				version: 1,
				attempts: parsed.attempts ?? [],
				sessions: parsed.sessions ?? [],
			};
		} catch (e) {
			console.error("Recall Lab: attempts.json is corrupt, starting a fresh log", e);
			return { ...EMPTY_PROGRESS, attempts: [], sessions: [] };
		}
	}

	async writeProgress(data: ProgressFile): Promise<void> {
		await this.ensureFolder(this.progressFolder());
		const path = this.progressPath();
		const body = JSON.stringify(data, null, 2);
		const file = this.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.vault.modify(file, body);
		else await this.vault.create(path, body);
	}

	async recordSession(attempts: Attempt[], summary: SessionSummary): Promise<ProgressFile> {
		const data = await this.readProgress();
		data.attempts.push(...attempts);
		data.sessions.push(summary);
		await this.writeProgress(data);
		return data;
	}

	// ---------- derived stats ----------

	/**
	 * Mastery of one question: the mean of its three most recent scores, so a
	 * lucky guess does not erase a history of getting it wrong.
	 */
	static questionMastery(attempts: Attempt[], questionId: string): number | null {
		const mine = attempts.filter((a) => a.questionId === questionId).slice(-3);
		if (!mine.length) return null;
		return mine.reduce((s, a) => s + a.score, 0) / mine.length;
	}

	/**
	 * Mastery of a tier. Questions never attempted count as zero, so the number
	 * answers "how much of this tier do I actually own", not "how did I do on
	 * the handful I tried".
	 */
	static tierMastery(bank: Bank, attempts: Attempt[], tier: Tier): number {
		const qs = bank.questions.filter((q) => q.tier === tier);
		if (!qs.length) return 100;
		const total = qs.reduce((sum, q) => sum + (Store.questionMastery(attempts, q.id) ?? 0), 0);
		return Math.round(total / qs.length);
	}

	static tierCoverage(bank: Bank, attempts: Attempt[], tier: Tier): { seen: number; total: number } {
		const qs = bank.questions.filter((q) => q.tier === tier);
		const seen = qs.filter((q) => Store.questionMastery(attempts, q.id) !== null).length;
		return { seen, total: qs.length };
	}

	/** Topics ordered worst first, across a bank. */
	static weakTopics(bank: Bank, attempts: Attempt[], limit = 5): { topic: string; score: number }[] {
		const byTopic = new Map<string, number[]>();
		const ids = new Set(bank.questions.map((q) => q.id));
		for (const a of attempts) {
			if (!ids.has(a.questionId)) continue;
			const list = byTopic.get(a.topic) ?? [];
			list.push(a.score);
			byTopic.set(a.topic, list);
		}
		return [...byTopic.entries()]
			.map(([topic, scores]) => ({
				topic,
				score: Math.round(scores.reduce((s, n) => s + n, 0) / scores.length),
			}))
			.sort((a, b) => a.score - b.score)
			.slice(0, limit);
	}

	/**
	 * What to ask next: unseen questions first, then the weakest, then the
	 * longest untouched. Within those groups the order is shuffled so repeat
	 * sessions do not become a memorised sequence.
	 */
	static pickQuestions(bank: Bank, attempts: Attempt[], tier: Tier, count: number, weakOnly = false): Question[] {
		const lastSeen = new Map<string, number>();
		for (const a of attempts) lastSeen.set(a.questionId, Date.parse(a.ts));

		let scored = bank.questions
			.filter((q) => q.tier === tier)
			.map((q) => ({
				q,
				mastery: Store.questionMastery(attempts, q.id),
				seen: lastSeen.get(q.id) ?? 0,
			}))
			.filter((e) => (weakOnly ? (e.mastery ?? 0) < 80 : true));

		scored = shuffled(scored);
		scored.sort((a, b) => {
			const am = a.mastery ?? -1;
			const bm = b.mastery ?? -1;
			if (am !== bm) return am - bm;
			return a.seen - b.seen;
		});
		return scored.slice(0, count).map((e) => e.q);
	}

	// ---------- note completion ----------

	// ---------- labs ----------

	async labProgress(labId: string): Promise<LabProgress> {
		const data = await this.readProgress();
		return data.labs?.[labId] ?? { labId, attempts: 0, hintsUsed: 0 };
	}

	async saveLabProgress(p: LabProgress): Promise<void> {
		const data = await this.readProgress();
		data.labs = data.labs ?? {};
		data.labs[p.labId] = p;
		await this.writeProgress(data);
	}

	async markComplete(path: string): Promise<void> {
		const data = await this.readProgress();
		data.completed = data.completed ?? {};
		data.completed[path] = new Date().toISOString();
		await this.writeProgress(data);
	}

	async isComplete(path: string): Promise<boolean> {
		const data = await this.readProgress();
		return Boolean(data.completed?.[path]);
	}

	// ---------- exam composition ----------

	/**
	 * One exam that ramps through all three levels instead of making you pick a
	 * tier: easy first to warm up, then hard, then brutal. Within each level the
	 * weakest and least-recently-seen questions come first, so a repeat exam is
	 * not the same paper.
	 */
	static pickExam(bank: Bank, attempts: Attempt[], total: number): Question[] {
		const split: Record<Tier, number> = {
			easy: Math.round(total * 0.45),
			hard: Math.round(total * 0.35),
			brutal: 0,
		};
		split.brutal = Math.max(0, total - split.easy - split.hard);

		const out: Question[] = [];
		for (const tier of TIERS) {
			const want = split[tier];
			if (want <= 0) continue;
			const got = Store.pickQuestions(bank, attempts, tier, want, false);
			out.push(...got);
			// A thin tier donates its shortfall to the next one.
			const short = want - got.length;
			if (short > 0 && tier !== "brutal") split[tier === "easy" ? "hard" : "brutal"] += short;
		}
		return out;
	}

	/** Every question in the bank, easy first — the "full exam". */
	static fullExam(bank: Bank): Question[] {
		const rank: Record<string, number> = { easy: 0, hard: 1, brutal: 2 };
		return bank.questions.slice().sort((a, b) => rank[a.tier] - rank[b.tier]);
	}
}

