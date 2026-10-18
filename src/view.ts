import { App, ButtonComponent, Component, ItemView, MarkdownRenderer, Modal, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import type RecallLabPlugin from "./main";
import { Store } from "./store";
import { clozeBlanks, clozePieces, gradeLocally, sameValue } from "./grader";
import { shuffled } from "./util";
import { QuestionScore, renderRadar, scoreAxes, scoreCourses, weakestTested, untested, withBefore, AxisScore } from "./radar";
import {
	Attempt, Bank, Confidence, Course, ExamItem, Lab, LabProgress, ProgressFile, Question, SessionSummary, Tier,
	idOf, labScore, letterGrade, qkey,
} from "./types";
import { AnswerIndex, calibration } from "./history";
import {
	DayRecord, Memory, ReviewPlan, counts, describeAgo, describeWhen, endOfDay, expectedScore, keysOf, planReview, settledRecord,
	startOfDay, streakOf,
} from "./memory";
import { keyAction } from "./keys";
import { RecallStage, optionsHidden, recallApplies } from "./recall";
import {
	AnswerState, answeredTo, blankSize, describeResponse, notReady, plain, questionDetail, questionLine, scrambled,
} from "./answers";
import { needingVariants, withVariants } from "./variants";
import { findLeeches } from "./leeches";
import { needingSteps, needsGuidance } from "./guided";
import { SECOND_TRY_CAP, combineTries } from "./tasks";
import { checkFlag } from "./labs";
import { INSTALL_HINT } from "./claude";

// Rough per-quiz figures for the bulk-generation dialog. Illustrative only:
// they drift with the model, the note's length and plan pricing, which is why
// the dialog says "about" and "roughly".
const SECONDS_PER_QUIZ = 50;
const USD_PER_QUIZ = 0.13;

export const VIEW_TYPE_RECALL = "recall-lab-view";

type Screen = "home" | "folder" | "exam" | "results" | "history" | "lab" | "clinic";


interface LiveAnswer {
	q: Question;
	/** The bank the question came from, which a course exam mixes. */
	bankId: string;
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
	/** Fill-in-the-blank questions made from each course note's ==highlights==. */
	private highlightBanks: Bank[] = [];
	private openLab: Lab | null = null;

	/** The paper being sat: a note's bank, a course's banks merged, or a review. */
	private bank: Bank | null = null;
	private examItems: ExamItem[] = [];
	/** A review is spaced practice: it stays offline unless you ask for feedback. */
	private sessionKind: "exam" | "review" = "exam";
	/** Sessions whose on-demand feedback has been asked for and not yet landed. */
	private coachingInFlight = new Set<string>();
	/** The leech clinic's question on screen, by key. */
	private clinicKey: string | null = null;
	/** Which guided step of the question on screen is showing. */
	private guideStage: { index: number; step: number } | null = null;
	/** Ends a second try that is waiting on you, as "show the answer". */
	private settleSecondTry: (() => void) | null = null;
	/** Recall-first state for the question on screen. */
	private recallStage: RecallStage | null = null;
	/** What the keyboard can do to the question on screen. */
	private examKeys: {
		choose(slot: number): void;
		submit(confidence: Confidence): void;
		skip?(): void;
		next?(): void;
		focus(): void;
	} | null = null;
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
		// Focusable, so a click on plain text in the view keeps focus here and
		// the exam's shortcuts keep working; otherwise focus falls to <body>.
		this.contentEl.tabIndex = -1;
		this.registerDomEvent(this.containerEl, "keydown", (e) => this.onKey(e));
		await this.render();
	}

	/** Keyboard shortcuts on the exam screen; see keyAction for the map. */
	private onKey(e: KeyboardEvent): void {
		const keys = this.examKeys;
		if (this.screen !== "exam" || !keys) return;
		// Tag names, not instanceof: a popout window has its own element
		// classes, so instanceof HTMLTextAreaElement is false for a text box
		// there, and typing "s" would submit the answer. A dropdown takes
		// letters and digits to jump between its options.
		const target = e.target as HTMLElement | null;
		const tag = target?.tagName ?? "";
		const typing = tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true ||
			(tag === "INPUT" && !["radio", "checkbox", "button", "file"].includes((target as HTMLInputElement).type));
		const action = keyAction({
			key: e.key,
			mod: Platform.isMacOS ? e.metaKey : e.ctrlKey,
			otherMod: Platform.isMacOS ? e.ctrlKey : e.metaKey,
			alt: e.altKey,
			typing,
			onButton: tag === "BUTTON",
			answered: this.revealed,
		});
		if (!action) return;
		e.preventDefault();
		if (action.do === "choose") keys.choose(action.slot);
		else if (action.do === "submit") keys.submit(action.confidence);
		else if (action.do === "skip") keys.skip?.();
		else if (action.do === "next") keys.next?.();
		else {
			target?.blur?.();
			keys.focus();
		}
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
		this.highlightBanks = this.plugin.settings.highlightClozes
			? await this.plugin.store.listHighlightBanks(this.courses)
			: [];
	}

	/** The highlight questions of the notes under a folder. */
	private highlightsIn(folder: string): Bank[] {
		const prefix = folder.replace(/\/+$/, "") + "/";
		return this.highlightBanks.filter((b) => b.note?.startsWith(prefix));
	}

	/** Every bank, highlight questions included: the scope of the daily review. */
	private get everyBank(): Bank[] {
		return [...this.banks, ...this.highlightBanks];
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
		this.examKeys = null;

		const shell = root.createDiv({ cls: "rl-shell" });
		const side = shell.createDiv({ cls: "rl-side" });
		const main = shell.createDiv({ cls: "rl-main" });

		await this.refresh();
		await this.renderSidebar(side);

		if (this.screen === "lab" && this.openLab) await this.renderLab(main, this.openLab);
		else if (this.screen === "results") await this.renderResults(main);
		else if (this.screen === "history") await this.renderHistory(main);
		else if (this.screen === "clinic" && this.clinicKey) await this.renderClinic(main, this.clinicKey);
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

		await this.renderReviewPanel(main, this.everyBank);
		this.renderClinicPanel(main, progress);

		// The central radar: one spoke per course, across the whole vault.
		const expected = this.expectedScores(progress.attempts);
		const banksFor = (c: Course) => Store.banksForCourse(c, this.banks);
		const scores = withBefore(
			scoreCourses(this.courses, banksFor, expected.now),
			scoreCourses(this.courses, banksFor, expected.weekAgo)
		);
		const overall = scores.length ? Math.round(scores.reduce((s, a) => s + a.score, 0) / scores.length) : 0;

		const panel = main.createDiv({ cls: "rl-panel rl-panel-hero" });
		const ph = panel.createDiv({ cls: "rl-panel-head" });
		ph.createEl("h3", { text: "Across the whole vault" });
		ph.createSpan({ cls: "rl-grade-pill", text: `${overall}% · ${letterGrade(overall)}` });
		if (scores.length >= 3) {
			renderRadar(panel.createDiv({ cls: "rl-radar-wrap" }), scores);
			this.renderRadarCaption(panel);
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
			const inner = scoreAxes(course, courseBanks, expected.now);
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

	/** Radar scores: what you would expect to score if asked now, and a week ago. */
	private expectedScores(attempts: Attempt[]): { now: QuestionScore; weekAgo: QuestionScore } {
		const retention = this.plugin.settings.targetRecall / 100;
		const now = new Date();
		return {
			now: expectedScore(attempts, retention, now),
			weekAgo: expectedScore(attempts, retention, new Date(now.getTime() - 7 * 86_400_000)),
		};
	}

	private renderRadarCaption(panel: HTMLElement): void {
		panel.createDiv({
			cls: "rl-radar-caption",
			text: "Each spoke is the score you would expect if asked right now: how well you have answered, " +
				"times how likely you still remember. It fades between reviews. Dashed: a week ago.",
		});
	}

	/** Today's review over these banks, with every question's memory state. */
	private async planFor(banks: Bank[]): Promise<{ plan: ReviewPlan; memory: Memory; keys: Set<string>; progress: ProgressFile }> {
		const progress = await this.plugin.store.readProgress();
		const memory = new Memory(progress.attempts, this.plugin.settings.targetRecall / 100);
		const noteOf = new Map(this.everyBank.map((b) => [b.id, b.note]));
		const items = Store.itemsOf(banks);
		const plan = planReview({
			items,
			memory,
			now: new Date(),
			newPerDay: this.plugin.settings.newPerDay,
			completed: progress.completed ?? {},
			noteOf: (id) => noteOf.get(id),
		});
		return { plan, memory, keys: keysOf(items), progress };
	}

	/** What is due today, and the button that starts the review. */
	private async renderReviewPanel(main: HTMLElement, banks: Bank[], course?: Course): Promise<void> {
		const { plan, memory, keys, progress } = await this.planFor(banks);
		const now = new Date();
		const panel = main.createDiv({ cls: "rl-panel rl-review-panel" });
		const head = panel.createDiv({ cls: "rl-panel-head" });
		head.createEl("h3", { text: course ? "Review this course" : "Today's review" });

		// The streak is vault-wide, so only the overview shows it.
		const streak = course ? null : streakOf(await this.dayRecord(progress, now));
		if (streak?.current) head.createSpan({ cls: "rl-streak", text: `🔥 ${streak.current}-day streak` });

		const total = plan.due.length + plan.fresh.length;
		if (total) {
			head.createSpan({ cls: "rl-grade-pill", text: `${plan.due.length} due · ${plan.fresh.length} new` });
			panel.createDiv({
				cls: "rl-muted",
				text: "Questions you are closest to forgetting come first, then new ones. Stop whenever you like: every answer is saved as you go.",
			});
			if (streak && !streak.today && plan.due.length) {
				panel.createDiv({
					cls: "rl-muted",
					text: streak.current
						? `Clear today's ${plan.due.length} due to make it ${streak.current + 1} days.`
						: `Clear today's ${plan.due.length} due to start a streak.`,
				});
			}
			new ButtonComponent(panel.createDiv({ cls: "rl-actions" }))
				.setButtonText(`Start review (${total})`)
				.setCta()
				.onClick(() => void this.startReview(course));
		} else {
			const next = memory.nextDue(endOfDay(now), keys);
			panel.createDiv({
				cls: "rl-muted",
				text: next
					? `All caught up. The next question is due ${describeWhen(next, now)}.`
					: "Nothing to review yet. Take an exam or mark a note complete, and its questions join your reviews.",
			});
		}
		const ahead = memory.forecast(now, 8, keys);
		const week = ahead.slice(1).reduce((a, b) => a + b, 0);
		if (week) {
			panel.createDiv({ cls: "rl-muted", text: `Coming up: ${ahead[1]} tomorrow, ${week} over the next 7 days.` });
		}
	}

	/** Opens the leech clinic on one question. */
	async openClinic(key: string): Promise<void> {
		await this.refresh();
		this.clinicKey = key;
		this.screen = "clinic";
		await this.render();
	}

	/** The note a bank drills, highlight banks included. */
	private noteOfBank(bankId: string): string | undefined {
		return this.everyBank.find((b) => b.id === bankId)?.note;
	}

	/**
	 * Questions you keep missing, with a way to find out why. Diagnosing uses
	 * Claude, so each is a button that says so.
	 */
	private renderClinicPanel(main: HTMLElement, progress: ProgressFile): void {
		const leeches = findLeeches(this.everyBank, new AnswerIndex(progress.attempts), this.plugin.settings.leechThreshold);
		if (!leeches.length) return;
		const panel = main.createDiv({ cls: "rl-panel" });
		const head = panel.createDiv({ cls: "rl-panel-head" });
		head.createEl("h3", { text: "Leech clinic" });
		head.createSpan({ cls: "rl-grade-pill", text: String(leeches.length) });
		panel.createDiv({
			cls: "rl-muted",
			text: "Questions you keep missing are usually a misunderstanding, not forgetting, and more reviews will " +
				"not fix them. Claude can read your wrong answers and name it.",
		});
		for (const leech of leeches.slice(0, 5)) {
			const row = panel.createDiv({ cls: "rl-review-row" });
			row.createSpan({ cls: "rl-chip", text: `missed ${leech.misses}×` });
			void this.md(questionLine(leech.item.q), row.createDiv({ cls: "rl-review-q" }));
			const actions = row.createDiv({ cls: "rl-actions" });
			if (progress.clinic?.[leech.key]) {
				new ButtonComponent(actions).setButtonText("Open diagnosis").setCta()
					.onClick(() => void this.openClinic(leech.key));
			} else {
				new ButtonComponent(actions).setButtonText("Diagnose (uses Claude)")
					.onClick(() => void this.plugin.diagnoseLeech(leech, this.noteOfBank(leech.item.bankId)));
			}
		}
		if (leeches.length > 5) panel.createDiv({ cls: "rl-muted", text: `And ${leeches.length - 5} more.` });
	}

	/** One leech: the question, what is going wrong, a three-step fix, and a fresh question to try. */
	private async renderClinic(main: HTMLElement, key: string): Promise<void> {
		const progress = await this.plugin.store.readProgress();
		const diagnosis = progress.clinic?.[key];
		const item = Store.itemsOf(this.everyBank).find((it) => qkey(it.bankId, it.q.id) === key);

		const head = main.createDiv({ cls: "rl-head" });
		const back = head.createEl("a", { cls: "rl-link", text: "← back" });
		back.onclick = (e) => { e.preventDefault(); this.screen = "home"; this.clinicKey = null; void this.render(); };
		head.createEl("h2", { text: "Leech clinic" });
		if (!item || !diagnosis) {
			main.createDiv({ cls: "rl-empty", text: "That question, or its diagnosis, is no longer here." });
			return;
		}

		const q = item.q;
		const wrong = new AnswerIndex(progress.attempts).attempts(item.bankId, q.id).filter((a) => a.verdict === "incorrect");
		const question = main.createDiv({ cls: "rl-panel" });
		question.createEl("h3", { text: `The question you have missed ${wrong.length} times` });
		await this.md(q.prompt, question.createDiv());
		if (q.code) question.createEl("pre", { cls: "rl-code" }).createEl("code", { text: q.code });
		const detail = questionDetail(q);
		if (detail) await this.md(detail, question.createDiv());
		if (wrong.length) {
			const recent = question.createDiv({ cls: "rl-model" });
			recent.createDiv({ cls: "rl-model-label", text: "Your most recent wrong answers" });
			const ul = recent.createEl("ul");
			const to = { variant: " (to a variant of it)", practice: " (to the practice question)" };
			for (const a of wrong.slice(-3)) {
				const whose = answeredTo(a);
				ul.createEl("li", { text: `${a.response || "(blank)"}${whose ? to[whose] : ""}` });
			}
		}

		const what = main.createDiv({ cls: "rl-panel rl-panel-confident" });
		what.createEl("h3", { text: "What is going wrong" });
		await this.md(diagnosis.misconception, what.createDiv());

		const lesson = main.createDiv({ cls: "rl-panel" });
		lesson.createEl("h3", { text: `Put it right in ${diagnosis.lesson.length} steps` });
		const ol = lesson.createEl("ol", { cls: "rl-lesson" });
		for (const step of diagnosis.lesson) await this.md(step, ol.createEl("li"));

		const actions = main.createDiv({ cls: "rl-actions" });
		new ButtonComponent(actions).setButtonText("Try a fresh question").setCta().onClick(() =>
			void this.launch(
				{ id: `clinic:${key}`, title: "Leech clinic", questions: [] },
				[{ bankId: item.bankId, q: diagnosis.question, of: q.id }],
				"review"
			)
		);
		new ButtonComponent(actions).setButtonText("Diagnose again (uses Claude)").onClick(() =>
			void this.plugin.diagnoseLeech({ item, key, misses: wrong.length, wrong: wrong.slice(-6) }, this.noteOfBank(item.bankId))
		);
		main.createDiv({
			cls: "rl-muted",
			text: `Diagnosed ${describeAgo(new Date(diagnosis.at), new Date())}. Your answer to the fresh question counts ` +
				"toward the original's review schedule.",
		});
	}

	/**
	 * Offers variants for the course's mature questions. Writing them uses
	 * Claude, so it is a button behind a confirmation, never automatic.
	 */
	private renderVariantsPanel(main: HTMLElement, banks: Bank[], attempts: Attempt[]): void {
		const needing = needingVariants(banks, new AnswerIndex(attempts));
		const n = needing.reduce((s, b) => s + b.questions.length, 0);
		if (!n) return;
		const panel = main.createDiv({ cls: "rl-panel" });
		panel.createEl("h3", { text: "Variants" });
		panel.createDiv({
			cls: "rl-muted",
			text: `${n} question${n === 1 ? " has" : "s have"} been answered right twice running, so ${n === 1 ? "its" : "their"} ` +
				"look may be carrying the answer. A variant tests the same idea dressed differently; reviews then ask it instead.",
		});
		new ButtonComponent(panel.createDiv({ cls: "rl-actions" }))
			.setButtonText(`Write variants for ${n}…`)
			.onClick(() => {
				new ConfirmModal(
					this.app,
					`Write variants for ${n} question${n === 1 ? "" : "s"}?`,
					`Claude writes two variants of each, one request per quiz (${needing.length}). This uses your Claude plan.`,
					"Write variants",
					() => void this.plugin.buildExtras("variants", needing)
				).open();
			});
	}

	/** Offers guided steps for the course's brutal problems; writing them uses Claude, so it asks first. */
	private renderStepsPanel(main: HTMLElement, banks: Bank[]): void {
		if (!this.plugin.settings.guidedSteps) return;
		const needing = needingSteps(banks);
		const n = needing.reduce((s, b) => s + b.questions.length, 0);
		if (!n) return;
		const panel = main.createDiv({ cls: "rl-panel" });
		panel.createEl("h3", { text: "Guided steps" });
		panel.createDiv({
			cls: "rl-muted",
			text: `${n} brutal problem${n === 1 ? " has" : "s have"} no guided steps. With steps, a problem that is new to ` +
				"you or that you missed last time is walked through 3 to 5 smaller questions, each checked at once, " +
				"before you answer it whole.",
		});
		new ButtonComponent(panel.createDiv({ cls: "rl-actions" }))
			.setButtonText(`Write guided steps for ${n}…`)
			.onClick(() => {
				new ConfirmModal(
					this.app,
					`Write guided steps for ${n} problem${n === 1 ? "" : "s"}?`,
					`Claude breaks each into 3 to 5 smaller steps, one request per quiz (${needing.length}). This uses your Claude plan.`,
					"Write steps",
					() => void this.plugin.buildExtras("steps", needing)
				).open();
			});
	}

	/** Starts today's review: across every course, or one course. */
	async startReview(course?: Course): Promise<void> {
		await this.refresh();
		await this.review(
			course ? [...Store.banksForCourse(course, this.banks), ...this.highlightsIn(course.folder)] : this.everyBank,
			course ? `review:${course.id}` : "review",
			course ? `Review · ${course.title}` : "Daily review"
		);
	}

	/**
	 * Reviews what is due in one note. New questions are left to the daily
	 * review: from here they would spend the whole vault's allowance on one note.
	 */
	async startNoteReview(path: string): Promise<void> {
		await this.refresh();
		const name = path.split("/").pop()!.replace(/\.md$/, "");
		await this.review(this.everyBank.filter((b) => b.note === path), `review:${path}`, `Review · ${name}`, true);
	}

	private async review(banks: Bank[], id: string, title: string, dueOnly = false): Promise<void> {
		const { plan, memory, keys, progress } = await this.planFor(banks);
		// A mature question comes back as its next variant, if it has any.
		const items = withVariants(dueOnly ? plan.due : [...plan.due, ...plan.fresh], new AnswerIndex(progress.attempts));
		if (!items.length) {
			const now = new Date();
			const next = memory.nextDue(endOfDay(now), keys);
			new Notice(next ? `Nothing to review. The next question is due ${describeWhen(next, now)}.` : "Nothing to review yet.");
			return;
		}
		await this.launch({ id, title, questions: [] }, items, "review");
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
		const expected = this.expectedScores(progress.attempts);
		const scores = withBefore(
			scoreAxes(course, courseBanks, expected.now),
			scoreAxes(course, courseBanks, expected.weekAgo)
		);
		const tested = scores.filter((a) => a.total > 0 && a.seen > 0);
		const overall = tested.length ? Math.round(tested.reduce((s, a) => s + a.score, 0) / tested.length) : 0;

		// This course's own radar.
		const panel = main.createDiv({ cls: "rl-panel rl-panel-hero" });
		const ph = panel.createDiv({ cls: "rl-panel-head" });
		ph.createEl("h3", { text: "Skill radar" });
		ph.createSpan({ cls: "rl-grade-pill", text: `${overall}% · ${letterGrade(overall)}` });
		renderRadar(panel.createDiv({ cls: "rl-radar-wrap" }), scores);
		this.renderRadarCaption(panel);
		this.renderLegend(panel, scores);
		const weakest = weakestTested(scores);
		const notYet = untested(scores);
		if (weakest) {
			panel.createDiv({
				cls: "rl-radar-note",
				text: `Weakest right now: ${weakest.axis.label} at ${weakest.score}%. That is where to practise next.`,
			});
		}
		if (notYet.length) {
			panel.createDiv({
				cls: "rl-radar-note",
				text: `Not tested yet: ${notYet.map((a) => a.axis.label).join(", ")} — these read zero because they have not come up, not because you got them wrong.`,
			});
		}

		const reviewable = [...courseBanks, ...this.highlightsIn(folder)];
		if (reviewable.length) await this.renderReviewPanel(main, reviewable, course);
		this.renderVariantsPanel(main, courseBanks, progress.attempts);
		this.renderStepsPanel(main, courseBanks);

		// Course-wide exam.
		const examPanel = main.createDiv({ cls: "rl-panel" });
		examPanel.createEl("h3", { text: "Course exam" });
		const allQ = courseBanks.reduce((n, b) => n + b.questions.length, 0);
		const highlighted = this.highlightsIn(folder).reduce((n, b) => n + b.questions.length, 0);
		examPanel.createDiv({ cls: "rl-muted", text: `One paper that ramps from recall to application to synthesis, drawn across all ${courseBanks.length} quiz${courseBanks.length === 1 ? "" : "zes"} (${allQ} questions${highlighted ? `, and ${highlighted} from your highlights` : ""}).` });
		const ea = examPanel.createDiv({ cls: "rl-actions" });
		if (courseBanks.length) {
			new ButtonComponent(ea).setButtonText(`Start exam (${this.plugin.settings.defaultLength})`).setCta()
				.onClick(() => void this.beginCourseExam(course, courseBanks, this.plugin.settings.defaultLength));
			new ButtonComponent(ea).setButtonText("Full exam (everything)")
				.onClick(() => void this.beginCourseExam(course, courseBanks, "all"));
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

			const highlights = this.highlightBanks.find((b) => b.note === path)?.questions.length ?? 0;
			if (highlights) {
				name.createSpan({ cls: "rl-chip rl-chip-dim", text: `${highlights} highlight${highlights === 1 ? "" : "s"}` });
			}

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

	private async beginCourseExam(course: Course, banks: Bank[], total: number | "all"): Promise<void> {
		const progress = await this.plugin.store.readProgress();
		// One virtual paper across the course. Each question keeps its own bank,
		// so its answer is recorded against that bank, not the paper.
		const merged: Bank = {
			id: `course:${course.id}`,
			title: course.title,
			note: course.folder,
			questions: [],
		};
		const items = Store.itemsOf([...banks, ...this.highlightsIn(course.folder)]);
		const picked = total === "all" || total >= items.length
			? Store.fullExam(items)
			: Store.pickExam(items, new AnswerIndex(progress.attempts), total);
		await this.launch(merged, picked);
	}

	private async beginExam(bank: Bank, full: boolean): Promise<void> {
		const progress = await this.plugin.store.readProgress();
		const items = Store.itemsOf([bank, ...this.highlightBanks.filter((b) => b.note && b.note === bank.note)]);
		const picked = full
			? Store.fullExam(items)
			: Store.pickExam(items, new AnswerIndex(progress.attempts), Math.min(this.plugin.settings.defaultLength, items.length));
		await this.launch(bank, picked);
	}

	private async launch(bank: Bank, picked: ExamItem[], kind: "exam" | "review" = "exam"): Promise<void> {
		if (!picked.length) { new Notice("Recall Lab: that quiz has no questions."); return; }
		// A problem with guided steps is walked through them when it is new to
		// you or was missed last time; otherwise it is asked unaided.
		if (this.plugin.settings.guidedSteps && picked.some((it) => it.q.steps?.length)) {
			const index = new AnswerIndex((await this.plugin.store.readProgress()).attempts);
			picked = picked.map((it) => (needsGuidance(it.q, index.attempts(it.bankId, idOf(it))) ? { ...it, guided: true } : it));
		}
		this.bank = bank;
		this.examItems = picked;
		this.sessionKind = kind;
		this.recallStage = null;
		this.guideStage = null;
		this.index = 0;
		this.answers = [];
		this.sessionId = `s-${Date.now().toString(36)}`;
		this.screen = "exam";
		this.revealed = false;
		this.questionStart = Date.now();
		await this.render();
	}

	private async renderExam(root: HTMLElement): Promise<void> {
		this.examKeys = null;
		const item = this.examItems[this.index];
		if (!item || !this.bank) { this.screen = "home"; await this.render(); return; }
		const q = item.q;

		const wrap = root.createDiv({ cls: "rl-exam" });
		const bar = wrap.createDiv({ cls: "rl-sessionbar" });
		bar.createSpan({ cls: "rl-crumb", text: this.bank.title });
		bar.createSpan({ cls: `rl-tier-badge rl-tier-${q.tier}`, text: tierLabel(q.tier) });
		bar.createSpan({ cls: "rl-count", text: `${this.index + 1} / ${this.examItems.length}` });
		const recallOn = this.plugin.settings.recallFirst;
		const hidden = optionsHidden(recallOn, q.type, this.recallStage, this.index);
		/** What is typed in the recall box, while it shows. */
		let recallText = () => "";
		if (recallApplies(true, q.type)) {
			const label = () => `Recall first: ${this.plugin.settings.recallFirst ? "on" : "off"}`;
			const toggle = bar.createEl("a", { cls: "rl-link", text: label() });
			toggle.setAttr("aria-label", "Hide the options until you have tried to recall the answer");
			toggle.onclick = async (e) => {
				e.preventDefault();
				if (this.revealed) return;
				this.plugin.settings.recallFirst = !this.plugin.settings.recallFirst;
				await this.plugin.saveSettings();
				// Turned off mid-recall, the options show and what was typed
				// stays. With the options already out, a redraw would drop the
				// pick, so the change starts with the next question.
				if (hidden) await this.showOptions(recallText());
				else toggle.setText(label());
			};
		}
		const quit = bar.createEl("a", { cls: "rl-link rl-quit", text: "End exam" });
		quit.onclick = (e) => { e.preventDefault(); void this.finish(); };
		const track = bar.createDiv({ cls: "rl-progress rl-progress-slim" });
		track.createDiv({ cls: "rl-progress-fill" }).setCssProps({ "--rl-fill": `${(this.index / this.examItems.length) * 100}%` });

		const card = wrap.createDiv({ cls: "rl-question" });
		const meta = card.createDiv({ cls: "rl-qmeta" });
		meta.createSpan({ cls: "rl-chip", text: q.topic });
		if (q.timestamp) meta.createSpan({ cls: "rl-chip rl-chip-dim", text: q.timestamp });
		if (item.of) {
			meta.createSpan({ cls: "rl-chip rl-chip-dim", text: "variant" })
				.setAttr("aria-label", "A new look at a question you have answered right twice running");
		}

		await this.md(q.prompt, card.createDiv({ cls: "rl-prompt" }));
		// Click-the-bug and trace questions draw their own numbered code.
		if (q.code && q.type !== "hotspot" && q.type !== "trace") {
			card.createEl("pre", { cls: "rl-code" }).createEl("code", { text: q.code });
		}

		const steps = item.guided ? q.steps ?? [] : [];
		const step = this.guideStage?.index === this.index ? this.guideStage.step : 0;
		if (step < steps.length) {
			this.renderGuidedStep(card, steps, step);
			return;
		}
		if (steps.length) card.createDiv({ cls: "rl-hint rl-unaided", text: "Now the whole problem, unaided." });

		if (hidden) {
			recallText = this.renderRecallStage(card);
			return;
		}

		const staged = this.recallStage?.index === this.index && this.recallStage.shown;
		const recalled = staged ? this.recallStage!.text.trim() : undefined;
		if (recalled) {
			const quote = card.createDiv({ cls: "rl-model rl-recalled" });
			quote.createDiv({ cls: "rl-model-label", text: "You recalled" });
			quote.createDiv({ text: recalled });
		}

		const state: AnswerState = { chosen: [], text: "", recalled };
		const options = this.renderAnswerWidget(q, card.createDiv({ cls: "rl-answer" }), state);

		// Saying how sure you are tunes the schedule: a lucky guess comes back
		// soon, a quick sure answer goes further out. Submit claims neither.
		const actions = card.createDiv({ cls: "rl-actions" });
		// A trace shows each step's answer as it is checked, so by Submit you
		// know how you did: saying how sure you were would only inflate it.
		const askSure = q.type !== "trace";
		if (askSure) {
			new ButtonComponent(actions).setButtonText("Guessing")
				.setTooltip("Even if it is right, a guess comes back soon")
				.onClick(() => void this.submit(item, state, wrap, false, "guess"));
		}
		const submit = new ButtonComponent(actions).setButtonText("Submit").setCta()
			.onClick(() => void this.submit(item, state, wrap, false, "unsure"));
		if (askSure) {
			new ButtonComponent(actions).setButtonText("Sure")
				.setTooltip("Right, sure and quick: it is spaced out further")
				.onClick(() => void this.submit(item, state, wrap, false, "sure"));
		}
		const written = q.type === "short" || q.type === "command" || q.type === "image";
		const giveUp = () => { state.text = ""; void this.submit(item, state, wrap, true); };
		if (written) new ButtonComponent(actions).setButtonText("I don't know").onClick(giveUp);
		if (askSure) actions.createSpan({ cls: "rl-hint", text: "Guessing or sure? Saying so tunes when this comes back." });
		const mod = Platform.isMacOS ? "⌘" : "Ctrl";
		actions.createDiv({
			cls: "rl-keys",
			text: options.length
				? `Keys: 1–${Math.min(9, options.length)} choose · Enter submit · G guessing · S sure`
				: q.type === "order"
					? "Keys: Enter submit · G guessing · S sure"
					: q.type === "trace"
						? "Keys: Enter moves to the next box and checks a full step"
						: `Keys: ${mod}+Enter submit · Esc leaves the box, then G guessing · S sure${written ? " · D don't know" : ""}`,
		});

		this.examKeys = {
			choose: (slot) => options[slot]?.click(),
			submit: (confidence) => void this.submit(item, state, wrap, false, confidence),
			skip: written ? giveUp : undefined,
			focus: () => submit.buttonEl.focus(),
		};
		submit.buttonEl.focus();
	}

	/**
	 * One guided step on the way to a brutal problem. It is marked on the spot,
	 * showing what was wrong and why, and moves on to the next step, or to the
	 * whole problem after the last. Step answers are scaffolding, not recorded.
	 */
	private renderGuidedStep(card: HTMLElement, steps: Question[], at: number): void {
		const index = this.index;
		const step = steps[at];
		const box = card.createDiv({ cls: "rl-guided" });
		box.createDiv({ cls: "rl-model-label", text: `Guided step ${at + 1} of ${steps.length}` });
		void this.md(step.prompt, box.createDiv({ cls: "rl-prompt" }));
		if (step.code && step.type !== "hotspot" && step.type !== "trace") {
			box.createEl("pre", { cls: "rl-code" }).createEl("code", { text: step.code });
		}
		const state: AnswerState = { chosen: [], text: "" };
		const answer = box.createDiv({ cls: "rl-answer" });
		const options = this.renderAnswerWidget(step, answer, state);

		const goTo = (to: number) => {
			this.guideStage = { index, step: to };
			void this.render();
		};
		const actions = box.createDiv({ cls: "rl-actions" });
		let checked = false;
		const check = () => {
			if (checked) { goTo(at + 1); return; }
			const unready = notReady(step, state);
			if (unready) { new Notice(unready); return; }
			const res = gradeLocally(step, state);
			if (!res) return;
			checked = true;
			answer.querySelectorAll("input, textarea, select, button").forEach((el) => el.setAttr("disabled", "true"));
			const result = box.createDiv({ cls: `rl-feedback rl-fb-${res.verdict}` });
			const head = result.createDiv({ cls: "rl-fb-head" });
			setIcon(head.createSpan({ cls: "rl-fb-icon" }), res.verdict === "correct" ? "check-circle" : res.verdict === "partial" ? "circle-slash" : "x-circle");
			head.createSpan({ cls: "rl-fb-title", text: res.verdict === "correct" ? "Right" : "Not quite" });
			if (res.feedback) void this.md(res.feedback, result.createDiv({ cls: "rl-fb-body" }));
			if (step.explain) void this.md(step.explain, result.createDiv({ cls: "rl-explain" }));
			box.appendChild(actions);
			button.setButtonText(at + 1 < steps.length ? "Next step" : "Now the whole problem");
			button.buttonEl.focus();
		};
		const button = new ButtonComponent(actions).setButtonText("Check").setCta().onClick(check);
		new ButtonComponent(actions).setButtonText("Skip the steps").onClick(() => goTo(steps.length));
		this.examKeys = {
			choose: (slot) => options[slot]?.click(),
			submit: () => check(),
			next: () => check(),
			focus: () => button.buttonEl.focus(),
		};
		button.buttonEl.focus();
	}

	/**
	 * One more try after a miss: Claude's nudge toward what was missed, the
	 * answer back in the box to rework, and the choice between trying again
	 * and seeing the model answer. Resolves to the new answer, or null.
	 */
	private askSecondTry(wrap: HTMLElement, first: string, nudge: string): Promise<string | null> {
		return new Promise((resolve) => {
			const panel = wrap.createDiv({ cls: "rl-feedback rl-fb-partial rl-second-try" });
			const head = panel.createDiv({ cls: "rl-fb-head" });
			setIcon(head.createSpan({ cls: "rl-fb-icon" }), "lightbulb");
			head.createSpan({ cls: "rl-fb-title", text: "Not quite. One more try?" });
			void this.md(nudge, panel.createDiv({ cls: "rl-fb-body" }));
			const area = panel.createEl("textarea", { cls: "rl-text", attr: { rows: "4" } });
			area.value = first;
			const row = panel.createDiv({ cls: "rl-actions" });
			const done = (answer: string | null) => {
				this.settleSecondTry = null;
				panel.remove();
				resolve(answer);
			};
			const again = new ButtonComponent(row).setButtonText("Try again").setCta().onClick(() => done(area.value));
			new ButtonComponent(row).setButtonText("Show the answer").onClick(() => done(null));
			row.createSpan({ cls: "rl-hint", text: `A second try can earn up to ${Math.round(SECOND_TRY_CAP * 100)}%.` });
			this.settleSecondTry = () => done(null);
			this.examKeys = {
				choose: () => undefined,
				submit: () => done(area.value),
				next: () => done(area.value),
				focus: () => again.buttonEl.focus(),
			};
			window.setTimeout(() => area.focus(), 0);
		});
	}

	/**
	 * Recall first: the options stay hidden while you type, or just think of,
	 * the answer. Showing them keeps what you typed and redraws the question
	 * with the options under it. Returns what is typed so far.
	 */
	private renderRecallStage(card: HTMLElement): () => string {
		const stage = card.createDiv({ cls: "rl-recall-stage" });
		stage.createDiv({
			cls: "rl-hint",
			text: "Recall it first: type your answer, or just think of it, then show the options.",
		});
		const area = stage.createEl("textarea", {
			cls: "rl-text",
			attr: { rows: "2", placeholder: "Your answer, from memory" },
		});
		const actions = card.createDiv({ cls: "rl-actions" });
		const reveal = () => this.showOptions(area.value);
		const show = new ButtonComponent(actions).setButtonText("Show options").setCta().onClick(() => void reveal());
		const mod = Platform.isMacOS ? "⌘" : "Ctrl";
		actions.createDiv({ cls: "rl-keys", text: `Keys: ${mod}+Enter shows the options · Esc leaves the box, then Enter` });
		this.examKeys = {
			choose: () => undefined,
			submit: () => void reveal(),
			focus: () => show.buttonEl.focus(),
		};
		window.setTimeout(() => area.focus(), 0);
		return () => area.value;
	}

	/**
	 * Ends the recall stage and shows the options. The clock restarts: the
	 * time spent recalling is not time spent choosing, and counting it would
	 * make a recall-first answer look slow next to plain choice answers, so
	 * it could never rate Easy.
	 */
	private async showOptions(recalled: string): Promise<void> {
		this.recallStage = { index: this.index, text: recalled, shown: true };
		this.questionStart = Date.now();
		await this.render();
	}

	/** Draws the answer controls. Returns what the 1–9 keys click, in display order. */
	private renderAnswerWidget(q: Question, el: HTMLElement, state: AnswerState): HTMLElement[] {
		switch (q.type) {
			case "hotspot": return this.renderHotspot(q, el, state);
			case "order": this.renderOrder(q, el, state); return [];
			case "match": this.renderMatch(q, el, state); return [];
			case "cloze": this.renderCloze(q, el, state); return [];
			case "trace": this.renderTrace(q, el, state); return [];
		}
		if (q.type === "mcq" || q.type === "multi") {
			const multi = q.type === "multi";
			if (multi) el.createDiv({ cls: "rl-hint", text: "Select every correct option." });

			// Fresh random order each render; state.chosen keeps ORIGINAL indices.
			const order = shuffled((q.choices ?? []).map((_, i) => i));
			const inputs: HTMLInputElement[] = [];
			order.forEach((original, slot) => {
				const row = el.createDiv({ cls: "rl-choice" });
				const input = row.createEl("input", {
					type: multi ? "checkbox" : "radio",
					attr: { name: `q-${q.id}`, id: `c-${q.id}-${slot}` },
				});
				inputs.push(input);
				void this.md(q.choices![original], row.createEl("label", { attr: { for: `c-${q.id}-${slot}` } }));
				// A click on the label already reaches the input; clicking it again
				// here toggled a checkbox straight back, so the text never selected.
				row.onclick = (e) => {
					if (e.target !== input && !(e.target instanceof Element && e.target.closest("label"))) input.click();
				};
				input.onchange = () => {
					if (multi) {
						state.chosen = state.chosen.includes(original)
							? state.chosen.filter((x) => x !== original)
							: [...state.chosen, original];
					} else state.chosen = [original];
					el.querySelectorAll(".rl-choice").forEach((c, ci) => c.toggleClass("rl-chosen", state.chosen.includes(order[ci])));
				};
			});
			return inputs;
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
			return [];
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
		return [];
	}

	/** Click the bug: numbered code whose lines toggle; one line, or several when the answer has several. */
	private renderHotspot(q: Question, el: HTMLElement, state: AnswerState): HTMLElement[] {
		const want = q.lines?.length ?? 1;
		el.createDiv({ cls: "rl-hint", text: want > 1 ? `Click the ${want} lines.` : "Click the line." });
		const box = el.createDiv({ cls: "rl-hotspot" });
		const rows: HTMLElement[] = [];
		(q.code ?? "").split("\n").forEach((text, i) => {
			const line = i + 1;
			const row = box.createDiv({ cls: "rl-hot-line", attr: { tabindex: "0", role: "button" } });
			row.createSpan({ cls: "rl-hot-no", text: String(line) });
			row.createSpan({ cls: "rl-hot-code", text: text || " " });
			const toggle = () => {
				if (this.revealed) return;
				state.chosen = want > 1
					? state.chosen.includes(line) ? state.chosen.filter((l) => l !== line) : [...state.chosen, line]
					: [line];
				rows.forEach((r, ri) => r.toggleClass("rl-hot-chosen", state.chosen.includes(ri + 1)));
			};
			row.onclick = toggle;
			row.onkeydown = (e) => {
				if (e.key === " ") { e.preventDefault(); toggle(); }
			};
			rows.push(row);
		});
		return rows;
	}

	/** Order the steps: drag the items, or move them with their arrows. */
	private renderOrder(q: Question, el: HTMLElement, state: AnswerState): void {
		const items = q.items ?? [];
		state.order = scrambled(items.length);
		state.orderStart = state.order.slice();
		el.createDiv({ cls: "rl-hint", text: "Put these in order: drag them, or use the arrows." });
		const list = el.createDiv({ cls: "rl-order" });
		/** Our own drag type, so text or a file dropped from elsewhere is ignored. */
		const DRAG = "application/x-recall-lab-order";
		const draw = (focus?: { pos: number; dir: "up" | "down" }) => {
			list.empty();
			const order = state.order!;
			order.forEach((original, pos) => {
				const row = list.createDiv({ cls: "rl-order-item", attr: { draggable: "true" } });
				row.createSpan({ cls: "rl-order-pos", text: String(pos + 1) });
				void this.md(items[original], row.createDiv({ cls: "rl-order-text" }));
				const move = (to: number, dir: "up" | "down") => {
					if (this.revealed || to < 0 || to >= order.length) return;
					const [it] = order.splice(pos, 1);
					order.splice(to, 0, it);
					// Redrawing removes the button that had focus; put it back on
					// the moved item, so the arrows and the exam keys keep working.
					draw({ pos: to, dir });
				};
				const up = row.createEl("button", { cls: "rl-order-btn", text: "↑", attr: { "aria-label": "Move up" } });
				const down = row.createEl("button", { cls: "rl-order-btn", text: "↓", attr: { "aria-label": "Move down" } });
				up.disabled = pos === 0;
				down.disabled = pos === order.length - 1;
				up.onclick = () => move(pos - 1, "up");
				down.onclick = () => move(pos + 1, "down");
				if (focus?.pos === pos) {
					const want = focus.dir === "up" ? up : down;
					(want.disabled ? (want === up ? down : up) : want).focus();
				}
				row.ondragstart = (e) => e.dataTransfer?.setData(DRAG, String(pos));
				row.ondragover = (e) => e.preventDefault();
				row.ondrop = (e) => {
					e.preventDefault();
					const raw = e.dataTransfer?.getData(DRAG);
					const from = raw ? Number(raw) : NaN;
					if (!Number.isInteger(from) || from < 0 || from >= order.length || from === pos || this.revealed) return;
					const [it] = order.splice(from, 1);
					order.splice(pos, 0, it);
					draw();
				};
			});
		};
		draw();
	}

	/** Match: a dropdown of the shuffled right-hand sides beside each left-hand item. */
	private renderMatch(q: Question, el: HTMLElement, state: AnswerState): void {
		const pairs = q.pairs ?? [];
		state.matches = pairs.map(() => -1);
		el.createDiv({ cls: "rl-hint", text: "Match each item on the left with one on the right." });
		const rights = shuffled(pairs.map((_, i) => i));
		const grid = el.createDiv({ cls: "rl-match" });
		pairs.forEach(([left], i) => {
			const row = grid.createDiv({ cls: "rl-match-row" });
			void this.md(left, row.createDiv({ cls: "rl-match-left" }));
			const select = row.createEl("select", { cls: "dropdown rl-match-select" });
			select.createEl("option", { text: "Choose…", attr: { value: "-1" } });
			for (const j of rights) select.createEl("option", { text: plain(pairs[j][1]), attr: { value: String(j) } });
			select.onchange = () => { state.matches![i] = Number(select.value); };
		});
	}

	/** Fill in the blank: the sentence with a text box at each blank. */
	private renderCloze(q: Question, el: HTMLElement, state: AnswerState): void {
		const blanks = clozeBlanks(q.cloze ?? "");
		state.blanks = blanks.map(() => "");
		const line = el.createDiv({ cls: "rl-cloze" });
		clozePieces(q.cloze ?? "").forEach((piece, i) => {
			inlineText(line, piece);
			if (i >= blanks.length) return;
			const input = line.createEl("input", {
				type: "text",
				cls: "rl-blank",
				attr: { size: String(blankSize(blanks[i])), spellcheck: "false", "aria-label": `Blank ${i + 1}` },
			});
			input.oninput = () => { state.blanks![i] = input.value; };
		});
		window.setTimeout(() => line.querySelector("input")?.focus(), 0);
	}

	/**
	 * Step-through trace: numbered code, and one step at a time the values to
	 * fill in once that line has run. Each step is checked straight away,
	 * showing the right values before the next step appears; the answer can
	 * be submitted once every step is checked.
	 */
	private renderTrace(q: Question, el: HTMLElement, state: AnswerState): void {
		const steps = q.trace ?? [];
		state.cells = steps.map((s) => Object.keys(s.expect).map(() => ""));
		state.traceChecked = 0;
		const code = el.createDiv({ cls: "rl-hotspot rl-trace-code" });
		const rows = (q.code ?? "").split("\n").map((text, i) => {
			const row = code.createDiv({ cls: "rl-hot-line rl-trace-line" });
			row.createSpan({ cls: "rl-hot-no", text: String(i + 1) });
			row.createSpan({ cls: "rl-hot-code", text: text || " " });
			return row;
		});
		const stepsEl = el.createDiv({ cls: "rl-trace-steps" });

		const showStep = (s: number) => {
			const step = steps[s];
			rows.forEach((r, i) => r.toggleClass("rl-trace-current", i + 1 === step.line));
			const box = stepsEl.createDiv({ cls: "rl-trace-step" });
			box.createDiv({ cls: "rl-model-label", text: `Step ${s + 1} of ${steps.length}: once line ${step.line} has run` });
			const grid = box.createDiv({ cls: "rl-trace-grid" });
			const entries = Object.entries(step.expect);
			const inputs = entries.map(([name], k) => {
				const cell = grid.createDiv({ cls: "rl-trace-cell" });
				cell.createSpan({ cls: "rl-trace-name", text: name });
				const input = cell.createEl("input", {
					type: "text",
					cls: "rl-blank rl-mono",
					attr: { size: "12", spellcheck: "false", "aria-label": name },
				});
				input.oninput = () => { state.cells![s][k] = input.value; };
				input.onkeydown = (e) => {
					if (e.key !== "Enter" || e.metaKey || e.ctrlKey) return;
					e.preventDefault();
					// Enter moves on to the next empty cell; a step is checked
					// only once every cell has something in it.
					const empty = inputs.findIndex((x, i) => i !== k && !x.value.trim());
					if (empty >= 0) inputs[empty].focus();
					else if (input.value.trim()) check();
				};
				return input;
			});
			const button = new ButtonComponent(box)
				.setButtonText(s === steps.length - 1 ? "Check last step" : "Check step")
				.onClick(() => check());
			const check = () => {
				if (this.revealed || (state.traceChecked ?? 0) > s) return;
				entries.forEach(([, want], k) => {
					const right = sameValue(state.cells![s][k], want);
					inputs[k].addClass(right ? "rl-cell-right" : "rl-cell-wrong");
					inputs[k].disabled = true;
					if (!right) inputs[k].parentElement?.createSpan({ cls: "rl-trace-want", text: want });
				});
				button.buttonEl.remove();
				state.traceChecked = s + 1;
				if (s + 1 < steps.length) showStep(s + 1);
				else {
					rows.forEach((r) => r.removeClass("rl-trace-current"));
					this.examKeys?.focus();
				}
			};
			window.setTimeout(() => inputs[0]?.focus(), 0);
		};
		if (steps.length) showStep(0);
	}

	private async submit(
		item: ExamItem, state: AnswerState, wrap: HTMLElement, gaveUp = false, confidence?: Confidence
	): Promise<void> {
		const q = item.q;
		if (this.revealed) return;
		const unready = gaveUp ? null : notReady(q, state);
		if (unready) { new Notice(unready); return; }
		this.revealed = true;
		const ms = Date.now() - this.questionStart;
		const extra: Pick<Attempt, "confidence" | "recalled" | "nudged"> = {};
		if (confidence && q.type !== "trace") extra.confidence = confidence;
		if (state.recalled !== undefined) extra.recalled = state.recalled;

		const local = gaveUp
			? { score: 0, verdict: "incorrect" as const, feedback: "You skipped this one.", missing: [q.topic] }
			: gradeLocally(q, state);

		const live: LiveAnswer = { q, bankId: item.bankId, response: describeResponse(q, state), image: state.image, ms };
		if (local) {
			live.attempt = this.attemptFrom(item, live.response, local.score, local.verdict, local.feedback, local.missing, "local", ms, extra);
			this.keep(live.attempt);
			this.answers.push(live);
			this.showFeedback(q, live, wrap);
			return;
		}

		// Open answer: Claude marks it now, in place. No queue, no commands.
		this.answers.push(live);
		let pending = this.showFeedback(q, live, wrap, true);
		this.plugin.log.info("marking an open answer", { question: q.id, type: q.type });
		let marked = await this.plugin.tasks.markAnswer(q, state.text, state.image);

		// A miss that came with a nudge gets one more try before the answer shows.
		if (!("error" in marked) && marked.nudge && this.plugin.settings.secondTry) {
			pending.remove();
			const retry = await this.askSecondTry(wrap, state.text, marked.nudge);
			pending = retry === null ? wrap.createDiv() : this.showFeedback(q, live, wrap, true);
			if (retry !== null) {
				this.plugin.log.info("second try", { question: q.id });
				const second = await this.plugin.tasks.markAnswer(q, retry, state.image);
				if (!("error" in second)) {
					marked = combineTries(marked, second);
					live.response = retry;
					extra.nudged = true;
				}
			}
		}

		if ("error" in marked) {
			this.plugin.log.error("marking failed", { question: q.id, error: marked.error });
			live.attempt = this.attemptFrom(item, live.response, 0, "incorrect",
				`Could not reach Claude to mark this: ${marked.error}`, [q.topic], "error", ms, extra);
		} else {
			this.plugin.log.info("answer marked", { question: q.id, score: marked.score });
			live.attempt = this.attemptFrom(item, live.response, marked.score, marked.verdict,
				[marked.feedback, marked.improve].filter(Boolean).join(" "), marked.missing, "ai", ms, extra);
		}
		this.keep(live.attempt);
		pending.remove();
		this.showFeedback(q, live, wrap);
	}

	/** Saves an answer as soon as it is marked. A failure is reported, never dropped silently. */
	private keep(attempt: Attempt): void {
		this.plugin.store.recordAttempt(attempt).catch((e) => {
			this.plugin.log.error("could not save an answer", { question: attempt.questionId, error: String(e) });
			new Notice(`Recall Lab could not save that answer: ${String(e)}`, 10000);
		});
	}

	/**
	 * The answer is recorded against the question's own bank — never the
	 * paper's, which for a course exam is a virtual "course:" id that matches
	 * no bank, so the answer would never reach the radar.
	 */
	private attemptFrom(
		item: ExamItem, response: string, score: number, verdict: Attempt["verdict"],
		feedback: string, missing: string[], gradedBy: Attempt["gradedBy"], ms: number,
		extra: Pick<Attempt, "confidence" | "recalled" | "nudged"> = {}
	): Attempt {
		const q = item.q;
		return {
			ts: new Date().toISOString(), sessionId: this.sessionId, bankId: item.bankId,
			questionId: idOf(item), tier: q.tier, type: q.type, topic: q.topic,
			response, score, verdict, feedback, missing, gradedBy, ms,
			...(item.of ? { variant: q.id } : {}),
			...extra,
		};
	}

	private showFeedback(q: Question, live: LiveAnswer, wrap: HTMLElement, marking = false): HTMLElement {
		wrap.querySelector(".rl-actions")?.remove();
		wrap.querySelectorAll(".rl-answer input, .rl-answer textarea, .rl-answer select, .rl-answer button")
			.forEach((el) => el.setAttr("disabled", "true"));
		// Click the bug: show which lines were the answer.
		wrap.querySelectorAll(".rl-hot-line").forEach((row, i) => row.toggleClass("rl-hot-answer", Boolean(q.lines?.includes(i + 1))));

		const panel = wrap.createDiv({ cls: "rl-feedback" });
		if (marking) {
			panel.addClass("rl-fb-pending");
			const head = panel.createDiv({ cls: "rl-fb-head" });
			head.createDiv({ cls: "rl-spinner" });
			head.createSpan({ cls: "rl-fb-title", text: "Claude is marking this…" });
			// With a second try possible, the model answer waits until it is over.
			if (q.expected && !this.plugin.settings.secondTry) {
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
		const last = this.index === this.examItems.length - 1;
		new ButtonComponent(next).setButtonText(last ? "Finish" : "Next").setCta()
			.onClick(() => void this.advance()).buttonEl.focus();
		next.createSpan({ cls: "rl-hint", text: "Enter or Space" });
		if (this.examKeys) this.examKeys.next = () => void this.advance();
		return panel;
	}

	private async advance(): Promise<void> {
		this.revealed = false;
		this.recallStage = null;
		this.guideStage = null;
		if (this.index === this.examItems.length - 1) { await this.finish(); return; }
		this.index += 1;
		this.questionStart = Date.now();
		await this.render();
	}

	// ================================================================ results

	private async finish(): Promise<void> {
		// Ending mid second try takes the first answer as it was marked; it is
		// saved as soon as that settles.
		this.settleSecondTry?.();
		const graded = this.answers.filter((a) => a.attempt).map((a) => a.attempt!);
		// A marking that failed says nothing about what you know.
		const marked = graded.filter(counts);
		const meanScore = marked.length ? Math.round(marked.reduce((s, a) => s + a.score, 0) / marked.length) : 0;

		const byTopic = new Map<string, number[]>();
		for (const a of marked) { const l = byTopic.get(a.topic) ?? []; l.push(a.score); byTopic.set(a.topic, l); }
		const weakTopics = [...byTopic.entries()]
			.map(([t, s]) => ({ t, m: s.reduce((x, y) => x + y, 0) / s.length }))
			.filter((e) => e.m < 80).sort((a, b) => a.m - b.m).map((e) => e.t);

		const review = this.sessionKind === "review";
		const summary: SessionSummary = {
			id: this.sessionId, ts: new Date().toISOString(),
			bankId: this.bank!.id, bankTitle: this.bank!.title, tier: review ? "review" : "mixed",
			asked: this.answers.length, meanScore, grade: letterGrade(meanScore),
			weakTopics, coachingPending: !review,
		};

		// Queued behind the answers already being saved, so once it is written
		// the progress file holds every answer of this session.
		await this.plugin.store.recordSession(summary);
		const course = await this.courseForBank(this.bank!);
		let axes: AxisScore[] = [];
		if (course) {
			const progress = await this.plugin.store.readProgress();
			axes = scoreAxes(course, Store.banksForCourse(course, this.banks), this.expectedScores(progress.attempts).now);
		}

		this.screen = "results";
		await this.render();
		void this.plugin.refreshMemoryViews();

		// An exam's coaching is fetched right away and dropped into the panel
		// when it lands. A review stays offline; its feedback is one click away.
		if (!review) void this.fetchCoaching(summary, axes);
	}

	/** Asks Claude for a review's feedback, which reviews never fetch on their own. */
	private async requestCoaching(summary: SessionSummary): Promise<void> {
		this.coachingInFlight.add(summary.id);
		await this.render();
		try {
			await this.fetchCoaching(summary, [], false);
		} finally {
			this.coachingInFlight.delete(summary.id);
		}
		if (this.screen === "results" && this.sessionId === summary.id) await this.render();
	}

	/**
	 * Fetches Claude's feedback on a session and keeps it. An exam's automatic
	 * request keeps a failure as the feedback text; an on-demand one does not,
	 * so the button stays there to try again.
	 */
	private async fetchCoaching(summary: SessionSummary, axes: AxisScore[], keepFailure = true): Promise<void> {
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
		if (typeof res !== "string" && !keepFailure) {
			new Notice(`Could not get feedback from Claude: ${res.error}`, 12000);
			return;
		}
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
		const now = new Date();
		const memory = new Memory(progress.attempts, this.plugin.settings.targetRecall / 100);
		const tomorrow = memory.forecast(now, 2, keysOf(Store.itemsOf(this.everyBank)))[1];
		hero.createDiv({
			cls: "rl-result-sub",
			text: `${graded.length} question${graded.length === 1 ? "" : "s"}${byAi ? ` · ${byAi} marked by Claude` : ""}` +
				` · ${tomorrow} due for review tomorrow`,
		});

		this.renderCoaching(main, session);

		// Mistakes made with confidence get their own list: once corrected they
		// are remembered unusually well (the hypercorrection effect).
		const confident = graded.filter((a) => counts(a) && a.confidence === "sure" && a.verdict !== "correct");
		if (confident.length) {
			const list = main.createDiv({ cls: "rl-panel rl-panel-confident" });
			list.createEl("h3", { text: "You were sure, but…" });
			list.createDiv({
				cls: "rl-muted",
				text: "Mistakes made with confidence stick unusually well once corrected. Read these explanations twice.",
			});
			for (const a of confident) this.renderReviewRow(list, a, true);
		}

		const wrong = graded.filter((a) => a.verdict !== "correct" && !confident.includes(a));
		if (wrong.length) {
			const list = main.createDiv({ cls: "rl-panel" });
			list.createEl("h3", { text: "Go back over these" });
			for (const a of wrong) this.renderReviewRow(list, a, false);
		}

		const actions = main.createDiv({ cls: "rl-actions" });
		new ButtonComponent(actions).setButtonText("Back to overview").setCta()
			.onClick(() => { this.screen = "home"; void this.render(); });
		new ButtonComponent(actions).setButtonText("History")
			.onClick(() => { this.screen = "history"; void this.render(); });
	}

	/** One answer to go back over: its topic, the question, what was wrong, and optionally why. */
	private renderReviewRow(list: HTMLElement, a: Attempt, withExplanation: boolean): void {
		const q = this.examItems.find((x) => x.bankId === a.bankId && idOf(x) === a.questionId)?.q;
		const row = list.createDiv({ cls: "rl-review-row" });
		row.createSpan({ cls: "rl-chip", text: a.topic });
		void this.md(q ? q.prompt.split("\n")[0] : a.questionId, row.createDiv({ cls: "rl-review-q" }));
		if (a.feedback) void this.md(a.feedback, row.createDiv({ cls: "rl-review-fb" }));
		if (withExplanation && q?.explain) void this.md(q.explain, row.createDiv({ cls: "rl-review-fb rl-explain" }));
	}

	/** Claude's feedback, shown here as soon as it lands. */
	private renderCoaching(main: HTMLElement, session: SessionSummary | undefined): void {
		const panel = main.createDiv({ cls: "rl-coaching" });
		panel.createDiv({ cls: "rl-model-label", text: "Feedback from Claude" });
		if (session?.coaching) {
			void this.md(session.coaching, panel.createDiv());
			return;
		}
		if (session && !session.coachingPending && !this.coachingInFlight.has(session.id)) {
			panel.createDiv({
				cls: "rl-muted",
				text: "Reviews stay offline. Ask for feedback if you want Claude to look for the pattern behind your mistakes.",
			});
			new ButtonComponent(panel.createDiv({ cls: "rl-actions" }))
				.setButtonText("Get feedback (uses Claude)")
				.onClick(() => void this.requestCoaching(session));
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
		stat("Sessions", String(progress.sessions.length));
		const marked = progress.attempts.filter(counts);
		stat("Questions answered", String(marked.length));
		stat("Mean score", `${mean}%`);
		stat("Notes completed", String(Object.keys(progress.completed ?? {}).length));

		await this.renderActivity(main, progress);
		this.renderCalibration(main, progress.attempts);

		// Weakest topics across everything.
		const byTopic = new Map<string, number[]>();
		for (const a of marked) { const l = byTopic.get(a.topic) ?? []; l.push(a.score); byTopic.set(a.topic, l); }
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

	/**
	 * The vault-wide day-by-day record behind the streak and the calendar.
	 * Finished days are kept the first time they are worked out, so moving
	 * the target recall later cannot rewrite them (see settledRecord).
	 */
	private async dayRecord(progress: ProgressFile, now: Date): Promise<DayRecord[]> {
		const keys = keysOf(Store.itemsOf(this.everyBank));
		const { days, settle } = settledRecord(progress.attempts, this.plugin.settings.targetRecall / 100, keys, now, progress.days ?? {});
		if (Object.keys(settle).length) {
			try {
				await this.plugin.store.keepDays(settle);
			} catch (e) {
				this.plugin.log.error("could not keep the daily record", { error: String(e) });
			}
		}
		return days;
	}

	/** The streak, and a year of daily activity in the style of a contributions calendar. */
	private async renderActivity(main: HTMLElement, progress: ProgressFile): Promise<void> {
		const now = new Date();
		const days = await this.dayRecord(progress, now);
		if (!days.length) return;
		const streak = streakOf(days);

		const panel = main.createDiv({ cls: "rl-panel" });
		const head = panel.createDiv({ cls: "rl-panel-head" });
		head.createEl("h3", { text: "Activity" });
		head.createSpan({ cls: "rl-grade-pill", text: `${streak.current}-day streak · best ${streak.longest}` });
		panel.createDiv({
			cls: "rl-muted",
			text: "A day counts toward the streak when it ends with nothing overdue. Today cannot break it until it is over.",
		});

		// A year of weeks, Sunday at the top, today in the last column. Days
		// that ended with reviews overdue are outlined.
		const byDay = new Map(days.map((d) => [d.day, d]));
		const most = Math.max(1, ...days.map((d) => d.answers));
		const today = startOfDay(now);
		const scroller = panel.createDiv({ cls: "rl-calendar-scroll" });
		const grid = scroller.createDiv({ cls: "rl-calendar" });
		for (
			let d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 52 * 7 - today.getDay());
			d.getTime() <= today.getTime();
			d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
		) {
			const rec = byDay.get(d.getTime());
			const n = rec?.answers ?? 0;
			const missed = Boolean(rec && !rec.clear && d.getTime() < today.getTime());
			const cell = grid.createDiv({ cls: `rl-day rl-day-${n ? Math.min(4, Math.ceil((n / most) * 4)) : 0}` });
			if (missed) cell.addClass("rl-day-missed");
			const date = d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
			cell.setAttr("title", `${date}: ${n} answer${n === 1 ? "" : "s"}${missed ? " · reviews left overdue" : ""}`);
		}
		window.setTimeout(() => (scroller.scrollLeft = scroller.scrollWidth), 0);
	}

	/** Whether "sure" really means sure: how often each level of confidence was right. */
	private renderCalibration(main: HTMLElement, attempts: Attempt[]): void {
		const levels = calibration(attempts);
		if (!levels.length) return;
		const label: Record<Confidence, string> = {
			sure: "When you said Sure",
			unsure: "When you just submitted",
			guess: "When you were guessing",
		};
		const panel = main.createDiv({ cls: "rl-panel" });
		panel.createEl("h3", { text: "How well you know what you know" });
		for (const c of levels) {
			const pct = Math.round((c.right / c.answers) * 100);
			const row = panel.createDiv({ cls: "rl-bar-row" });
			row.createSpan({ cls: "rl-bar-label", text: label[c.level] });
			const fill = row.createDiv({ cls: "rl-progress" }).createDiv({ cls: "rl-progress-fill" });
			fill.setCssProps({ "--rl-fill": `${pct}%` });
			row.createSpan({ cls: "rl-bar-value", text: `${pct}% right · ${c.answers}` });
		}
		const sure = levels.find((c) => c.level === "sure");
		if (sure && sure.answers >= 10 && sure.right / sure.answers < 0.8) {
			panel.createDiv({
				cls: "rl-radar-note",
				text: "When you say Sure, you are wrong more than one time in five. Those are worth slowing down for.",
			});
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


function clamp(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, Math.round(n)));
}

/** Short text placed inline, keeping `code` spans and dropping other markdown. */
function inlineText(parent: HTMLElement, text: string): void {
	for (const part of text.split(/(`[^`]+`)/)) {
		if (/^`[^`]+`$/.test(part)) parent.createEl("code", { text: part.slice(1, -1) });
		else if (part) parent.appendText(plain(part));
	}
}
