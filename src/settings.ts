import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type RecallLabPlugin from "./main";
import { INSTALL_HINT } from "./claude";

export type Strictness = "lenient" | "normal" | "brutal";

export interface RecallLabSettings {
	/** Absolute path to the claude binary; blank = find it automatically. */
	claudePath: string;
	/** Model the CLI runs grading and generation with. */
	model: string;
	/** Passed to Claude in the grading request so marking matches your taste. */
	strictness: Strictness;
	banksFolder: string;
	coursesFolder: string;
	labsFolder: string;
	/** Where lab files are laid out on disk. ~ is expanded. */
	labWorkspace: string;
	progressFolder: string;
	/** Mastery % in the tier below needed to unlock this tier. */
	unlockHard: number;
	unlockBrutal: number;
	allowOverride: boolean;
	defaultLength: number;
	/** Percent chance of still remembering a question when its review comes due. */
	targetRecall: number;
	/** Questions you have never answered that a day's reviews may introduce. */
	newPerDay: number;
	/** Memory dots on headings, the memory line in note footers, and the status-bar due count. */
	memoryMap: boolean;
	/** Hide choice options until you have tried to recall the answer. */
	recallFirst: boolean;
	/** Turn ==highlighted== text in course notes into fill-in-the-blank questions. */
	highlightClozes: boolean;
	/** Misses after which a question goes to the leech clinic. */
	leechThreshold: number;
	/** Walk through a brutal problem's steps first when it is new to you or you missed it last time. */
	guidedSteps: boolean;
	/** After a missed written answer, a nudge from Claude and one more try before the model answer. */
	secondTry: boolean;
	/** Minutes on the clock for "write it all down". */
	blurtMinutes: number;
	/** Questions the student may ask in "teach it back" before it is scored. */
	teachQuestions: number;
	/** The docker command for building challenges; blank finds it. */
	ctfDocker: string;
	/** A docker context, such as colima-ctf; blank uses the current one. */
	ctfContext: string;
}

export const DEFAULT_SETTINGS: RecallLabSettings = {
	claudePath: "",
	model: "sonnet",
	strictness: "brutal",
	banksFolder: "_quiz/banks",
	coursesFolder: "_quiz/courses",
	labsFolder: "_quiz/labs",
	labWorkspace: "~/RecallLab/labs",
	progressFolder: "_quiz/progress",
	unlockHard: 80,
	unlockBrutal: 80,
	allowOverride: true,
	defaultLength: 15,
	targetRecall: 90,
	newPerDay: 20,
	memoryMap: true,
	recallFirst: false,
	highlightClozes: true,
	leechThreshold: 4,
	guidedSteps: true,
	secondTry: true,
	blurtMinutes: 3,
	teachQuestions: 3,
	ctfDocker: "",
	ctfContext: "",
};

export class RecallLabSettingTab extends PluginSettingTab {
	plugin: RecallLabPlugin;

	constructor(app: App, plugin: RecallLabPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const intro = containerEl.createDiv({ cls: "rl-settings-intro" });
		intro.createEl("p", {
			text:
				"Recall Lab holds no API key. Multiple choice is marked instantly and offline. Written answers, " +
				"feedback and quiz generation run through the Claude Code CLI on your own subscription — " +
				"automatically, with nothing for you to type.",
		});

		new Setting(containerEl).setName("Claude").setHeading();

		new Setting(containerEl)
			.setName("Model")
			.setDesc(
				"Runs through the Claude Code CLI on your existing subscription — no API key. Sonnet is the " +
					"sensible default; Opus gives sharper feedback at roughly three times the usage, Haiku is cheapest."
			)
			.addDropdown((d) => {
				d.addOption("sonnet", "Sonnet — balanced (default)");
				d.addOption("opus", "Opus — sharpest feedback");
				d.addOption("haiku", "Haiku — cheapest and fastest");
				d.setValue(this.plugin.settings.model).onChange(async (v) => {
					this.plugin.settings.model = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Path to the Claude binary")
			.setDesc("Leave blank to find it automatically. Set it if Recall Lab reports the CLI is missing when it is not.")
			.addText((t) =>
				t.setPlaceholder("/opt/homebrew/bin/claude")
					.setValue(this.plugin.settings.claudePath)
					.onChange(async (v) => {
						this.plugin.settings.claudePath = v.trim();
						await this.plugin.saveSettings();
						this.plugin.cli.forget();
					})
			);

		new Setting(containerEl)
			.setName("Check the connection")
			.setDesc("Confirms Recall Lab can reach Claude.")
			.addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					b.setDisabled(true).setButtonText("Testing…");
					const where = await this.plugin.cli.locate();
					if (!where) {
						new Notice(`Claude CLI not found. ${INSTALL_HINT}`, 12000);
					} else {
						const r = await this.plugin.cli.ask('Reply with exactly: OK', 60000);
						new Notice(r.ok ? `Connected — ${where}` : `Found ${where} but it failed: ${r.error}`, 10000);
					}
					b.setDisabled(false).setButtonText("Test");
				})
			);

		new Setting(containerEl).setName("Grading").setHeading();

		new Setting(containerEl)
			.setName("Strictness")
			.setDesc(
				"Written into the grading request Claude reads. Brutal awards no sympathy marks: an answer that sounds right but misses a rubric point loses it, and the feedback says so plainly."
			)
			.addDropdown((d) => {
				d.addOption("lenient", "Lenient — credit the idea");
				d.addOption("normal", "Normal");
				d.addOption("brutal", "Brutal — no sympathy marks");
				d.setValue(this.plugin.settings.strictness).onChange(async (v) => {
					this.plugin.settings.strictness = v as Strictness;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl).setName("Questions").setHeading();

		new Setting(containerEl)
			.setName("Recall before recognition")
			.setDesc(
				"On multiple-choice and select-all questions, hide the options until you have typed or thought of " +
					"your answer. Producing an answer builds memory better than spotting it. Also switchable from the exam bar."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.recallFirst).onChange(async (v) => {
					this.plugin.settings.recallFirst = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Fill in your highlights")
			.setDesc(
				"Turn each sentence with ==highlighted== text in a course note into a fill-in-the-blank question. " +
					"Made on your device, with no Claude involved; they join that note's exams and your reviews."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.highlightClozes).onChange(async (v) => {
					this.plugin.settings.highlightClozes = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Second try on written answers")
			.setDesc(
				"When Claude marks a written answer as not right, it asks one nudging question and you get one more " +
					"try before the model answer shows. A second try earns at most 75%; trying again is one more Claude request."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.secondTry).onChange(async (v) => {
					this.plugin.settings.secondTry = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Guided steps")
			.setDesc(
				"Walk through a brutal problem's smaller steps, each checked at once, before answering it whole: when " +
					"it is new to you or you missed it last time. Steps are written per course, on request."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.guidedSteps).onChange(async (v) => {
					this.plugin.settings.guidedSteps = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Write it all down: minutes")
			.setDesc("How long the clock runs when you write down everything you remember about a note before its quiz.")
			.addSlider((s) =>
				s
					.setLimits(1, 10, 1)
					.setValue(this.plugin.settings.blurtMinutes)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.blurtMinutes = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Teach it back: student questions")
			.setDesc(
				"How many follow-up questions the student may ask before your explanation is scored. Each is one " +
					"Claude request, and scoring is one more."
			)
			.addSlider((s) =>
				s
					.setLimits(1, 5, 1)
					.setValue(this.plugin.settings.teachQuestions)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.teachQuestions = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Leech clinic after")
			.setDesc(
				"How many times a question has to be missed, and not since got right twice running, before the " +
					"overview offers to diagnose it."
			)
			.addSlider((s) =>
				s
					.setLimits(2, 10, 1)
					.setValue(this.plugin.settings.leechThreshold)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.leechThreshold = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Daily review").setHeading();

		new Setting(containerEl)
			.setName("Target recall")
			.setDesc(
				"How likely you should be to still remember a question when it comes back for review. Higher means " +
					"shorter gaps and more reviews; 90% is the usual balance."
			)
			.addSlider((s) =>
				s
					.setLimits(70, 97, 1)
					.setValue(this.plugin.settings.targetRecall)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.targetRecall = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("New questions per day")
			.setDesc(
				"How many questions you have never answered a day's reviews may bring in. They come only from notes " +
					"you have marked complete or already taken an exam on."
			)
			.addSlider((s) =>
				s
					.setLimits(0, 100, 5)
					.setValue(this.plugin.settings.newPerDay)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.newPerDay = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Memory map on notes")
			.setDesc(
				"A green, amber or red dot beside each heading in reading view showing how well you remember that " +
					"section, a memory line in each note's footer, and today's due count in the status bar."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.memoryMap).onChange(async (v) => {
					this.plugin.settings.memoryMap = v;
					await this.plugin.saveSettings();
					await this.plugin.refreshMemoryViews();
				})
			);

		new Setting(containerEl).setName("Progression").setHeading();

		new Setting(containerEl)
			.setName("Mastery needed to unlock Hard")
			.setDesc(
				"How much of a quiz's Easy tier you must own before its Hard questions are asked, in exams and as new " +
					"questions in reviews. Unanswered questions count as zero, so you have to cover the tier, not just " +
					"score well on the few you tried. 0 opens Hard straight away."
			)
			.addSlider((s) =>
				s
					.setLimits(0, 100, 5)
					.setValue(this.plugin.settings.unlockHard)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.unlockHard = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Mastery needed to unlock Brutal")
			.setDesc("How much of a quiz's Hard tier you must own before its Brutal questions are asked. 0 opens Brutal as soon as Hard is open.")
			.addSlider((s) =>
				s
					.setLimits(0, 100, 5)
					.setValue(this.plugin.settings.unlockBrutal)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.unlockBrutal = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Allow drilling locked tiers")
			.setDesc(
				"Keeps the gate advisory: an exam that leaves locked tiers out offers to include them. Off, the gate is " +
					"binding. Reviews never bring in new questions from a locked tier either way."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.allowOverride).onChange(async (v) => {
					this.plugin.settings.allowOverride = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Default session length")
			.addSlider((s) =>
				s
					.setLimits(5, 50, 5)
					.setValue(this.plugin.settings.defaultLength)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.defaultLength = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Binary challenges").setHeading();

		new Setting(containerEl)
			.setName("Docker command")
			.setDesc(
				"Challenges are compiled and checked inside a throwaway x86-64 Linux container, never on your " +
					"machine. Leave blank to find Docker automatically."
			)
			.addText((t) =>
				t.setPlaceholder("/opt/homebrew/bin/docker")
					.setValue(this.plugin.settings.ctfDocker)
					.onChange(async (v) => {
						this.plugin.settings.ctfDocker = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Docker context")
			.setDesc("Which Docker to use, if you keep more than one. Blank uses the current context.")
			.addText((t) =>
				t.setPlaceholder("colima-ctf")
					.setValue(this.plugin.settings.ctfContext)
					.onChange(async (v) => {
						this.plugin.settings.ctfContext = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Check the builder")
			.setDesc("Confirms Docker answers and the builder image is ready.")
			.addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					b.setDisabled(true).setButtonText("Testing…");
					try {
						const s = await this.plugin.sandbox.status();
						if (!s.ok) new Notice(`Recall Lab: ${s.error}`, 15000);
						else if (!s.builder) new Notice(`Docker ${s.server} is up. The builder image is not built yet; it is built the first time you ask for a challenge.`, 15000);
						else new Notice(`Docker ${s.server} is up, and the builder image is ready.`, 9000);
					} finally {
						b.setDisabled(false).setButtonText("Test");
					}
				})
			);

		new Setting(containerEl).setName("Folders").setHeading();

		const folder = (
			name: string,
			desc: string,
			key: "banksFolder" | "coursesFolder" | "labsFolder" | "progressFolder" | "labWorkspace"
		) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((t) =>
					t.setValue(this.plugin.settings[key]).onChange(async (v) => {
						this.plugin.settings[key] = v.trim();
						await this.plugin.saveSettings();
					})
				);

		folder("Banks", "Question bank JSON files.", "banksFolder");
		folder("Courses", "Course definitions — the folder each course covers, and its skill axes.", "coursesFolder");
		folder("Progress", "attempts.json (every answer, exam and lab result) and recall-lab.log.", "progressFolder");
	}
}
