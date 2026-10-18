import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, RecallLabSettingTab, RecallLabSettings } from "./settings";
import { Store } from "./store";
import { ClaudeCli } from "./claude";
import { Tasks } from "./tasks";
import { LabStore } from "./labs";
import { Log } from "./log";
import { RecallLabView, VIEW_TYPE_RECALL } from "./view";
import { Course } from "./types";

export default class RecallLabPlugin extends Plugin {
	settings!: RecallLabSettings;
	store!: Store;
	cli!: ClaudeCli;
	log!: Log;
	/** Set while a bulk generation run is in flight; cleared to stop it. */
	private bulkRun: { cancelled: boolean } | null = null;
	tasks!: Tasks;
	labs!: LabStore;

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
		this.labs = new LabStore(this.app, () => this.settings.labsFolder, () => this.settings.labWorkspace);

		this.registerView(VIEW_TYPE_RECALL, (leaf: WorkspaceLeaf) => new RecallLabView(leaf, this));
		this.addRibbonIcon("graduation-cap", "Recall Lab", () => void this.activate());
		this.addSettingTab(new RecallLabSettingTab(this.app, this));

		this.addCommand({ id: "open", name: "Open Recall Lab", callback: () => void this.activate() });

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

		// The "Complete" footer at the bottom of every note inside a course folder.
		this.registerEvent(this.app.workspace.on("file-open", () => this.queueFooters()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.queueFooters()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.queueFooters()));
		this.app.workspace.onLayoutReady(() => {
			// Vault writes are not safe during onload, so the log opens here.
			this.log.open();
			this.queueFooters();
			void this.cli.locate().then((where) =>
				this.log.info("startup CLI check", { found: where ?? "NOT FOUND", model: this.settings.model })
			);
		});
	}

	onunload(): void {
		// A bulk run must not outlive the plugin. Without this it kept going
		// after a reload, with no way to stop it short of quitting Obsidian.
		this.cancelBulk();
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

	private async quizNote(file: TFile): Promise<void> {
		const bank = await this.store.bankForNote(file.path);
		const view = await this.activate();
		if (bank) { await view.startBankById(bank.id); return; }
		const id = await this.requestNoteQuiz(file.path);
		if (id) await view.startBankById(id);
	}

	// ------------------------------------------------------- note footer

	private footerTimer: number | null = null;

	private queueFooters(): void {
		if (this.footerTimer) window.clearTimeout(this.footerTimer);
		this.footerTimer = window.setTimeout(() => void this.renderFooters(), 120);
	}

	/**
	 * Appends a Complete button to the end of every open note that sits inside a
	 * course folder. Notes outside every course folder never get one.
	 */
	private async renderFooters(): Promise<void> {
		const courses = await this.store.listCourses();
		const progress = await this.store.readProgress();

		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as MarkdownView;
			const path = view.file?.path;
			if (!path) continue;

			const inCourse = courses.some((c) => path.startsWith(c.folder.replace(/\/+$/, "") + "/"));
			// Containers for reading mode and live preview respectively.
			const hosts = [
				view.contentEl.querySelector(".markdown-preview-section"),
				view.contentEl.querySelector(".cm-sizer"),
			].filter(Boolean) as HTMLElement[];

			for (const host of hosts) {
				const existing = host.querySelector(":scope > .rl-note-footer");
				if (!inCourse) { existing?.remove(); continue; }
				if (existing) {
					if (existing.getAttribute("data-path") === path) continue;
					existing.remove();
				}
				this.buildFooter(host, path, Boolean(progress.completed?.[path]));
			}
		}
	}

	private buildFooter(host: HTMLElement, path: string, done: boolean): void {
		const footer = host.createDiv({ cls: "rl-note-footer" });
		footer.setAttribute("data-path", path);

		const inner = footer.createDiv({ cls: "rl-note-footer-inner" });
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
			await view.revealNote(path);
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
		this.log.info("building a quiz", { note: path, course: course.id, practical });
		const notice = new Notice(`Building a quiz for "${name}"…`, 0);
		const res = await this.tasks.generateBank(path, course, practical);
		notice.hide();
		if ("error" in res) {
			this.log.error("quiz build failed", { note: path, error: res.error });
			new Notice(`Could not build that quiz: ${res.error}`, 15000);
			return null;
		}
		this.log.info("quiz built", { note: path, id: res.id, questions: res.questions.length });
		new Notice(`Built ${res.questions.length} questions for "${name}".`, 7000);
		return res.id;
	}

	/** Builds every missing quiz in a course, one note at a time. */
	/** Builds hands-on labs for one note. */
	async buildLabs(notePath: string, count = 3): Promise<number> {
		const courses = await this.store.listCourses();
		const course = courses.find((c) => notePath.startsWith(c.folder.replace(/\/+$/, "") + "/"));
		if (!course) { new Notice("That note is not inside a course folder."); return 0; }

		const name = notePath.split("/").pop()!.replace(/\.md$/, "");
		this.log.info("building labs", { note: notePath, count });
		const notice = new Notice(`Writing ${count} labs for "${name}"… this takes a couple of minutes.`, 0);
		const res = await this.tasks.generateLabs(notePath, course, count);
		notice.hide();

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
		const stop = body.createEl("button", { text: "Stop", cls: "rl-footer-btn" });
		stop.style.marginTop = "0.5rem";
		stop.onclick = () => { this.cancelBulk(); text.setText("Stopping after this quiz…"); };

		let built = 0, failed = 0, spent = 0;
		for (const [i, item] of todo.entries()) {
			if (run.cancelled) break;
			text.setText(`Building quizzes: ${i + 1} / ${todo.length} — ${item.path.split("/").pop()}`);
			const res = await this.tasks.generateBank(item.path, item.course, false);
			if (run.cancelled) break;
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

	/** Works out a folder's skill areas and then builds all its quizzes. */
	async requestCourseSetup(folder: string): Promise<void> {
		this.log.info("setting up a course", { folder });
		const notice = new Notice(`Working out the skill areas for "${folder}"…`, 0);
		const res = await this.tasks.generateCourse(folder);
		if ("error" in res) {
			notice.hide();
			this.log.error("course setup failed", { folder, error: res.error });
			new Notice(`Could not set that up: ${res.error}`, 15000);
			return;
		}
		notice.hide();
		this.log.info("course set up", { id: res.id, axes: res.axes.length });
		new Notice(
			`${res.title} is set up with ${res.axes.length} skill areas. Generate quizzes note by note, as you finish each one.`,
			10000
		);
		await this.refreshView();
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
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_RECALL)[0];
		if (leaf) await (leaf.view as RecallLabView).rerender();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
