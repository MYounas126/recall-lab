import { App, ButtonComponent, Component, ItemView, MarkdownRenderer, Modal, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type RecallLabPlugin from "./main";
import { Store } from "./store";
import { gradeLocally } from "./grader";
import { shuffled } from "./util";
import { renderRadar, scoreAxes, scoreCourses, weakestTested, untested, AxisScore } from "./radar";
import { Attempt, Bank, Course, Lab, LabProgress, Question, SessionSummary, Tier, labScore, letterGrade } from "./types";
import { checkFlag } from "./labs";
import { INSTALL_HINT } from "./claude";

// Rough per-quiz figures for the bulk-generation dialog. Illustrative only:
// they drift with the model, the note's length and plan pricing, which is why
// the dialog says "about" and "roughly".
const SECONDS_PER_QUIZ = 50;
const USD_PER_QUIZ = 0.13;

export const VIEW_TYPE_RECALL = "recall-lab-view";

type Screen = "home" | "folder" | "exam" | "results" | "history" | "lab";

interface AnswerState {
	/** ORIGINAL choice indices — never display slots. */
	chosen: number[];
	text: string;
	image?: string;
}

interface LiveAnswer {
	q: Question;
	response: string;
	image?: string;
	attempt?: Attempt;
	ms: number;
}

/** Everything Recall Lab shows lives in this one view — there is no companion note. */
export class RecallLabView extends ItemView {
	private plugin: RecallLabPlugin;
	private screen: Screen = "home";
	private selectedFolder: string | null = null;
	/** A note row to scroll to and flash after the next folder render. */
	private pendingReveal: string | null = null;

	private banks: Bank[] = [];
	private courses: Course[] = [];
	private allLabs: Lab[] = [];
	private openLab: Lab | null = null;

	private bank: Bank | null = null;
	private examQuestions: Question[] = [];
	private index = 0;
	private answers: LiveAnswer[] = [];
	private sessionId = "";
	private questionStart = 0;
	private revealed = false;

	constructor(leaf: WorkspaceLeaf, plugin: RecallLabPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return VIEW_TYPE_RECALL; }
	getDisplayText(): string { return "Recall Lab"; }
	getIcon(): string { return "graduation-cap"; }

	async onOpen(): Promise<void> {
		await this.render();
	}

	/**
	 * True while an exam or a lab is on screen. A redraw there rebuilds the
	 * question and throws away what was typed — and after Submit it leaves a
	 * dead button — so background work must not trigger one.
	 */
	get occupied(): boolean {
		return this.screen === "exam" || this.screen === "lab";
	}

	/**
	 * Redraws from disk — used after the plugin writes new banks or courses.
	 * Skipped while occupied; the next screen change reads from disk anyway.
	 */
	async rerender(): Promise<void> {
		if (this.occupied) return;
		await this.render();
	}

	/** Jumps to the folder view for a note and highlights its row. */
	async revealNote(path: string): Promise<void> {
		await this.refresh();
		const course = this.courses.find((c) => path.startsWith(c.folder.replace(/\/+$/, "") + "/"));
		this.selectedFolder = course?.folder ?? path.split("/").slice(0, -1).join("/");
		this.screen = "folder";
		this.pendingReveal = path;
		await this.render();
	}

	async openFolder(folder: string): Promise<void> {
		this.selectedFolder = folder;
		this.screen = "folder";
		await this.render();
	}

	async startBankById(bankId: string): Promise<void> {
		await this.refresh();
		const bank = this.banks.find((b) => b.id === bankId);
		if (!bank) { new Notice("Recall Lab: that quiz has not been generated yet."); return; }
		await this.beginExam(bank, false);
	}

	private async refresh(): Promise<void> {
		this.banks = await this.plugin.store.listBanks();
		this.courses = await this.plugin.store.listCourses();
		this.allLabs = await this.plugin.labs.list();
	}

	// ================================================================ layout

	private async render(): Promise<void> {
		try {
			await this.renderInner();
		} catch (e) {
			// A thrown render used to leave an empty pane that looked like dead
			// buttons. Show the fault instead, and write it down.
			console.error("Recall Lab: render failed", e);
			this.plugin.log.error("render failed", { error: String(e), stack: String((e as Error)?.stack ?? "").slice(0, 400) });
			const root = this.contentEl;
			root.empty();
			const box = root.createDiv({ cls: "rl-main" });
			box.createEl("h2", { text: "Recall Lab hit an error" });
			box.createEl("pre", { cls: "rl-code", text: String(e) });
			box.createDiv({ cls: "rl-muted", text: `The full trace is in ${this.plugin.settings.progressFolder}/recall-lab.log and the developer console (Cmd+Opt+I).` });
			const actions = box.createDiv({ cls: "rl-actions" });
			new ButtonComponent(actions).setButtonText("Back to overview").setCta()
				.onClick(() => { this.screen = "home"; this.selectedFolder = null; void this.render(); });
			new ButtonComponent(actions).setButtonText("Run diagnostics")
				.onClick(() => void this.plugin.diagnose());
		}
	}

	private async renderInner(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("recall-lab");

		if (this.screen === "exam") { await this.renderExam(root); return; }

		const shell = root.createDiv({ cls: "rl-shell" });
		const side = shell.createDiv({ cls: "rl-side" });
		const main = shell.createDiv({ cls: "rl-main" });

		await this.refresh();
		await this.renderSidebar(side);

		if (this.screen === "lab" && this.openLab) await this.renderLab(main, this.openLab);
		else if (this.screen === "results") await this.renderResults(main);
		else if (this.screen === "history") await this.renderHistory(main);
		else if (this.screen === "folder" && this.selectedFolder) await this.renderFolder(main, this.selectedFolder);
		else await this.renderHome(main);
	}

	private async renderSidebar(side: HTMLElement): Promise<void> {
		const head = side.createDiv({ cls: "rl-side-head" });
		setIcon(head.createSpan(), "graduation-cap");
		head.createSpan({ text: "Recall Lab" });

		const nav = side.createDiv({ cls: "rl-nav" });
		const navItem = (icon: string, label: string, active: boolean, onClick: () => void) => {
			const row = nav.createDiv({ cls: "rl-nav-item" + (active ? " rl-nav-active" : "") });
			setIcon(row.createSpan({ cls: "rl-nav-icon" }), icon);
			row.createSpan({ text: label });
			row.onclick = onClick;
		};
		navItem("home", "Overview", this.screen === "home", () => { this.screen = "home"; this.selectedFolder = null; void this.render(); });
		navItem("history", "History", this.screen === "history", () => { this.screen = "history"; void this.render(); });

		side.createDiv({ cls: "rl-side-label", text: "Folders" });
		const list = side.createDiv({ cls: "rl-folders" });

		const folders = this.plugin.store.folderTree();
		for (const f of folders) {
			const course = this.courses.find((c) => c.folder === f.path);
			const banks = course ? Store.banksForCourse(course, this.banks) : this.banks.filter((b) => b.note?.startsWith(f.path + "/"));
			const row = list.createDiv({
				cls: "rl-folder" + (this.selectedFolder === f.path && this.screen === "folder" ? " rl-folder-active" : ""),
			});
			setIcon(row.createSpan({ cls: "rl-folder-icon" }), course ? "book-open" : "folder");
			const body = row.createDiv({ cls: "rl-folder-body" });
			body.createDiv({ cls: "rl-folder-name", text: f.path });
			body.createDiv({
				cls: "rl-folder-meta",
				text: `${f.notes} note${f.notes === 1 ? "" : "s"} · ${banks.length} quiz${banks.length === 1 ? "" : "zes"}`,
			});
			row.onclick = () => { this.selectedFolder = f.path; this.screen = "folder"; void this.render(); };
		}
		if (!folders.length) list.createDiv({ cls: "rl-muted", text: "No folders with notes found." });
	}

	// ================================================================ home

	private async renderHome(main: HTMLElement): Promise<void> {
		const progress = await this.plugin.store.readProgress();

		const head = main.createDiv({ cls: "rl-head" });
		head.createEl("h2", { text: "Overview" });
		this.renderClaudeStatus(head);

		if (!this.courses.length) {
			const empty = main.createDiv({ cls: "rl-empty" });
			empty.createEl("p", { text: "No courses set up yet. Pick a folder on the left and press Set up this course — Claude reads the notes, works out the skill areas, and writes the quizzes." });
			return;
		}

		// The central radar: one spoke per course, across the whole vault.
		const scores = scoreCourses(this.courses, (c) => Store.banksForCourse(c, this.banks), progress.attempts);
		const overall = scores.length ? Math.round(scores.reduce((s, a) => s + a.score, 0) / scores.length) : 0;

		const panel = main.createDiv({ cls: "rl-panel rl-panel-hero" });
		const ph = panel.createDiv({ cls: "rl-panel-head" });
		ph.createEl("h3", { text: "Across the whole vault" });
		ph.createSpan({ cls: "rl-grade-pill", text: `${overall}% · ${letterGrade(overall)}` });
		if (scores.length >= 3) {
			renderRadar(panel.createDiv({ cls: "rl-radar-wrap" }), scores);
		} else {
			panel.createDiv({ cls: "rl-muted", text: `A radar needs three courses; you have ${scores.length}. Set up more folders and it appears here.` });
		}
		this.renderLegend(panel, scores, (id) => {
			const c = this.courses.find((x) => x.id === id);
			if (c) { this.selectedFolder = c.folder; this.screen = "folder"; void this.render(); }
		});

		// Per-course cards.
		for (const course of this.courses) {
			const courseBanks = Store.banksForCourse(course, this.banks);
			const card = main.createDiv({ cls: "rl-panel" });
			const ch = card.createDiv({ cls: "rl-panel-head" });
			ch.createEl("h3", { text: course.title });
			const inner = scoreAxes(course, courseBanks, progress.attempts);
			const cm = inner.filter((a) => a.total).length
				? Math.round(inner.filter((a) => a.total).reduce((s, a) => s + a.score, 0) / inner.filter((a) => a.total).length)
				: 0;
			ch.createSpan({ cls: "rl-grade-pill", text: `${cm}%` });
			card.createDiv({ cls: "rl-muted", text: `${courseBanks.length} quiz${courseBanks.length === 1 ? "" : "zes"} · ${courseBanks.reduce((n, b) => n + b.questions.length, 0)} questions` });
			new ButtonComponent(card.createDiv({ cls: "rl-actions" }))
				.setButtonText("Open course")
				.setCta()
				.onClick(() => { this.selectedFolder = course.folder; this.screen = "folder"; void this.render(); });
		}
	}

	private renderLegend(panel: HTMLElement, scores: AxisScore[], onClick?: (id: string) => void): void {
		const legend = panel.createDiv({ cls: "rl-radar-legend" });
		const weakest = weakestTested(scores);
		for (const s of scores) {
			const row = legend.createDiv({ cls: "rl-legend-row" });
			if (weakest && s.axis.id === weakest.axis.id) row.addClass("rl-legend-weak");
			if (s.total > 0 && s.seen === 0) row.addClass("rl-legend-untested");
			if (onClick) { row.addClass("rl-clickable"); row.onclick = () => onClick(s.axis.id); }
			row.createSpan({ cls: "rl-legend-label", text: s.axis.label });
			row.createSpan({
				cls: "rl-legend-score",
				text: !s.total ? "no quiz yet" : s.seen === 0 ? "not tested" : `${s.score}%`,
			});
		}
	}

	/**
	 * Warns if the CLI cannot be found. Deliberately not awaited by the render
	 * path: probing spawns a process, and a slow or failing probe must never
	 * stop the panel from drawing.
	 */
	private renderClaudeStatus(head: HTMLElement): void {
		void this.claudeStatus(head).catch((e) => this.plugin.log.error("status check failed", { error: String(e) }));
	}

	private async claudeStatus(head: HTMLElement): Promise<void> {
		if (await this.plugin.cli.locate()) return;
		if (!head.isConnected) return;
		const badge = head.createDiv({ cls: "rl-pending-badge rl-badge-warn" });
		setIcon(badge.createSpan(), "alert-triangle");
		badge.createSpan({ text: "Claude CLI not found — marking and quiz building are offline" });
		new ButtonComponent(badge).setButtonText("How to fix").onClick(() => {
			new Notice(
				"Recall Lab runs Claude through the Claude Code CLI on your own subscription.\n\n" +
					`${INSTALL_HINT}\n\n` +
					"Then reopen this tab. If it is installed but still not found, set its path in Recall Lab settings.",
				20000
			);
		});
	}

	// ================================================================ folder

	private async renderFolder(main: HTMLElement, folder: string): Promise<void> {
		const progress = await this.plugin.store.readProgress();
		const course = this.courses.find((c) => c.folder === folder);

		const head = main.createDiv({ cls: "rl-head" });
		head.createEl("h2", { text: course?.title ?? folder });
		this.renderClaudeStatus(head);

		if (!course) {
			const setup = main.createDiv({ cls: "rl-panel" });
			setup.createEl("p", { text: `${folder} is not set up as a course yet.` });
			const n = this.plugin.store.notesIn(folder).length;
			setup.createDiv({
				cls: "rl-muted",
				text: `Claude reads the ${n} note${n === 1 ? "" : "s"} here and works out the course's skill areas. It does not write any quizzes — you generate those one note at a time, as you finish each one.`,
			});
			new ButtonComponent(setup.createDiv({ cls: "rl-actions" }))
				.setButtonText("Set up this course")
				.setCta()
				.onClick(() => void this.plugin.requestCourseSetup(folder));
			this.renderNoteList(main, folder, [], progress);
			return;
		}

		const courseBanks = Store.banksForCourse(course, this.banks);
		const scores = scoreAxes(course, courseBanks, progress.attempts);
		const tested = scores.filter((a) => a.total > 0 && a.seen > 0);
		const overall = tested.length ? Math.round(tested.reduce((s, a) => s + a.score, 0) / tested.length) : 0;

		// This course's own radar.
		const panel = main.createDiv({ cls: "rl-panel rl-panel-hero" });
		const ph = panel.createDiv({ cls: "rl-panel-head" });
		ph.createEl("h3", { text: "Skill radar" });
		ph.createSpan({ cls: "rl-grade-pill", text: `${overall}% · ${letterGrade(overall)}` });
		renderRadar(panel.createDiv({ cls: "rl-radar-wrap" }), scores);
		this.renderLegend(panel, scores);
		const weakest = weakestTested(scores);
		const notYet = untested(scores);
		if (weakest) {
			panel.createDiv({
				cls: "rl-radar-note",
				text: `Weakest tested area: ${weakest.axis.label} at ${weakest.score}%. That is where the next exam should go.`,
			});
		}
		if (notYet.length) {
			panel.createDiv({
				cls: "rl-radar-note",
				text: `Not tested yet: ${notYet.map((a) => a.axis.label).join(", ")} — these read zero because they have not come up, not because you got them wrong.`,
			});
		}

		// Course-wide exam.
		const examPanel = main.createDiv({ cls: "rl-panel" });
		examPanel.createEl("h3", { text: "Course exam" });
		const allQ = courseBanks.reduce((n, b) => n + b.questions.length, 0);
		examPanel.createDiv({ cls: "rl-muted", text: `One paper that ramps from recall to application to synthesis, drawn across all ${courseBanks.length} quiz${courseBanks.length === 1 ? "" : "zes"} (${allQ} questions).` });
		const ea = examPanel.createDiv({ cls: "rl-actions" });
		if (courseBanks.length) {
			new ButtonComponent(ea).setButtonText(`Start exam (${this.plugin.settings.defaultLength})`).setCta()
				.onClick(() => void this.beginCourseExam(course, courseBanks, this.plugin.settings.defaultLength));
			new ButtonComponent(ea).setButtonText("Full exam (everything)")
				.onClick(() => void this.beginCourseExam(course, courseBanks, allQ));
		} else {
			examPanel.createDiv({ cls: "rl-muted", text: "No quizzes yet — generate one from a note below." });
		}
		const missing = this.plugin.store.notesWithoutBank(course, this.banks).length;
		if (missing) {
			const mins = Math.ceil((missing * SECONDS_PER_QUIZ) / 60);
			const cost = (missing * USD_PER_QUIZ).toFixed(2);
			new ButtonComponent(ea)
				.setButtonText(`Generate all ${missing} missing quizzes…`)
				.onClick(() => {
					// Bulk generation is slow and costs real plan usage, so it is
					// never started on a single click.
					new ConfirmModal(
						this.app,
						`Generate ${missing} quizzes?`,
						`That is about ${mins} minute${mins === 1 ? "" : "s"} of work and roughly $${cost} of your Claude plan. ` +
							`You can stop it at any point from the progress notice.`,
						`Generate ${missing}`,
						() => void this.plugin.scanForMissingBanks(course)
					).open();
				});
		}
		if (this.plugin.bulkRunning) {
			new ButtonComponent(ea).setButtonText("Stop generating").setWarning()
				.onClick(() => { this.plugin.cancelBulk(); new Notice("Will stop after the quiz in flight."); });
		}

		this.renderLabPanel(main, folder, progress);
		this.renderNoteList(main, folder, courseBanks, progress);
	}

	/** All of a course's labs in one place, with their state. */
	private renderLabPanel(main: HTMLElement, folder: string, progress: { labs?: Record<string, { solvedAt?: string; gaveUpAt?: string; attempts: number; hintsUsed: number }> }): void {
		const prefix = folder.replace(/\/+$/, "") + "/";
		const labs = this.allLabs.filter((l) => l.note.startsWith(prefix));

		const panel = main.createDiv({ cls: "rl-panel" });
		const head = panel.createDiv({ cls: "rl-panel-head" });
		head.createEl("h3", { text: `🧪 Labs (${labs.length})` });
		const solved = labs.filter((l) => progress.labs?.[l.id]?.solvedAt).length;
		if (labs.length) head.createSpan({ cls: "rl-grade-pill", text: `${solved}/${labs.length} solved` });

		if (!labs.length) {
			panel.createDiv({
				cls: "rl-muted",
				text: "No labs yet. Press Labs beside a note below and Claude writes CTF-style challenges for it — one source file each, nothing to install.",
			});
			return;
		}

		panel.createDiv({
			cls: "rl-muted",
			text: "Hands-on challenges. You get one source file, work out the flag by reading it, and submit it here.",
		});

		const order: Record<string, number> = { easy: 0, hard: 1, brutal: 2 };
		for (const lab of labs.slice().sort((a, b) => order[a.tier] - order[b.tier] || a.title.localeCompare(b.title))) {
			const p = progress.labs?.[lab.id];
			const row = panel.createDiv({ cls: "rl-lab-row" });
			row.createSpan({ cls: `rl-tier-badge rl-tier-${lab.tier}`, text: tierLabel(lab.tier) });

			const body = row.createDiv({ cls: "rl-lab-body" });
			body.createDiv({ cls: "rl-lab-title", text: lab.title });
			const note = lab.note.split("/").pop()!.replace(/\.md$/, "");
			const state = p?.solvedAt
				? `solved · ${labScore(p as never)}%`
				: p?.gaveUpAt
					? "gave up"
					: p?.attempts
						? `${p.attempts} wrong so far`
						: "not started";
			body.createDiv({ cls: "rl-lab-meta", text: `${note} · ${state}${lab.minutes ? ` · ~${lab.minutes} min` : ""}` });

			const right = row.createDiv({ cls: "rl-note-actions" });
			if (p?.solvedAt) setIcon(right.createSpan({ cls: "rl-note-done" }), "check-circle");
			new ButtonComponent(right)
				.setButtonText(p?.solvedAt ? "Review" : p?.attempts ? "Continue" : "Open lab")
				.setCta()
				.onClick(() => { this.openLab = lab; this.screen = "lab"; void this.render(); });
		}
	}

	private renderNoteList(main: HTMLElement, folder: string, courseBanks: Bank[], progress: { completed?: Record<string, string> }): void {
		const notes = this.plugin.store.notesIn(folder);
		const panel = main.createDiv({ cls: "rl-panel" });
		panel.createEl("h3", { text: `Notes (${notes.length})` });

		for (const path of notes) {
			const bank = courseBanks.find((b) => b.note === path);
			const row = panel.createDiv({ cls: "rl-note-row" });
			row.setAttribute("data-path", path);

			const name = row.createDiv({ cls: "rl-note-name" });
			if (progress.completed?.[path]) setIcon(name.createSpan({ cls: "rl-note-done" }), "check");
			const link = name.createEl("a", { text: path.split("/").pop()!.replace(/\.md$/, ""), cls: "rl-link" });
			link.onclick = (e) => { e.preventDefault(); void this.app.workspace.openLinkText(path, "", false); };

			const labs = this.allLabs.filter((l) => l.note === path);
			if (labs.length) {
				const chip = row.createDiv({ cls: "rl-note-labs" });
				for (const lab of labs) {
					const tag = chip.createSpan({ cls: `rl-chip rl-lab-chip rl-tier-dot-${lab.tier}` });
					tag.setText(`🧪 ${lab.title}`);
					tag.onclick = () => { this.openLab = lab; this.screen = "lab"; void this.render(); };
				}
			}

			const right = row.createDiv({ cls: "rl-note-actions" });
			if (bank) {
				right.createSpan({ cls: "rl-chip", text: `${bank.questions.length} q` });
				new ButtonComponent(right).setButtonText("Exam").setCta()
					.onClick(() => void this.beginExam(bank, false));
				if (!this.allLabs.some((l) => l.note === path)) {
					new ButtonComponent(right)
						.setButtonText("Labs")
						.setTooltip("Write hands-on labs for this note")
						.onClick(() => void this.plugin.buildLabs(path));
				}
				new ButtonComponent(right)
					.setIcon("refresh-cw")
					.setTooltip("Rebuild this quiz from the note, replacing the current questions")
					.onClick(async () => {
						await this.plugin.requestNoteQuiz(path);
						if (!this.occupied) await this.revealNote(path);
					});
			} else {
				right.createSpan({ cls: "rl-chip rl-chip-dim", text: "no quiz" });
				new ButtonComponent(right).setButtonText("Generate")
					.onClick(() => void this.plugin.requestNoteQuiz(path));
			}
		}
		if (!notes.length) panel.createDiv({ cls: "rl-muted", text: "No notes in this folder." });

		if (this.pendingReveal) {
			const target = this.pendingReveal;
			this.pendingReveal = null;
			window.setTimeout(() => {
				const row = panel.querySelector(`.rl-note-row[data-path="${CSS.escape(target)}"]`);
				if (!(row instanceof HTMLElement)) return;
				row.scrollIntoView({ behavior: "smooth", block: "center" });
				row.addClass("rl-note-revealed");
				window.setTimeout(() => row.removeClass("rl-note-revealed"), 2600);
			}, 60);
		}
	}

	// ================================================================ exam

	private async beginCourseExam(course: Course, banks: Bank[], total: number): Promise<void> {
		const progress = await this.plugin.store.readProgress();
		// Merge the course's banks into one virtual paper.
		const merged: Bank = {
			id: `course:${course.id}`,
			title: course.title,
			note: course.folder,
			questions: banks.flatMap((b) => b.questions),
		};
		const picked = total >= merged.questions.length
			? Store.fullExam(merged)
			: Store.pickExam(merged, progress.attempts, total);
		await this.launch(merged, picked);
	}

	private async beginExam(bank: Bank, full: boolean): Promise<void> {
		const progress = await this.plugin.store.readProgress();
		const picked = full
			? Store.fullExam(bank)
			: Store.pickExam(bank, progress.attempts, Math.min(this.plugin.settings.defaultLength, bank.questions.length));
		await this.launch(bank, picked);
	}

	private async launch(bank: Bank, picked: Question[]): Promise<void> {
		if (!picked.length) { new Notice("Recall Lab: that quiz has no questions."); return; }
		this.bank = bank;
		this.examQuestions = picked;
		this.index = 0;
		this.answers = [];
		this.sessionId = `s-${Date.now().toString(36)}`;
		this.screen = "exam";
		this.revealed = false;
		this.questionStart = Date.now();
		await this.render();
	}

	private async renderExam(root: HTMLElement): Promise<void> {
		const q = this.examQuestions[this.index];
		if (!q || !this.bank) { this.screen = "home"; await this.render(); return; }

		const wrap = root.createDiv({ cls: "rl-exam" });
		const bar = wrap.createDiv({ cls: "rl-sessionbar" });
		bar.createSpan({ cls: "rl-crumb", text: this.bank.title });
		bar.createSpan({ cls: `rl-tier-badge rl-tier-${q.tier}`, text: tierLabel(q.tier) });
		bar.createSpan({ cls: "rl-count", text: `${this.index + 1} / ${this.examQuestions.length}` });
		const quit = bar.createEl("a", { cls: "rl-link rl-quit", text: "End exam" });
		quit.onclick = (e) => { e.preventDefault(); void this.finish(); };
		const track = bar.createDiv({ cls: "rl-progress rl-progress-slim" });
		track.createDiv({ cls: "rl-progress-fill" }).setCssProps({ "--rl-fill": `${(this.index / this.examQuestions.length) * 100}%` });

		const card = wrap.createDiv({ cls: "rl-question" });
		const meta = card.createDiv({ cls: "rl-qmeta" });
		meta.createSpan({ cls: "rl-chip", text: q.topic });
		if (q.timestamp) meta.createSpan({ cls: "rl-chip rl-chip-dim", text: q.timestamp });

		await this.md(q.prompt, card.createDiv({ cls: "rl-prompt" }));
		if (q.code) card.createEl("pre", { cls: "rl-code" }).createEl("code", { text: q.code });

		const state: AnswerState = { chosen: [], text: "" };
		this.renderAnswerWidget(q, card.createDiv({ cls: "rl-answer" }), state);

		const actions = card.createDiv({ cls: "rl-actions" });
		const submit = new ButtonComponent(actions).setButtonText("Submit").setCta()
			.onClick(() => void this.submit(q, state, wrap));
		if (q.type === "short" || q.type === "command" || q.type === "image") {
			new ButtonComponent(actions).setButtonText("I don't know")
				.onClick(() => { state.text = ""; void this.submit(q, state, wrap, true); });
		}
		submit.buttonEl.focus();
	}

	private renderAnswerWidget(q: Question, el: HTMLElement, state: AnswerState): void {
		if (q.type === "mcq" || q.type === "multi") {
			const multi = q.type === "multi";
			if (multi) el.createDiv({ cls: "rl-hint", text: "Select every correct option." });

			// Fresh random order each render; state.chosen keeps ORIGINAL indices.
			const order = shuffled((q.choices ?? []).map((_, i) => i));
			order.forEach((original, slot) => {
				const row = el.createDiv({ cls: "rl-choice" });
				const input = row.createEl("input", {
					type: multi ? "checkbox" : "radio",
					attr: { name: `q-${q.id}`, id: `c-${q.id}-${slot}` },
				});
				void this.md(q.choices![original], row.createEl("label", { attr: { for: `c-${q.id}-${slot}` } }));
				row.onclick = (e) => { if (e.target !== input) input.click(); };
				input.onchange = () => {
					if (multi) {
						state.chosen = state.chosen.includes(original)
							? state.chosen.filter((x) => x !== original)
							: [...state.chosen, original];
					} else state.chosen = [original];
					el.querySelectorAll(".rl-choice").forEach((c, ci) => c.toggleClass("rl-chosen", state.chosen.includes(order[ci])));
				};
			});
			return;
		}

		if (q.type === "image") {
			const drop = el.createDiv({ cls: "rl-dropzone" });
			drop.createEl("p", { text: "Paste a screenshot (⌘V) or choose a file." });
			const file = el.createEl("input", { type: "file", attr: { accept: "image/*" } });
			const preview = el.createDiv({ cls: "rl-preview" });
			const load = (f: File) => {
				const reader = new FileReader();
				reader.onload = () => { state.image = String(reader.result); preview.empty(); preview.createEl("img", { attr: { src: state.image! } }); };
				reader.readAsDataURL(f);
			};
			file.onchange = () => { const f = file.files?.[0]; if (f) load(f); };
			drop.onpaste = (e: ClipboardEvent) => {
				const items = e.clipboardData?.items;
				const list = items ? Array.from({ length: items.length }, (_, i) => items[i]) : [];
				const f = list.find((i) => i.type.startsWith("image/"))?.getAsFile();
				if (f) { e.preventDefault(); load(f); }
			};
			drop.tabIndex = 0;
			const note = el.createEl("textarea", { cls: "rl-text", attr: { placeholder: "Explain what the image shows." } });
			note.oninput = () => (state.text = note.value);
			return;
		}

		const area = el.createEl("textarea", {
			cls: q.type === "command" ? "rl-text rl-mono" : "rl-text",
			attr: {
				placeholder: q.type === "command" ? "Type the exact command you would run." : "Answer in your own words.",
				rows: q.type === "command" ? "2" : "5",
			},
		});
		area.oninput = () => (state.text = area.value);
		window.setTimeout(() => area.focus(), 0);
	}

	private async submit(q: Question, state: AnswerState, wrap: HTMLElement, gaveUp = false): Promise<void> {
		if (this.revealed) return;
		if ((q.type === "mcq" || q.type === "multi") && !state.chosen.length) { new Notice("Pick an answer first."); return; }
		this.revealed = true;
		const ms = Date.now() - this.questionStart;

		const local = gaveUp
			? { score: 0, verdict: "incorrect" as const, feedback: "You skipped this one.", missing: [q.topic] }
			: gradeLocally(q, state.text, state.chosen);

		const live: LiveAnswer = { q, response: state.text || describeChoice(q, state.chosen), image: state.image, ms };
		if (local) {
			live.attempt = this.attemptFrom(q, live.response, local.score, local.verdict, local.feedback, local.missing, "local", ms);
			this.answers.push(live);
			this.showFeedback(q, live, wrap);
			return;
		}

		// Open answer: Claude marks it now, in place. No queue, no commands.
		this.answers.push(live);
		const panel = this.showFeedback(q, live, wrap, true);
		this.plugin.log.info("marking an open answer", { question: q.id, type: q.type });
		const marked = await this.plugin.tasks.markAnswer(q, state.text, state.image);
		if ("error" in marked) {
			this.plugin.log.error("marking failed", { question: q.id, error: marked.error });
			live.attempt = this.attemptFrom(q, live.response, 0, "incorrect",
				`Could not reach Claude to mark this: ${marked.error}`, [q.topic], "local", ms);
		} else {
			this.plugin.log.info("answer marked", { question: q.id, score: marked.score });
			live.attempt = this.attemptFrom(q, live.response, marked.score, marked.verdict,
				[marked.feedback, marked.improve].filter(Boolean).join(" "), marked.missing, "ai", ms);
		}
		panel.remove();
		this.showFeedback(q, live, wrap);
	}

	private attemptFrom(
		q: Question, response: string, score: number, verdict: Attempt["verdict"],
		feedback: string, missing: string[], gradedBy: Attempt["gradedBy"], ms: number
	): Attempt {
		return {
			ts: new Date().toISOString(), sessionId: this.sessionId, bankId: this.bank!.id,
			questionId: q.id, tier: q.tier, type: q.type, topic: q.topic,
			response, score, verdict, feedback, missing, gradedBy, ms,
		};
	}

	private showFeedback(q: Question, live: LiveAnswer, wrap: HTMLElement, marking = false): HTMLElement {
		wrap.querySelector(".rl-actions")?.remove();
		wrap.querySelectorAll(".rl-answer input, .rl-answer textarea").forEach((el) => el.setAttr("disabled", "true"));

		const panel = wrap.createDiv({ cls: "rl-feedback" });
		if (marking) {
			panel.addClass("rl-fb-pending");
			const head = panel.createDiv({ cls: "rl-fb-head" });
			head.createDiv({ cls: "rl-spinner" });
			head.createSpan({ cls: "rl-fb-title", text: "Claude is marking this…" });
			if (q.expected) {
				const model = panel.createDiv({ cls: "rl-model" });
				model.createDiv({ cls: "rl-model-label", text: "Model answer" });
				void this.md(q.expected, model.createDiv());
			}
			return panel;
		}
		if (live.attempt) {
			const v = live.attempt.verdict;
			panel.addClass(`rl-fb-${v}`);
			const head = panel.createDiv({ cls: "rl-fb-head" });
			setIcon(head.createSpan({ cls: "rl-fb-icon" }), v === "correct" ? "check-circle" : v === "partial" ? "circle-slash" : "x-circle");
			head.createSpan({ cls: "rl-fb-title", text: v === "correct" ? "Correct" : v === "partial" ? "Partly right" : "Not right" });
			head.createSpan({ cls: "rl-fb-score", text: `${live.attempt.score}%` });
			if (live.attempt.feedback) void this.md(live.attempt.feedback, panel.createDiv({ cls: "rl-fb-body" }));
		}

		if (q.expected) {
			const model = panel.createDiv({ cls: "rl-model" });
			model.createDiv({ cls: "rl-model-label", text: "Model answer" });
			void this.md(q.expected, model.createDiv());
		}
		if (q.rubric?.length) {
			const r = panel.createDiv({ cls: "rl-model" });
			r.createDiv({ cls: "rl-model-label", text: "What full credit requires" });
			const ul = r.createEl("ul");
			for (const point of q.rubric) void this.md(point, ul.createEl("li"));
		}
		if (q.explain) void this.md(q.explain, panel.createDiv({ cls: "rl-explain" }));
		if (q.ref) {
			const link = panel.createEl("a", { cls: "rl-link", text: `Read it again → ${q.ref}` });
			link.onclick = (e) => { e.preventDefault(); void this.app.workspace.openLinkText(q.ref!, "", false); };
		}

		const next = panel.createDiv({ cls: "rl-actions" });
		const last = this.index === this.examQuestions.length - 1;
		new ButtonComponent(next).setButtonText(last ? "Finish" : "Next").setCta()
			.onClick(() => void this.advance()).buttonEl.focus();
		return panel;
	}

	private async advance(): Promise<void> {
		this.revealed = false;
		if (this.index === this.examQuestions.length - 1) { await this.finish(); return; }
		this.index += 1;
		this.questionStart = Date.now();
		await this.render();
	}

	// ================================================================ results

	private async finish(): Promise<void> {
		const graded = this.answers.filter((a) => a.attempt).map((a) => a.attempt!);
		const meanScore = graded.length ? Math.round(graded.reduce((s, a) => s + a.score, 0) / graded.length) : 0;

		const byTopic = new Map<string, number[]>();
		for (const a of graded) { const l = byTopic.get(a.topic) ?? []; l.push(a.score); byTopic.set(a.topic, l); }
		const weakTopics = [...byTopic.entries()]
			.map(([t, s]) => ({ t, m: s.reduce((x, y) => x + y, 0) / s.length }))
			.filter((e) => e.m < 80).sort((a, b) => a.m - b.m).map((e) => e.t);

		const summary: SessionSummary = {
			id: this.sessionId, ts: new Date().toISOString(),
			bankId: this.bank!.id, bankTitle: this.bank!.title, tier: "mixed",
			asked: this.answers.length, meanScore, grade: letterGrade(meanScore),
			weakTopics, coachingPending: true,
		};

		const course = await this.courseForBank(this.bank!);
		let axes: AxisScore[] = [];
		if (course) {
			const prior = await this.plugin.store.readProgress();
			axes = scoreAxes(course, Store.banksForCourse(course, this.banks), [...prior.attempts, ...graded]);
		}

		await this.plugin.store.recordSession(graded, summary);
		this.screen = "results";
		await this.render();

		// Fetch the coaching right away and drop it into the panel when it lands.
		void this.fetchCoaching(summary, axes);
	}

	private async fetchCoaching(summary: SessionSummary, axes: AxisScore[]): Promise<void> {
		const res = await this.plugin.tasks.coachSession({
			title: summary.bankTitle ?? summary.bankId,
			meanScore: summary.meanScore,
			grade: summary.grade,
			answers: this.answers.map((a) => ({
				topic: a.q.topic, question: a.q.prompt, yourAnswer: a.response,
				score: a.attempt?.score ?? -1, missed: a.attempt?.missing ?? [],
			})),
			axes: axes.map((a) => ({ label: a.axis.label, score: a.score })),
		});

		if (typeof res === "string") this.plugin.log.info("feedback received", { chars: res.length });
		else this.plugin.log.error("feedback failed", { error: res.error });
		const coaching = typeof res === "string" ? res : `Could not reach Claude for feedback: ${res.error}`;
		if (!(await this.plugin.store.saveCoaching(summary.id, coaching))) return;
		if (this.screen === "results" && this.sessionId === summary.id) await this.render();
	}

	private async courseForBank(bank: Bank): Promise<Course | null> {
		if (!this.courses.length) this.courses = await this.plugin.store.listCourses();
		const note = bank.note;
		if (!note) return null;
		return this.courses.find((c) => note === c.folder || note.startsWith(c.folder.replace(/\/+$/, "") + "/")) ?? null;
	}

	private async renderResults(main: HTMLElement): Promise<void> {
		const progress = await this.plugin.store.readProgress();
		const session = progress.sessions.find((x) => x.id === this.sessionId);
		const graded = this.answers.filter((a) => a.attempt).map((a) => a.attempt!);
		const meanScore = session?.meanScore ?? 0;

		const hero = main.createDiv({ cls: "rl-results" });
		hero.createDiv({ cls: "rl-result-grade", text: letterGrade(meanScore) });
		hero.createDiv({ cls: "rl-result-score", text: `${meanScore}%` });
		const byAi = graded.filter((a) => a.gradedBy === "ai").length;
		hero.createDiv({
			cls: "rl-result-sub",
			text: `${graded.length} question${graded.length === 1 ? "" : "s"}${byAi ? ` · ${byAi} marked by Claude` : ""}`,
		});

		this.renderCoaching(main, session);

		const wrong = graded.filter((a) => a.verdict !== "correct");
		if (wrong.length) {
			const list = main.createDiv({ cls: "rl-panel" });
			list.createEl("h3", { text: "Go back over these" });
			for (const a of wrong) {
				const q = this.examQuestions.find((x) => x.id === a.questionId);
				const row = list.createDiv({ cls: "rl-review-row" });
				row.createSpan({ cls: "rl-chip", text: a.topic });
				void this.md(q ? q.prompt.split("\n")[0] : a.questionId, row.createDiv({ cls: "rl-review-q" }));
				if (a.feedback) void this.md(a.feedback, row.createDiv({ cls: "rl-review-fb" }));
			}
		}

		const actions = main.createDiv({ cls: "rl-actions" });
		new ButtonComponent(actions).setButtonText("Back to overview").setCta()
			.onClick(() => { this.screen = "home"; void this.render(); });
		new ButtonComponent(actions).setButtonText("History")
			.onClick(() => { this.screen = "history"; void this.render(); });
	}

	/** Claude's feedback, shown here as soon as it lands. */
	private renderCoaching(main: HTMLElement, session: SessionSummary | undefined): void {
		const panel = main.createDiv({ cls: "rl-coaching" });
		panel.createDiv({ cls: "rl-model-label", text: "Feedback from Claude" });
		if (session?.coaching) {
			void this.md(session.coaching, panel.createDiv());
			return;
		}
		const row = panel.createDiv({ cls: "rl-fb-head" });
		row.createDiv({ cls: "rl-spinner" });
		row.createSpan({ text: "Reading back over your exam…" });
	}

	// =================================================================== lab

	private async renderLab(main: HTMLElement, lab: Lab): Promise<void> {
		const prog = await this.plugin.store.labProgress(lab.id);
		if (!prog.firstOpenedAt) {
			prog.firstOpenedAt = new Date().toISOString();
			await this.plugin.store.saveLabProgress(prog);
			this.plugin.log.info("lab opened", { lab: lab.id, tier: lab.tier, title: lab.title });
		}

		const head = main.createDiv({ cls: "rl-head" });
		const back = head.createEl("a", { cls: "rl-link", text: "← back" });
		back.onclick = (e) => { e.preventDefault(); this.screen = "folder"; this.openLab = null; void this.render(); };
		head.createEl("h2", { text: lab.title });
		head.createSpan({ cls: `rl-tier-badge rl-tier-${lab.tier}`, text: tierLabel(lab.tier) });

		if (prog.solvedAt) {
			const done = main.createDiv({ cls: "rl-lab-solved" });
			setIcon(done.createSpan(), "check-circle");
			done.createSpan({
				text: `Solved — ${labScore(prog)}%` +
					(prog.hintsUsed ? `, after ${prog.hintsUsed} hint${prog.hintsUsed === 1 ? "" : "s"}` : "") +
					(prog.attempts ? ` and ${prog.attempts} wrong flag${prog.attempts === 1 ? "" : "s"}` : ""),
			});
		}

        // Brief
		const briefPanel = main.createDiv({ cls: "rl-panel" });
		briefPanel.createEl("h3", { text: "The task" });
		await this.md(lab.brief, briefPanel.createDiv());
		if (lab.minutes) briefPanel.createDiv({ cls: "rl-muted", text: `Expect about ${lab.minutes} minutes.` });

		// The challenge itself, on screen. These labs are solvable by reading, so
		// making the learner go hunting on disk for the file was the wrong shape.
		for (const f of lab.files) {
			const panel = main.createDiv({ cls: "rl-panel rl-challenge" });
			const ph = panel.createDiv({ cls: "rl-panel-head" });
			ph.createEl("h3", { text: f.path });
			const copy = new ButtonComponent(ph).setButtonText("Copy");
			copy.onClick(async () => {
				await navigator.clipboard.writeText(f.content);
				copy.setButtonText("Copied");
				window.setTimeout(() => copy.setButtonText("Copy"), 1500);
			});
			const pre = panel.createEl("pre", { cls: "rl-code rl-challenge-code" });
			pre.createEl("code", { text: f.content });
		}

		// Optional: put it on disk, for anyone who wants to compile or run it.
		const wsPanel = main.createDiv({ cls: "rl-panel" });
		const wsHead = wsPanel.createDiv({ cls: "rl-panel-head" });
		wsHead.createEl("h3", { text: "Optional: work on it locally" });
		const onDisk = this.plugin.labs.exists(lab);
		wsPanel.createDiv({
			cls: "rl-muted",
			text: "You do not need this — the challenge above can be solved by reading. Write the file out only if you want to compile or run it yourself.",
		});
		wsPanel.createEl("pre", { cls: "rl-code" }).createEl("code", { text: this.plugin.labs.dir(lab) });
		if (lab.setup.trim()) {
			const setup = wsPanel.createDiv({ cls: "rl-model" });
			setup.createDiv({ cls: "rl-model-label", text: "Then, if you want to run it" });
			setup.createEl("pre", { cls: "rl-code" }).createEl("code", { text: lab.setup.trim() });
		}
		new ButtonComponent(wsPanel.createDiv({ cls: "rl-actions" }))
			.setButtonText(onDisk ? "Re-write the file" : "Write the file to disk")
			.onClick(() => {
				try {
					const where = this.plugin.labs.materialise(lab);
					this.plugin.log.info("lab workspace written", { lab: lab.id, dir: where, files: lab.files.length });
					new Notice(`Written to ${where}`, 9000);
					void this.render();
				} catch (e) {
					this.plugin.log.error("lab setup failed", { lab: lab.id, error: String(e) });
					new Notice(`Could not write the file: ${String(e)}`, 12000);
				}
			});

		// Flag
		const flagPanel = main.createDiv({ cls: "rl-panel" });
		flagPanel.createEl("h3", { text: "Submit the flag" });
		const input = flagPanel.createEl("input", {
			type: "text", cls: "rl-text rl-mono",
			attr: { placeholder: lab.flagFormat, spellcheck: "false" },
		});
		const verdict = flagPanel.createDiv();
		const submit = async () => {
			const value = input.value;
			if (!value.trim()) return;
			if (checkFlag(lab, value)) {
				prog.solvedAt = prog.solvedAt ?? new Date().toISOString();
				await this.plugin.store.saveLabProgress(prog);
				this.plugin.log.info("lab solved", { lab: lab.id, attempts: prog.attempts, hints: prog.hintsUsed });
				await this.render();
			} else {
				prog.attempts += 1;
				await this.plugin.store.saveLabProgress(prog);
				this.plugin.log.info("wrong flag", { lab: lab.id, attempts: prog.attempts, submitted: value.slice(0, 60) });
				verdict.empty();
				verdict.addClass("rl-flag-wrong");
				verdict.setText(`Not the flag. ${prog.attempts} wrong so far.`);
				input.addClass("rl-shake");
				window.setTimeout(() => input.removeClass("rl-shake"), 500);
			}
		};
		input.onkeydown = (e) => { if (e.key === "Enter") void submit(); };
		const fa = flagPanel.createDiv({ cls: "rl-actions" });
		new ButtonComponent(fa).setButtonText("Check").setCta().onClick(() => void submit());
		if (prog.solvedAt) input.value = "(solved)";
		if (prog.solvedAt) input.setAttr("disabled", "true");

		// Hints, one at a time
		if (lab.hints.length) {
			const hintPanel = main.createDiv({ cls: "rl-panel" });
			hintPanel.createEl("h3", { text: "Hints" });
			hintPanel.createDiv({ cls: "rl-muted", text: "Each hint costs 15% of the lab's score." });
			for (let i = 0; i < Math.min(prog.hintsUsed, lab.hints.length); i++) {
				const h = hintPanel.createDiv({ cls: "rl-hint-shown" });
				h.createSpan({ cls: "rl-chip", text: `Hint ${i + 1}` });
				void this.md(lab.hints[i], h.createDiv());
			}
            if (prog.hintsUsed < lab.hints.length && !prog.solvedAt) {
				new ButtonComponent(hintPanel.createDiv({ cls: "rl-actions" }))
					.setButtonText(`Reveal hint ${prog.hintsUsed + 1} of ${lab.hints.length}`)
					.onClick(async () => {
						prog.hintsUsed += 1;
						await this.plugin.store.saveLabProgress(prog);
						this.plugin.log.info("hint revealed", { lab: lab.id, hint: prog.hintsUsed });
						await this.render();
					});
			}
		}

		// Solution, only once it can no longer be cheated with
		if (prog.solvedAt || prog.gaveUpAt) {
			const sol = main.createDiv({ cls: "rl-panel" });
			sol.createEl("h3", { text: "How it was meant to go" });
			await this.md(lab.solution, sol.createDiv());
		} else {
			new ButtonComponent(main.createDiv({ cls: "rl-actions" }))
				.setButtonText("Give up and show the solution")
				.setWarning()
				.onClick(async () => {
					prog.gaveUpAt = new Date().toISOString();
					await this.plugin.store.saveLabProgress(prog);
					this.plugin.log.info("lab given up", { lab: lab.id, attempts: prog.attempts, hints: prog.hintsUsed });
					await this.render();
				});
		}
	}

	// ================================================================ history

	private async renderHistory(main: HTMLElement): Promise<void> {
		const progress = await this.plugin.store.readProgress();
		const head = main.createDiv({ cls: "rl-head" });
		head.createEl("h2", { text: "History" });
		this.renderClaudeStatus(head);

		if (!progress.sessions.length) {
			main.createDiv({ cls: "rl-empty", text: "No exams taken yet." });
			return;
		}

		const stats = main.createDiv({ cls: "rl-statgrid" });
		const stat = (label: string, value: string) => {
			const s = stats.createDiv({ cls: "rl-stat" });
			s.createDiv({ cls: "rl-stat-value", text: value });
			s.createDiv({ cls: "rl-stat-label", text: label });
		};
		const mean = Math.round(progress.sessions.reduce((s, x) => s + x.meanScore, 0) / progress.sessions.length);
		stat("Exams taken", String(progress.sessions.length));
		stat("Questions answered", String(progress.attempts.length));
		stat("Mean score", `${mean}%`);
		stat("Notes completed", String(Object.keys(progress.completed ?? {}).length));

		// Weakest topics across everything.
		const byTopic = new Map<string, number[]>();
		for (const a of progress.attempts) { const l = byTopic.get(a.topic) ?? []; l.push(a.score); byTopic.set(a.topic, l); }
		const weak = [...byTopic.entries()]
			.map(([topic, s]) => ({ topic, score: Math.round(s.reduce((x, y) => x + y, 0) / s.length), n: s.length }))
			.sort((a, b) => a.score - b.score).slice(0, 10);
		if (weak.length) {
			const panel = main.createDiv({ cls: "rl-panel" });
			panel.createEl("h3", { text: "Areas for improvement" });
			for (const w of weak) {
				const row = panel.createDiv({ cls: "rl-bar-row" });
				row.createSpan({ cls: "rl-bar-label", text: w.topic });
				const track = row.createDiv({ cls: "rl-progress" });
				const fill = track.createDiv({ cls: "rl-progress-fill" });
				fill.setCssProps({ "--rl-fill": `${w.score}%` });
				if (w.score < 50) fill.addClass("rl-fill-bad");
				else if (w.score < 80) fill.addClass("rl-fill-mid");
				row.createSpan({ cls: "rl-bar-value", text: `${w.score}% · ${w.n}` });
			}
		}

		const panel = main.createDiv({ cls: "rl-panel" });
		panel.createEl("h3", { text: "Every exam" });
		for (const s of progress.sessions.slice().reverse()) {
			const row = panel.createDiv({ cls: "rl-session" });
			const top = row.createDiv({ cls: "rl-session-top" });
			top.createSpan({ cls: "rl-session-grade", text: s.grade });
			const mid = top.createDiv({ cls: "rl-session-mid" });
			mid.createDiv({ cls: "rl-session-title", text: s.bankTitle ?? s.bankId });
			mid.createDiv({ cls: "rl-session-meta", text: `${new Date(s.ts).toLocaleString()} · ${s.asked} questions · ${s.meanScore}%` });
			if (s.coaching) {
				const toggle = top.createEl("a", { cls: "rl-link", text: "Feedback" });
				const body = row.createDiv({ cls: "rl-session-coaching rl-collapsed" });
				void this.md(s.coaching, body);
				toggle.onclick = (e) => { e.preventDefault(); body.toggleClass("rl-collapsed", !body.hasClass("rl-collapsed")); };
			} else if (s.coachingPending) {
				top.createSpan({ cls: "rl-chip rl-chip-dim", text: "feedback pending" });
			}
			if (s.weakTopics.length) {
				const chips = row.createDiv({ cls: "rl-session-chips" });
				for (const t of s.weakTopics.slice(0, 6)) chips.createSpan({ cls: "rl-chip", text: t });
			}
		}
	}

	private async md(source: string, el: HTMLElement): Promise<void> {
		await MarkdownRenderer.render(this.app, source, el, "", this as unknown as Component);
	}
}

/** A plain yes/no dialog, used before anything slow, costly or destructive. */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private body: string,
		private confirmText: string,
		private onConfirm: () => void,
		/** Listed under the body, e.g. the files about to be removed. */
		private items: string[] = []
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h3", { text: this.title });
		this.contentEl.createEl("p", { text: this.body });
		if (this.items.length) {
			const list = this.contentEl.createEl("ul", { cls: "rl-confirm-list" });
			for (const item of this.items) list.createEl("li", { text: item });
		}
		const row = this.contentEl.createDiv({ cls: "rl-actions" });
		new ButtonComponent(row).setButtonText(this.confirmText).setCta()
			.onClick(() => { this.close(); this.onConfirm(); });
		new ButtonComponent(row).setButtonText("Cancel").onClick(() => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function tierLabel(t: Tier): string {
	return t === "easy" ? "Easy" : t === "hard" ? "Hard" : "Brutal";
}

function describeChoice(q: Question, chosen: number[]): string {
	if (!q.choices) return "";
	return chosen.map((i) => q.choices![i]).join(" | ");
}

function clamp(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, Math.round(n)));
}
