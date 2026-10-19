import { MarkdownView, Notice, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf, normalizePath, setIcon, setTooltip } from "obsidian";
import { DEFAULT_SETTINGS, RecallLabSettingTab, RecallLabSettings } from "./settings";
import { Store } from "./store";
import { ClaudeCli } from "./claude";
import { Tasks } from "./tasks";
import { LabStore, hintsNeedShortening } from "./labs";
import { Log } from "./log";
import { ConfirmModal, RecallLabView, VIEW_TYPE_RECALL } from "./view";
import { Bank, Course, Lab, Question } from "./types";
import { needingVariants } from "./variants";
import { needingSteps } from "./guided";
import { Leech } from "./leeches";
import { SerialQueue } from "./util";
import { AnswerIndex } from "./history";
import { Memory, dateKey, describeAgo, endOfDay, expectedScore, keyOf } from "./memory";
import { NoteMemory, describeSection, dotLevel, headingKey, noteMemory } from "./notemap";

/** Memory state for the note dots, footers and status bar, shared until something changes. */
interface MemorySnapshot {
	/** When it was built, in ms; it goes stale with time as well as with change. */
	at: number;
	banks: Bank[];
	memory: Memory;
	index: AnswerIndex;
	scoreOf: (bankId: string, questionId: string) => number | null;
	/** Questions due by the end of today, across every bank. */
	due: number;
}

/** Due counts and expected scores move with the clock, so a snapshot lasts at most this long. */
const SNAPSHOT_TTL = 10 * 60 * 1000;

export default class RecallLabPlugin extends Plugin {
	settings!: RecallLabSettings;
	store!: Store;
	cli!: ClaudeCli;
	log!: Log;
	/** Set while a bulk generation run is in flight; cleared to stop it. */
	private bulkRun: { cancelled: boolean } | null = null;
	tasks!: Tasks;
	labs!: LabStore;
	/**
	 * Quiz, lab and course builds run one at a time, in the order asked for.
	 * Each is a Claude CLI process that can take minutes, so ten clicks must
	 * not mean ten of them at once.
	 */
	private generation = new SerialQueue();
	/** What is queued or building, keyed like "quiz:<note path>". */
	private building = new Set<string>();
	private unloaded = false;
	private snapshot: { at: number; value: Promise<MemorySnapshot> } | null = null;
	private statusBar: HTMLElement | null = null;
	/** The local date the memory views were last drawn for. */
	private memoryDay = dateKey(new Date());
	private memoryTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.store = new Store(
			this.app,
			() => this.settings.banksFolder,
			() => this.settings.progressFolder,
			() => this.settings.coursesFolder
		);
		this.labs = new LabStore(this.app, () => this.settings.labsFolder, () => this.settings.labWorkspace);
		this.log = new Log(this.app, () => this.settings.progressFolder);
		this.cli = new ClaudeCli(() => this.settings.claudePath, () => this.settings.model);
		this.cli.onLog = (level, msg, extra) =>
			level === "error" ? this.log.error(msg, extra) : this.log.info(msg, extra);
		this.log.info("plugin loaded", { version: this.manifest.version, model: this.settings.model });
		this.tasks = new Tasks(
			this.app,
			this.cli,
			this.store,
			() => this.settings.strictness,
			() => this.settings.banksFolder,
			() => this.settings.coursesFolder,
			() => this.settings.labsFolder
		);

		this.registerView(VIEW_TYPE_RECALL, (leaf: WorkspaceLeaf) => new RecallLabView(leaf, this));
		this.addRibbonIcon("graduation-cap", "Recall Lab", () => void this.activate());
		this.addSettingTab(new RecallLabSettingTab(this.app, this));

		this.addCommand({ id: "open", name: "Open view", callback: () => void this.activate() });
		this.addCommand({
			id: "start-review",
			name: "Start today's review",
			callback: () => void this.reviewFromOutside((view) => view.startReview()),
		});

		this.addCommand({
			id: "quiz-this-note",
			name: "Quiz me on this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (checking) return true;
				void this.quizNote(file);
				return true;
			},
		});

		this.addCommand({
			id: "write-it-down",
			name: "Write down everything I remember about this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (checking) return true;
				void this.activate().then((view) => view.startBlurt(file.path));
				return true;
			},
		});

		this.addCommand({
			id: "teach-it-back",
			name: "Teach this note back",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (checking) return true;
				void this.activate().then((view) => view.startTeachBack(file.path));
				return true;
			},
		});

		this.addCommand({
			id: "complete-note",
			name: "Mark this note complete and build its quiz",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (checking) return true;
				void this.completeNote(file.path);
				return true;
			},
		});

		this.addCommand({ id: "scan-for-quizzes", name: "Generate quizzes for notes in course folders", callback: () => void this.scanForMissingBanks() });
		this.addCommand({ id: "diagnose", name: "Run diagnostics", callback: () => void this.diagnose() });
		this.addCommand({
			id: "stop-generation",
			name: "Stop quiz generation",
			callback: () => {
				if (!this.bulkRunning) { new Notice("Nothing is generating."); return; }
				this.cancelBulk();
				new Notice("Will stop after the quiz currently in flight.", 8000);
			},
		});
		this.addCommand({ id: "remove-leftovers", name: "Remove leftover quizzes, labs and courses", callback: () => void this.removeLeftovers() });
		this.addCommand({ id: "write-variants", name: "Write variants for mature questions", callback: () => void this.offerVariants() });
		this.addCommand({ id: "write-steps", name: "Write guided steps for brutal problems", callback: () => void this.offerSteps() });
		this.addCommand({ id: "shorten-lab-hints", name: "Shorten lab hints to CTF-style nudges", callback: () => void this.offerHintRewrite() });

		// The "Complete" footer at the bottom of every note inside a course folder.
		this.registerEvent(this.app.workspace.on("file-open", () => this.queueFooters()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.queueFooters()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.queueFooters()));

		// The memory map: dots on headings, the due count in the status bar.
		this.registerMarkdownPostProcessor((el, ctx) => this.decorateHeadings(el, ctx.sourcePath));
		this.statusBar = this.addStatusBarItem();
		this.statusBar.addClass("mod-clickable", "rl-status", "rl-collapsed");
		setIcon(this.statusBar.createSpan({ cls: "rl-status-icon" }), "graduation-cap");
		this.statusBar.createSpan({ cls: "rl-status-text" });
		setTooltip(this.statusBar, "Start today's review");
		this.statusBar.onclick = () => void this.reviewFromOutside((view) => view.startReview());
		// Due counts move with the clock as well as with answers: look every
		// minute, rebuild once the snapshot has expired, and redraw everything
		// when a new day starts, so nothing still says "Nothing due" next morning.
		this.registerInterval(window.setInterval(() => void this.tick(), 60_000));

		this.app.workspace.onLayoutReady(() => {
			// Any change to a bank or to attempts.json makes the shared memory
			// state stale. Watched from here: while the vault loads, Obsidian
			// reports every existing file as created.
			const watch = (path: string) => {
				if (
					path.startsWith(normalizePath(this.settings.banksFolder) + "/") ||
					path === normalizePath(`${this.settings.progressFolder}/attempts.json`)
				) {
					this.memoryChanged();
				} else if (path.endsWith(".md")) {
					// A note's highlights are questions too. Dropped quietly: the
					// next look rebuilds it, without a redraw on every keystroke.
					this.snapshot = null;
				}
			};
			this.registerEvent(this.app.vault.on("modify", (f) => watch(f.path)));
			this.registerEvent(this.app.vault.on("create", (f) => watch(f.path)));
			this.registerEvent(this.app.vault.on("delete", (f) => watch(f.path)));
			this.registerEvent(this.app.vault.on("rename", (f, old) => {
				watch(f.path);
				watch(old);
				void this.followRename(f, old);
			}));

			// Vault writes are not safe during onload, so the log opens here.
			this.log.open();
			this.queueFooters();
			void this.updateStatusBar();
			void this.cli.locate().then((where) =>
				this.log.info("startup CLI check", { found: where ?? "NOT FOUND", model: this.settings.model })
			);
		});
	}

	onunload(): void {
		// A bulk run must not outlive the plugin. Without this it kept going
		// after a reload, with no way to stop it short of quitting Obsidian.
		// Builds still waiting in the queue are dropped for the same reason.
		this.unloaded = true;
		this.cancelBulk();
		if (this.memoryTimer) window.clearTimeout(this.memoryTimer);
		document.querySelectorAll(".rl-note-footer").forEach((el) => el.remove());
	}

	get bulkRunning(): boolean {
		return this.bulkRun !== null && !this.bulkRun.cancelled;
	}

	cancelBulk(): void {
		if (this.bulkRun) {
			this.bulkRun.cancelled = true;
			this.log?.info("bulk generation cancelled");
		}
	}

	// ---------------------------------------------------------------- view

	async activate(): Promise<RecallLabView> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_RECALL)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE_RECALL, active: true });
		}
		await workspace.revealLeaf(leaf);
		return leaf.view as RecallLabView;
	}

	/**
	 * Highlight questions are filed under their note's path, so renaming or
	 * moving the note would orphan their history; it moves along instead. A
	 * note with no highlights is skipped without reading attempts.json.
	 */
	private async followRename(file: TAbstractFile, oldPath: string): Promise<void> {
		const folder = file instanceof TFolder;
		if (!folder) {
			if (!(file instanceof TFile) || file.extension !== "md") return;
			if (!(await this.app.vault.cachedRead(file)).includes("==")) return;
		}
		try {
			const moved = await this.store.moveHighlightHistory(oldPath, file.path, folder);
			if (moved) this.log.info("highlight history moved", { from: oldPath, to: file.path, answers: moved });
		} catch (e) {
			this.log.error("could not move highlight history", { from: oldPath, error: String(e) });
		}
	}

	/** Recall Lab's view, if it is open and loaded. */
	private openView(): RecallLabView | null {
		const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_RECALL)[0]?.view;
		return view instanceof RecallLabView ? view : null;
	}

	/**
	 * Starts a review from outside Recall Lab's view: a command, the status
	 * bar or a note's footer. Never over an exam, review or lab in progress,
	 * which would be dropped without its summary.
	 */
	private async reviewFromOutside(start: (view: RecallLabView) => Promise<void>): Promise<void> {
		const view = await this.activate();
		if (view.occupied) {
			new Notice("Finish or end the session in progress first.");
			return;
		}
		await start(view);
	}

	private async quizNote(file: TFile): Promise<void> {
		const bank = await this.store.bankForNote(file.path);
		const view = await this.activate();
		if (bank) { await view.startBankById(bank.id); return; }
		const id = await this.requestNoteQuiz(file.path);
		// The build takes minutes. If an exam or lab was opened meanwhile, the
		// new quiz waits in the list rather than replacing it.
		if (id && !view.occupied) await view.startBankById(id);
	}

	// ------------------------------------------------------- memory map

	/** Memory state for every note, shared by the dots, footers and status bar. */
	memorySnapshot(): Promise<MemorySnapshot> {
		if (this.snapshot && Date.now() - this.snapshot.at < SNAPSHOT_TTL) return this.snapshot.value;
		const value = this.buildSnapshot();
		this.snapshot = { at: Date.now(), value };
		// A failed build is not cached, so the next caller tries again.
		value.catch(() => { if (this.snapshot?.value === value) this.snapshot = null; });
		return value;
	}

	private async buildSnapshot(): Promise<MemorySnapshot> {
		const [files, progress, courses] = await Promise.all([
			this.store.listBanks(),
			this.store.readProgress(),
			this.store.listCourses(),
		]);
		// Highlight questions point at headings too, so they colour the dots.
		const banks = this.settings.highlightClozes ? [...files, ...(await this.store.listHighlightBanks(courses))] : files;
		const retention = this.settings.targetRecall / 100;
		const memory = Memory.of(progress.attempts, retention);
		const now = new Date();
		const today = endOfDay(now);
		return {
			at: now.getTime(),
			banks,
			memory,
			index: new AnswerIndex(progress.attempts),
			scoreOf: expectedScore(progress.attempts, retention, now),
			due: Store.itemsOf(banks).filter((it) => memory.isDue(keyOf(it), today)).length,
		};
	}

	/** One note's memory, from the banks that drill it; null if it has none. */
	private async noteMemoryOf(path: string): Promise<NoteMemory | null> {
		const snap = await this.memorySnapshot();
		const banks = snap.banks.filter((b) => b.note === path);
		if (!banks.length) return null;
		return noteMemory(banks, snap.memory, snap.scoreOf, (b, q) => snap.index.lastSeen(b, q), new Date());
	}

	/** Puts a memory dot beside each heading that a note's questions point at, in reading view. */
	private async decorateHeadings(el: HTMLElement, path: string): Promise<void> {
		if (!this.settings.memoryMap) return;
		const headings = Array.from(el.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"));
		if (!headings.length) return;
		const note = await this.noteMemoryOf(path);
		if (!note) return;
		for (const h of headings) {
			h.querySelector(":scope > .rl-memory-dot")?.remove();
			const section = note.sections.get(headingKey(h.textContent ?? ""));
			if (!section) continue;
			const dot = h.createSpan({ cls: `rl-memory-dot rl-memory-${dotLevel(section.score)}` });
			setTooltip(dot, describeSection(section));
		}
	}

	private async updateStatusBar(): Promise<void> {
		const bar = this.statusBar;
		if (!bar) return;
		const due = this.settings.memoryMap ? (await this.memorySnapshot()).due : 0;
		bar.querySelector(".rl-status-text")?.setText(`${due} due`);
		bar.toggleClass("rl-collapsed", !due);
	}

	/**
	 * Redraws everything outside Recall Lab's own view that shows memory: the
	 * status bar, note footers, and the dots in notes open in reading view.
	 * Called when a session ends rather than after every answer, so an open
	 * note does not redraw under you mid-review.
	 */
	async refreshMemoryViews(): Promise<void> {
		this.snapshot = null;
		this.memoryDay = dateKey(new Date());
		await this.updateStatusBar();
		await this.renderFooters(true);
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			// A tab not opened since startup holds a deferred view, not a
			// MarkdownView, and has nothing drawn to refresh.
			const view = leaf.view;
			if (view instanceof MarkdownView && view.getMode() === "preview") view.previewMode.rerender(true);
		}
	}

	/** Drops the stale snapshot, and soon redraws the status bar and footers to match. */
	private memoryChanged(): void {
		this.snapshot = null;
		if (this.memoryTimer) window.clearTimeout(this.memoryTimer);
		this.memoryTimer = window.setTimeout(() => {
			this.memoryTimer = null;
			// Mid-session every answer changes attempts.json; the session's end
			// refreshes everything once instead.
			if (this.openView()?.occupied) return;
			void this.updateStatusBar();
			void this.renderFooters(true);
		}, 3000);
	}

	private async tick(): Promise<void> {
		if (dateKey(new Date()) !== this.memoryDay) await this.refreshMemoryViews();
		else if (!this.snapshot || Date.now() - this.snapshot.at >= SNAPSHOT_TTL) await this.updateStatusBar();
	}

	// ------------------------------------------------------- note footer

	private footerTimer: number | null = null;

	private queueFooters(): void {
		if (this.footerTimer) window.clearTimeout(this.footerTimer);
		this.footerTimer = window.setTimeout(() => void this.renderFooters(), 120);
	}

	/**
	 * Appends a Complete button to the end of every open note that sits inside a
	 * course folder. Notes outside every course folder never get one. `force`
	 * rebuilds footers already there, so their memory line catches up.
	 */
	private async renderFooters(force = false): Promise<void> {
		const courses = await this.store.listCourses();
		const progress = await this.store.readProgress();

		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			const path = view.file?.path;
			if (!path) continue;

			const inCourse = courses.some((c) => path.startsWith(c.folder.replace(/\/+$/, "") + "/"));
			// Containers for reading mode and live preview respectively.
			const hosts = [
				view.contentEl.querySelector(".markdown-preview-section"),
				view.contentEl.querySelector(".cm-sizer"),
			].filter(Boolean) as HTMLElement[];

			// Worked out only when a footer is built: every answer drops the
			// snapshot, and rebuilding it to keep an existing footer is waste.
			let memory: Promise<NoteMemory | null> | null = null;
			for (const host of hosts) {
				const existing = host.querySelector(":scope > .rl-note-footer");
				if (!inCourse) { existing?.remove(); continue; }
				if (existing) {
					if (!force && existing.getAttribute("data-path") === path) continue;
					existing.remove();
				}
				memory ??= this.settings.memoryMap ? this.noteMemoryOf(path) : Promise.resolve(null);
				this.buildFooter(host, path, Boolean(progress.completed?.[path]), await memory);
			}
		}
	}

	private buildFooter(host: HTMLElement, path: string, done: boolean, memory: NoteMemory | null): void {
		const footer = host.createDiv({ cls: "rl-note-footer" });
		footer.setAttribute("data-path", path);

		const inner = footer.createDiv({ cls: "rl-note-footer-inner" });
		if (memory?.questions) {
			const line = inner.createDiv({ cls: "rl-footer-memory" });
			const last = memory.lastAnswered ? `last reviewed ${describeAgo(new Date(memory.lastAnswered), new Date())}` : "not reviewed yet";
			line.createSpan({ text: `${memory.due ? `${memory.due} due` : "Nothing due"} · ${last}` });
			if (memory.due) {
				const review = line.createEl("button", { cls: "rl-footer-btn", text: `Review this note (${memory.due})` });
				review.onclick = () => void this.reviewFromOutside((view) => view.startNoteReview(path));
			}
		}
		if (done) {
			inner.createDiv({ cls: "rl-footer-done", text: "✅ Marked complete" });
			const again = inner.createEl("button", { cls: "rl-footer-btn", text: "Practise this note" });
			again.onclick = async () => {
				const bank = await this.store.bankForNote(path);
				const view = await this.activate();
				if (bank) await view.startBankById(bank.id);
				else { new Notice("No quiz yet — queuing one."); await this.requestNoteQuiz(path); }
			};
		} else {
			inner.createDiv({
				cls: "rl-footer-text",
				text: "Finished reading this note? Mark it complete and Recall Lab will build a practical quiz on it.",
			});
			const btn = inner.createEl("button", { cls: "rl-footer-btn rl-footer-cta", text: "✓ Complete" });
			btn.onclick = () => void this.completeNote(path);
		}
	}

	/** Marks a note read and queues a practical quiz for that note alone. */
	async completeNote(path: string): Promise<void> {
		this.log.info("note marked complete", { note: path });
		await this.store.markComplete(path);

		// Open Recall Lab at this note's place in its course, so you can see
		// where it sits rather than being dropped on the overview.
		const view = await this.activate();
		await view.revealNote(path);

		if (!(await this.store.bankForNote(path))) {
			await this.requestNoteQuiz(path, true);
			if (!view.occupied) await view.revealNote(path);
		}
		void this.renderFooters();
	}

	// --------------------------------------------------- generation (automatic)

	/** Builds the quiz for one note, start to finish, with no commands to run. */
	async requestNoteQuiz(path: string, practical = false): Promise<string | null> {
		const courses = await this.store.listCourses();
		const course = courses.find((c) => path.startsWith(c.folder.replace(/\/+$/, "") + "/"));
		if (!course) {
			new Notice("That note is not inside a course folder, so nothing was built.", 8000);
			return null;
		}
		const name = path.split("/").pop()!.replace(/\.md$/, "");
		const res = await this.build(`quiz:${path}`, `quiz for "${name}"`, async () => {
			this.log.info("building a quiz", { note: path, course: course.id, practical });
			const notice = new Notice(`Building a quiz for "${name}"…`, 0);
			try {
				return await this.tasks.generateBank(path, course, practical);
			} finally {
				notice.hide();
			}
		});
		if (!res) return null;
		if ("error" in res) {
			this.log.error("quiz build failed", { note: path, error: res.error });
			new Notice(`Could not build that quiz: ${res.error}`, 15000);
			return null;
		}
		this.log.info("quiz built", { note: path, id: res.id, questions: res.questions.length });
		new Notice(`Built ${res.questions.length} questions for "${name}".`, 7000);
		// So the note's row stops saying "no quiz" without a manual redraw.
		await this.refreshView();
		return res.id;
	}

	/** Builds hands-on labs for one note. */
	async buildLabs(notePath: string, count = 3): Promise<number> {
		const courses = await this.store.listCourses();
		const course = courses.find((c) => notePath.startsWith(c.folder.replace(/\/+$/, "") + "/"));
		if (!course) { new Notice("That note is not inside a course folder."); return 0; }

		const name = notePath.split("/").pop()!.replace(/\.md$/, "");
		const res = await this.build(`labs:${notePath}`, `labs for "${name}"`, async () => {
			this.log.info("building labs", { note: notePath, count });
			const notice = new Notice(`Writing ${count} labs for "${name}"… this takes a couple of minutes.`, 0);
			try {
				return await this.tasks.generateLabs(notePath, course, count);
			} finally {
				notice.hide();
			}
		});
		if (!res) return 0;

		if ("error" in res) {
			this.log.error("lab build failed", { note: notePath, error: res.error });
			new Notice(`Could not write those labs: ${res.error}`, 15000);
			return 0;
		}
		this.log.info("labs built", { note: notePath, labs: res.length, asked: count });
		const short = res.length < count ? ` (${count - res.length} rejected as unsolvable)` : "";
		new Notice(`Wrote ${res.length} lab${res.length === 1 ? "" : "s"} for "${name}"${short}.`, 9000);
		await this.refreshView();
		return res.length;
	}

	/** Builds every missing quiz in a course, one note at a time. */
	async scanForMissingBanks(only?: Course): Promise<void> {
		const courses = only ? [only] : await this.store.listCourses();
		if (!courses.length) { new Notice("No courses set up yet."); return; }

		const todo: { course: Course; path: string }[] = [];
		const banks = await this.store.listBanks();
		for (const course of courses) {
			for (const path of this.store.notesWithoutBank(course, banks)) todo.push({ course, path });
		}
		if (!todo.length) { new Notice("Every note already has a quiz."); return; }

		if (this.bulkRunning) { new Notice("A generation run is already going. Stop it first."); return; }
		const run = { cancelled: false };
		this.bulkRun = run;

		const notice = new Notice("", 0);
		const body = notice.noticeEl;
		body.empty();
		const text = body.createDiv({ text: `Building quizzes: 0 / ${todo.length}…` });
		const stop = body.createEl("button", { text: "Stop", cls: "rl-footer-btn rl-notice-stop" });
		stop.onclick = () => { this.cancelBulk(); text.setText("Stopping after this quiz…"); };

		let built = 0, failed = 0;
		for (const [i, item] of todo.entries()) {
			if (run.cancelled) break;
			// Queued or built by hand since the run started: not built twice.
			const key = `quiz:${item.path}`;
			if (this.building.has(key) || (await this.store.bankForNote(item.path))) continue;
			text.setText(`Building quizzes: ${i + 1} / ${todo.length} — ${item.path.split("/").pop()}`);
			// Through the same queue as single builds, so one asked for by hand
			// mid-run goes next instead of running alongside.
			this.building.add(key);
			const res = await this.generation
				.run(async () => (run.cancelled ? null : this.tasks.generateBank(item.path, item.course, false)))
				.finally(() => this.building.delete(key));
			if (run.cancelled || !res) break;
			if ("error" in res) {
				failed += 1;
				this.log.error("quiz build failed", { note: item.path, error: res.error });
			} else {
				built += 1;
				// Redraw now, so the radar and counts fill in as work completes
				// rather than the panel sitting at zero for ten minutes.
				await this.refreshView();
			}
		}
		notice.hide();
		this.bulkRun = null;
		const how = run.cancelled ? "Stopped after" : "Built";
		new Notice(
			failed ? `${how} ${built} quizzes; ${failed} failed (see the log).` : `${how} ${built} quizzes.`,
			10000
		);
		this.log.info("bulk generation finished", { built, failed, cancelled: run.cancelled });
		await this.refreshView();
	}

	/** Works out a folder's skill areas. Its quizzes are built note by note afterwards. */
	async requestCourseSetup(folder: string): Promise<void> {
		const res = await this.build(`course:${folder}`, `course setup for "${folder}"`, async () => {
			this.log.info("setting up a course", { folder });
			const notice = new Notice(`Working out the skill areas for "${folder}"…`, 0);
			try {
				return await this.tasks.generateCourse(folder);
			} finally {
				notice.hide();
			}
		});
		if (!res) return;
		if ("error" in res) {
			this.log.error("course setup failed", { folder, error: res.error });
			new Notice(`Could not set that up: ${res.error}`, 15000);
			return;
		}
		this.log.info("course set up", { id: res.id, axes: res.axes.length });
		new Notice(
			`${res.title} is set up with ${res.axes.length} skill areas. Generate quizzes note by note, as you finish each one.`,
			10000
		);
		await this.refreshView();
	}

	/**
	 * Writes variants for mature questions, or guided steps for brutal
	 * problems: one Claude request per quiz, each through the generation
	 * queue. Only ever started from a confirmation.
	 */
	async buildExtras(kind: "variants" | "steps", targets: { bank: Bank; questions: Question[] }[]): Promise<void> {
		const label = kind === "variants" ? "variants" : "guided steps";
		let added = 0;
		let failed = 0;
		let elsewhere = 0;
		for (const { bank, questions } of targets) {
			// One quiz going wrong must not stop the rest, or end the run
			// without saying what happened.
			let res: number | { error: string } | null;
			try {
				const path = this.store.bankPath(bank.id);
				const ids = questions.map((q) => q.id);
				res = await this.build(`${kind}:${bank.id}`, `${label} for "${bank.title}"`, async () => {
					this.log.info(`writing ${label}`, { bank: bank.id, questions: ids.length });
					const notice = new Notice(`Writing ${label} for "${bank.title}"…`, 0);
					try {
						return kind === "variants"
							? await this.tasks.generateVariants(bank, path, ids)
							: await this.tasks.generateSteps(bank, path, ids);
					} finally {
						notice.hide();
					}
				});
			} catch (e) {
				res = { error: String(e) };
			}
			if (res === null) {
				elsewhere += 1; // already queued, or the plugin is unloading
			} else if (typeof res === "number") {
				added += res;
				this.log.info(`${label} written`, { bank: bank.id, added: res });
			} else {
				failed += 1;
				this.log.error(`${label} failed`, { bank: bank.id, error: res.error });
			}
		}
		if (this.unloaded) return;
		const parts = [kind === "variants"
			? `Wrote ${added} variant${added === 1 ? "" : "s"}`
			: `Added guided steps to ${added} problem${added === 1 ? "" : "s"}`];
		if (failed) parts.push(`${failed} quiz${failed === 1 ? "" : "zes"} failed (see the log)`);
		if (elsewhere) parts.push(`${elsewhere} already queued`);
		new Notice(`${parts.join("; ")}.`, 8000);
		await this.refreshView();
	}

	/** Offers to break every brutal problem without guided steps into steps, across all courses. */
	private async offerSteps(): Promise<void> {
		const needing = needingSteps(await this.store.listBanks());
		const n = needing.reduce((s, b) => s + b.questions.length, 0);
		if (!n) {
			new Notice("Every brutal problem already has guided steps.");
			return;
		}
		new ConfirmModal(
			this.app,
			`Write guided steps for ${n} brutal problem${n === 1 ? "" : "s"}?`,
			`Claude breaks each into 3 to 5 smaller steps, one request per quiz (${needing.length}). This uses your Claude plan.`,
			"Write steps",
			() => void this.buildExtras("steps", needing)
		).open();
	}

	/**
	 * Offers to rewrite the hints of labs written before hints were nudges:
	 * theirs walk through the solution, the last one all but giving it away.
	 */
	async offerHintRewrite(only?: Lab): Promise<void> {
		// Hints of a lab already solved or given up no longer matter.
		const progress = (await this.store.readProgress()).labs ?? {};
		const open = (l: Lab) => !progress[l.id]?.solvedAt && !progress[l.id]?.gaveUpAt;
		const labs = only ? [only] : (await this.labs.list()).filter((l) => hintsNeedShortening(l) && open(l));
		if (!labs.length) {
			new Notice("Every open lab's hints are already short nudges.");
			return;
		}
		const requests = Math.ceil(labs.length / 4);
		new ConfirmModal(
			this.app,
			only ? `Shorten the hints of "${only.title}"?` : `Shorten the hints of ${labs.length} lab${labs.length === 1 ? "" : "s"}?`,
			`Claude rewrites them as three CTF-style nudges of a few words (${requests} request${requests === 1 ? "" : "s"}). ` +
				"Hints you have already revealed stay revealed, in their new wording, and nothing else in your progress " +
				"changes. This uses your Claude plan.",
			"Shorten hints",
			() => void this.rewriteHints(labs)
		).open();
	}

	private async rewriteHints(labs: Lab[]): Promise<void> {
		const res = await this.build("lab-hints", "shorter lab hints", async () => {
			this.log.info("shortening lab hints", { labs: labs.length });
			const notice = new Notice(`Shortening the hints of ${labs.length} lab${labs.length === 1 ? "" : "s"}…`, 0);
			try {
				return await this.tasks.rewriteHints(labs);
			} finally {
				notice.hide();
			}
		});
		if (res === null) return;
		if ("error" in res) {
			this.log.error("shortening lab hints failed", { error: res.error });
			new Notice(`Could not shorten the hints: ${res.error}`, 12000);
			return;
		}
		// A lab can now have fewer hints than it had revealed; charge only for
		// hints that still exist.
		for (const [id, count] of Object.entries(res)) {
			const p = await this.store.labProgress(id);
			if (p.hintsUsed > count) await this.store.saveLabProgress({ ...p, hintsUsed: count });
		}
		const n = Object.keys(res).length;
		this.log.info("lab hints shortened", { labs: n });
		new Notice(`Shortened the hints of ${n} lab${n === 1 ? "" : "s"}${n < labs.length ? ` (${labs.length - n} kept their old hints)` : ""}.`, 8000);
		await this.openView()?.labsChanged(Object.keys(res));
	}

	/**
	 * Diagnoses a question you keep missing, saves the diagnosis and opens it.
	 * Uses Claude, so it only ever runs from a button that says so.
	 */
	async diagnoseLeech(leech: Leech, notePath: string | undefined): Promise<void> {
		const res = await this.build(`clinic:${leech.key}`, "the diagnosis", async () => {
			this.log.info("diagnosing a leech", { question: leech.key, misses: leech.misses });
			const notice = new Notice("Claude is reading your wrong answers…", 0);
			try {
				return await this.tasks.diagnoseLeech(leech, notePath);
			} finally {
				notice.hide();
			}
		});
		if (!res) return;
		if ("error" in res) {
			this.log.error("diagnosis failed", { question: leech.key, error: res.error });
			new Notice(`Could not diagnose that question: ${res.error}`, 12000);
			return;
		}
		await this.store.saveDiagnosis(leech.key, res);
		this.log.info("leech diagnosed", { question: leech.key });
		const view = await this.activate();
		if (!view.occupied) await view.openClinic(leech.key);
	}

	/** Offers to write variants for every mature question that has none, across all courses. */
	private async offerVariants(): Promise<void> {
		const [banks, progress] = await Promise.all([this.store.listBanks(), this.store.readProgress()]);
		const needing = needingVariants(banks, new AnswerIndex(progress.attempts));
		const n = needing.reduce((s, b) => s + b.questions.length, 0);
		if (!n) {
			new Notice("No question needs variants yet: a question qualifies once you have answered it right twice running.");
			return;
		}
		new ConfirmModal(
			this.app,
			`Write variants for ${n} question${n === 1 ? "" : "s"}?`,
			`Claude writes two variants of each, one request per quiz (${needing.length}). This uses your Claude plan.`,
			"Write variants",
			() => void this.buildExtras("variants", needing)
		).open();
	}

	/**
	 * Runs one build through the generation queue. Asking for something already
	 * queued or building does nothing rather than build it twice, and a build
	 * still waiting when the plugin unloads never starts. Resolves to null when
	 * it did not run.
	 */
	private async build<T>(key: string, what: string, job: () => Promise<T>): Promise<T | null> {
		if (this.building.has(key)) {
			new Notice(`Already queued or building: ${what}.`);
			return null;
		}
		if (this.generation.busy) new Notice(`Queued behind the build in progress: ${what}.`, 6000);
		this.building.add(key);
		try {
			return await this.generation.run(async () => (this.unloaded ? null : job()));
		} finally {
			this.building.delete(key);
		}
	}

	/**
	 * Quizzes and labs point at their note by path, and courses at their folder,
	 * so deleting or renaming one leaves them behind. Lists those and, once
	 * confirmed, moves them to the trash — recoverable, never a hard delete.
	 */
	async removeLeftovers(): Promise<void> {
		const { vault } = this.app;
		const found: { file: TFile; target: string }[] = [];
		const scan = async (folder: string, field: "note" | "folder", isFolder: boolean) => {
			const prefix = normalizePath(folder) + "/";
			for (const file of vault.getFiles()) {
				if (!file.path.startsWith(prefix) || file.extension !== "json") continue;
				let target: unknown;
				try {
					target = (JSON.parse(await vault.cachedRead(file)) as Record<string, unknown>)[field];
				} catch {
					continue; // unreadable: not this command's call to make
				}
				// A bank with no note at all is hand-made and standalone, not a leftover.
				if (typeof target !== "string" || !target) continue;
				const live = vault.getAbstractFileByPath(normalizePath(target));
				if (!(isFolder ? live instanceof TFolder : live instanceof TFile)) found.push({ file, target });
			}
		};
		await scan(this.settings.banksFolder, "note", false);
		await scan(this.settings.labsFolder, "note", false);
		await scan(this.settings.coursesFolder, "folder", true);

		if (!found.length) {
			new Notice("Nothing to remove: every quiz, lab and course still has its note or folder.");
			return;
		}
		new ConfirmModal(
			this.app,
			`Remove ${found.length} leftover file${found.length === 1 ? "" : "s"}?`,
			"Each points at a note or folder that no longer exists. They go to the trash, so they can be " +
				"restored, and your answer history is kept.",
			"Move to trash",
			() => void this.trash(found.map((f) => f.file)),
			found.map((f) => `${f.file.name} — was for ${f.target}`)
		).open();
	}

	private async trash(files: TFile[]): Promise<void> {
		let moved = 0;
		try {
			for (const file of files) {
				// Honours the "Deleted files" setting: Obsidian's trash or the system's.
				await this.app.fileManager.trashFile(file);
				moved += 1;
			}
		} catch (e) {
			this.log.error("removing leftovers failed", { moved, error: String(e) });
			new Notice(`Moved ${moved} of ${files.length} to the trash, then failed: ${String(e)}`, 12000);
			return;
		} finally {
			await this.refreshView();
		}
		this.log.info("removed leftovers", { files: moved });
		new Notice(`Moved ${moved} file${moved === 1 ? "" : "s"} to the trash.`);
	}

	/** Writes a full health report to the log and shows the headline. */
	async diagnose(): Promise<string> {
		this.log.info("--- diagnostics ---");
		const lines: string[] = [];

		const where = await this.cli.locate();
		lines.push(where ? `CLI: ${where}` : "CLI: NOT FOUND");
		this.log.info("diagnostics: cli", { path: where ?? "not found" });

		if (where) {
			const r = await this.cli.ask("Reply with exactly: OK", 60000);
			lines.push(r.ok ? `Claude replied (model ${this.settings.model})` : `Claude failed: ${r.error}`);
		}

		const courses = await this.store.listCourses();
		const banks = await this.store.listBanks();
		const progress = await this.store.readProgress();
		lines.push(`${courses.length} course(s), ${banks.length} quiz(zes), ${progress.sessions.length} exam(s)`);
		this.log.info("diagnostics: vault", {
			courses: courses.map((c) => c.id).join(","),
			banks: banks.length,
			sessions: progress.sessions.length,
		});

		const report = lines.join("\n");
		new Notice(report, 15000);
		return report;
	}

	private async refreshView(): Promise<void> {
		await this.openView()?.rerender();
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<RecallLabSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...saved };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Target recall changes every due date, so cached memory state is stale.
		this.memoryChanged();
	}
}
