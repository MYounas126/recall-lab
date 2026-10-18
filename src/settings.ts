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
			.setName("Path to the claude binary")
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

		new Setting(containerEl).setName("Progression").setHeading();

		new Setting(containerEl)
			.setName("Mastery needed to unlock Hard")
			.setDesc(
				"Percent mastery of the Easy tier. Unanswered questions count as zero, so you have to cover the tier, not just score well on the few you tried."
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
			.setDesc("Percent mastery of the Hard tier.")
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
			.setDesc("Keeps the gate advisory rather than binding.")
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
