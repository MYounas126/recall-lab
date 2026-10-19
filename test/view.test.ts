import "./dom";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { RecallLabView } from "../src/view";
import { Store } from "../src/store";
import { LabStore, hashFlag } from "../src/labs";
import { DEFAULT_SETTINGS, type RecallLabSettings } from "../src/settings";
import type { Attempt, Bank, Course, Lab, Question, Tier } from "../src/types";
import { attempt, makeVault } from "./helpers";

// The Recall Lab view drawn in a DOM over an in-memory vault, the way it is
// drawn in Obsidian, to catch a screen that fails to draw and to check what
// the screens say.

const course: Course = {
	id: "arch", title: "Architecture", folder: "Arch",
	axes: [{ id: "regs", label: "Registers" }, { id: "flow", label: "Control flow" }, { id: "stack", label: "Stack" }],
};
const q = (id: string, tier: Tier): Question => ({
	id, tier, type: "mcq", topic: "t", axis: "regs", prompt: `Question ${id}`, choices: ["right", "wrong"], answer: 0, explain: "",
});
const bank: Bank = {
	id: "arch-01", title: "Arch · 01", note: "Arch/01 Intro.md",
	questions: [q("e1", "easy"), q("e2", "easy"), q("e3", "easy"), q("e4", "easy"), q("h1", "hard"), q("h2", "hard"), q("b1", "brutal")],
};
const lab: Lab = {
	id: "lab-1", courseId: "arch", note: "Arch/01 Intro.md", title: "Register windows", axis: "regs", tier: "easy",
	brief: "Work out what RBX holds.", setup: "", files: [{ path: "src/easy.c", content: "int main(void) { return 0; }\n" }],
	hints: ["Mind the width."], flagHash: hashFlag("flag{abc}"), flagFormat: "flag{...}", solution: "Trace it.", minutes: 20,
};

/** A vault with one course, one quiz, a lab and two notes, one of them with a highlight. */
function vaultFiles(attempts: Attempt[] = []): Record<string, string> {
	return {
		"_quiz/courses/arch.json": JSON.stringify(course),
		"_quiz/banks/arch-01.json": JSON.stringify(bank),
		"_quiz/labs/lab-1.json": JSON.stringify(lab),
		"_quiz/progress/attempts.json": JSON.stringify({ attempts, sessions: [] }),
		"Arch/01 Intro.md": "# Intro\n\nThe ==instruction pointer== holds the address of the next instruction.\n",
		"Arch/02 Registers.md": "# Registers\n\nNothing highlighted here.\n",
	};
}

const answered = (...ids: string[]) => ids.map((id, i) => attempt("arch-01", id, 100, new Date(Date.now() - (10 - i) * 60_000).toISOString()));

/** The parts of the view these tests drive and read, private as they are. */
interface View {
	screen: string;
	selectedFolder: string | null;
	openLab: Lab | null;
	banks: Bank[];
	allLabs: Lab[];
	examItems: { q: Question }[];
	answers: unknown[];
	contentEl: HTMLElement;
	containerEl: HTMLElement;
	onOpen(): Promise<void>;
	render(): Promise<void>;
	beginExam(bank: Bank, full: boolean): Promise<void>;
	startReview(): Promise<void>;
}

interface Drawn {
	view: View;
	root: HTMLElement;
	errors: string[];
}

async function open(files: Record<string, string>, settings: Partial<RecallLabSettings> = {}): Promise<Drawn> {
	const vault = makeVault(0);
	for (const [path, body] of Object.entries(files)) vault.files.set(path, body);
	const app = { vault, workspace: { openLinkText: async () => {} } } as never;
	const s: RecallLabSettings = { ...DEFAULT_SETTINGS, recallFirst: false, ...settings };
	const errors: string[] = [];
	const plugin = {
		settings: s,
		store: new Store(app, () => s.banksFolder, () => s.progressFolder, () => s.coursesFolder),
		labs: new LabStore(app, () => s.labsFolder, () => s.labWorkspace),
		log: { info() {}, error: (msg: string, extra?: unknown) => errors.push(`${msg} ${JSON.stringify(extra ?? {})}`) },
		cli: { locate: async () => "/usr/local/bin/claude" },
		tasks: { coachSession: async () => "Keep going." },
		bulkRunning: false,
		saveSettings: async () => {},
		refreshMemoryViews: async () => {},
	};
	const view = new RecallLabView({ app } as never, plugin as never) as unknown as View;
	document.body.appendChild(view.containerEl);
	await view.onOpen();
	return { view, root: view.contentEl, errors };
}

/** What the view shows when a screen throws. */
const crashed = (root: HTMLElement) => [...root.querySelectorAll("h2")].some((h) => h.textContent === "Recall Lab hit an error");
const button = (root: Element, text: string) =>
	[...root.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement | undefined;

/** Waits for work the view starts without waiting for it, such as marking an answer. */
async function until<T>(find: () => T | null | undefined): Promise<T> {
	for (let i = 0; i < 400; i++) {
		const found = find();
		if (found) return found;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("timed out waiting for the view");
}

const tiersOf = (items: { q: Question }[]) => [...new Set(items.map((it) => it.q.tier))].sort();

test("every screen draws without an error", async () => {
	const { view, root, errors } = await open(vaultFiles(answered("e1")));
	const screens: [string, () => Promise<void>][] = [
		["overview", async () => { view.screen = "home"; await view.render(); }],
		["history", async () => { view.screen = "history"; await view.render(); }],
		["course", async () => { view.screen = "folder"; view.selectedFolder = "Arch"; await view.render(); }],
		["exam", () => view.beginExam(view.banks[0], false)],
		["lab", async () => { view.openLab = view.allLabs[0]; view.screen = "lab"; await view.render(); }],
		["today's review", () => view.startReview()],
	];
	for (const [name, go] of screens) {
		await go();
		assert.ok(!crashed(root), `${name} drew the error page`);
		assert.deepEqual(errors, [], `${name} logged an error`);
	}
	assert.equal(view.answers.length, 0);
});

test("a quiz with locked tiers wears a padlock that says what opens them", async () => {
	const { view, root } = await open(vaultFiles(answered("e1")));
	view.screen = "folder";
	view.selectedFolder = "Arch";
	await view.render();
	const row = root.querySelector('.rl-note-row[data-path="Arch/01 Intro.md"]')!;
	const chip = row.querySelector(".rl-chip-locked")!;
	assert.ok(chip.querySelector('svg[data-icon="lock"]'));
	assert.equal(
		chip.getAttribute("aria-label"),
		"Hard and Brutal are locked. Hard opens once you own 80% of this quiz's Easy questions; you own 25%."
	);
	assert.match(root.textContent!, /Hard is open in 0 of 1 quiz, Brutal in 0 of 1 quiz\./);
	assert.ok(button(root, "Full exam (every open tier)"));
});

test("an exam leaves locked tiers out and says why, and Include locked tiers brings them back", async () => {
	const { view, root } = await open(vaultFiles(answered("e1")), { highlightClozes: false });
	await view.beginExam(view.banks[0], false);
	assert.deepEqual(tiersOf(view.examItems), ["easy"]);
	assert.match(root.querySelector(".rl-gate-text")!.textContent!, /^Hard and Brutal are locked\./);
	button(root, "Include locked tiers")!.click();
	await until(() => view.examItems.some((it) => it.q.tier !== "easy"));
	assert.deepEqual(tiersOf(view.examItems), ["brutal", "easy", "hard"]);
	assert.equal(root.querySelector(".rl-gate-note"), null, "nothing is left out now");
});

test("with the gate binding, the exam offers no way round it", async () => {
	const { view, root } = await open(vaultFiles(answered("e1")), { allowOverride: false });
	await view.beginExam(view.banks[0], false);
	assert.ok(root.querySelector(".rl-gate-note"));
	assert.equal(button(root, "Include locked tiers"), undefined);
});

test("answering enough of Easy opens Hard, and the results say so", async () => {
	// Three of four Easy questions owned is 75%, short of 80%.
	const { view, root } = await open(vaultFiles(answered("e1", "e2", "e3")), { highlightClozes: false, defaultLength: 1 });
	await view.beginExam(view.banks[0], false);
	assert.equal(view.examItems[0].q.id, "e4", "the one Easy question not seen yet");
	const choice = [...root.querySelectorAll(".rl-choice")].find((c) => c.querySelector("label")?.textContent === "right")!;
	choice.querySelector("input")!.click();
	button(root, "Submit")!.click();
	(await until(() => button(root, "Finish"))).click();
	const news = await until(() => root.querySelector(".rl-gate-news"));
	assert.equal(news.textContent, "Hard is now open in Arch · 01.");
	assert.ok(root.querySelector(".rl-results"));
});

test("your highlights count as new questions before their note is complete", async () => {
	const { view, root } = await open(vaultFiles());
	view.screen = "home";
	await view.render();
	assert.match(root.querySelector(".rl-review-panel")!.textContent!, /0 due · 1 new/);
});
