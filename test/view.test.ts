import "./dom";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { ChallengeModal, RecallLabView } from "../src/view";
import { Modal } from "./obsidian-shim";
import { Store } from "../src/store";
import { LabStore, hashFlag } from "../src/labs";
import { DEFAULT_SETTINGS, type RecallLabSettings } from "../src/settings";
import type { Attempt, Bank, Course, Lab, Question, Tier } from "../src/types";
import { PWN_CFLAGS, PWN_PROTECTIONS } from "../src/pwn";
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

/** A compiled challenge to reverse: its source is the answer, so the page must not show it. */
const binaryLab: Lab = {
	id: "ctf-1", courseId: "arch", note: "Arch/01 Intro.md", title: "Slot Machine", axis: "regs", tier: "easy",
	kind: "binary", build: { cflags: ["-O2", "-s"], output: "slot" },
	brief: "Find the input it wants.", setup: "", files: [{ path: "src/crackme.c", content: "SECRET_SOURCE_MARKER" }],
	hints: ["Follow the table index."], flagHash: hashFlag("flag{slot}"), flagFormat: "flag{...}",
	solution: "Invert the table.", minutes: 45,
};

/** An exploitation challenge: a vulnerable program with a win path to reach. */
const pwnLab: Lab = {
	id: "pwn-1", courseId: "arch", note: "Arch/01 Intro.md", title: "Frame of Mine", axis: "stack", tier: "brutal",
	kind: "pwn", build: { cflags: PWN_CFLAGS.brutal, output: "stack" },
	brief: "Reach the win path.", setup: "", files: [{ path: "src/pwn.c", content: "VULNERABLE_SOURCE_MARKER" }],
	hints: ["Count to the saved return address."], flagHash: hashFlag("flag{pwned}"), flagFormat: "flag{...}",
	solution: "Overwrite the saved return address.", minutes: 60,
};

/** A vault with one course, one quiz, a lab and two notes, one of them with a highlight. */
function vaultFiles(attempts: Attempt[] = []): Record<string, string> {
	return {
		"_quiz/courses/arch.json": JSON.stringify(course),
		"_quiz/banks/arch-01.json": JSON.stringify(bank),
		"_quiz/labs/lab-1.json": JSON.stringify(lab),
		"_quiz/labs/ctf-1.json": JSON.stringify(binaryLab),
		"_quiz/labs/pwn-1.json": JSON.stringify(pwnLab),
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
	courses: Course[];
	beginExam(bank: Bank, full: boolean): Promise<void>;
	startReview(): Promise<void>;
}

interface Drawn {
	view: View;
	root: HTMLElement;
	errors: string[];
	vault: ReturnType<typeof makeVault>;
	/** What the view asked the plugin to build, in order. */
	asked: { note: string; kind: string }[];
}

async function open(files: Record<string, string>, settings: Partial<RecallLabSettings> = {}): Promise<Drawn> {
	const vault = makeVault(0);
	for (const [path, body] of Object.entries(files)) vault.files.set(path, body);
	const app = { vault, workspace: { openLinkText: async () => {} } } as never;
	const s: RecallLabSettings = { ...DEFAULT_SETTINGS, recallFirst: false, ...settings };
	const errors: string[] = [];
	const asked: { note: string; kind: string }[] = [];
	const plugin = {
		offerChallenge: async (note: string, kind: string) => { asked.push({ note, kind }); },
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
	return { view, root: view.contentEl, errors, vault, asked };
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

test("on a lab, a wrong flag counts once, the right one solves it, and both are saved", async () => {
	const { view, root, vault } = await open(vaultFiles());
	// By id, not by position: the vault holds binary challenges too, and labs are sorted by title.
	view.openLab = view.allLabs.find((l) => l.id === "lab-1")!;
	view.screen = "lab";
	await view.render();
	const box = () => root.querySelector('input[placeholder="flag{...}"]') as HTMLInputElement;
	const verdict = () => root.querySelector(".rl-flag-verdict")!.textContent ?? "";
	const submit = (flag: string) => { box().value = flag; button(root, "Check")!.click(); };

	submit("flag{nope}");
	await until(() => verdict().includes("1 wrong"));
	assert.equal(verdict(), "Not the flag. 1 wrong so far.");
	assert.ok(root.querySelector(".rl-flag-wrong"));

	submit("  flag{nope} ");
	await until(() => verdict().startsWith("You already tried"));
	assert.equal(verdict(), "You already tried that one. 1 wrong so far.", "the same guess again costs nothing");

	box().value = "flag{still-wrong}";
	box().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
	await until(() => verdict().includes("2 wrong"));

	submit("flag{abc}");
	await until(() => root.querySelector(".rl-flag-right"));
	assert.equal(verdict(), "Correct: solved, 95%.", "one wrong flag past the free one costs 5%");
	assert.ok(box().disabled, "a solved lab takes no more flags");

	const saved = JSON.parse(vault.files.get("_quiz/progress/attempts.json")!).labs["lab-1"];
	assert.equal(saved.attempts, 2);
	assert.ok(saved.solvedAt);
	assert.equal(saved.wrongFlags.length, 2);
	assert.ok(saved.wrongFlags.every((h: string) => /^[0-9a-f]{64}$/.test(h)), "wrong guesses are kept only as hashes");
});


// ----------------------------------------------- binary and pwn lab pages

/** Opens a lab's page and hands back what was drawn. */
async function openLab(id: string, settings: Partial<RecallLabSettings> = {}) {
	const drawn = await open(vaultFiles(), settings);
	drawn.view.openLab = drawn.view.allLabs.find((l) => l.id === id)!;
	drawn.view.screen = "lab";
	await drawn.view.render();
	return drawn;
}

test("a reversing challenge points at its binary and keeps its source hidden", async () => {
	const { view, root, errors } = await openLab("ctf-1");
	assert.ok(!crashed(root));
	assert.deepEqual(errors, []);
	assert.match(root.textContent!, /The challenge/);
	assert.match(root.textContent!, /An x86-64 Linux binary\./, "a reversing challenge, described as one");
	assert.ok(root.textContent!.includes("/slot"), "it says where the binary is");
	assert.ok(!root.textContent!.includes("SECRET_SOURCE_MARKER"), "the source is the answer, so it stays hidden");
	assert.ok(button(root, "Copy the path"));
	assert.ok(button(root, "Give up and show the solution"), "the way out is offered");
	assert.ok(!root.textContent!.includes("Built with:"), "protections are a pwn thing");
	void view;
});

test("an exploitation challenge says it has symbols, a win path, and what it was built with", async () => {
	const { root, errors } = await openLab("pwn-1");
	assert.ok(!crashed(root));
	assert.deepEqual(errors, []);
	assert.match(root.textContent!, /with symbols/);
	assert.match(root.textContent!, /`win` function that prints the flag and is never called on its own/);
	assert.ok(root.textContent!.includes(`Built with: ${PWN_PROTECTIONS.brutal}`), "the tier's protections, stated");
	assert.ok(!root.textContent!.includes("VULNERABLE_SOURCE_MARKER"), "its source stays hidden too");
	assert.ok(root.textContent!.includes("/stack"), "it says where the binary is");
});

test("a challenge whose binary has gone offers to build it again", async () => {
	const { root } = await openLab("pwn-1");
	// Nothing was ever written to the workspace, so the binary is missing.
	assert.match(root.textContent!, /The binary is not on disk/);
	assert.ok(button(root, "Rebuild it"));
});

test("giving up reveals the source, which is how it was built", async () => {
	const { view, root } = await openLab("pwn-1");
	button(root, "Give up and show the solution")!.click();
	await until(() => view.contentEl.textContent!.includes("VULNERABLE_SOURCE_MARKER"));
	assert.match(view.contentEl.textContent!, /how it was built/);
	assert.match(view.contentEl.textContent!, /How it was meant to go/, "and the walkthrough");
});

// ------------------------------------------------- building a new challenge

test("a course with no labs yet offers the same two buttons, by the same names", async () => {
	// The empty state used to name the same action differently, so the course
	// you most need to start on read as a different feature.
	const bare = vaultFiles();
	delete bare["_quiz/labs/lab-1.json"];
	delete bare["_quiz/labs/ctf-1.json"];
	delete bare["_quiz/labs/pwn-1.json"];
	const { view, root, errors } = await open(bare);
	view.screen = "folder";
	view.selectedFolder = "Arch";
	await view.render();
	assert.ok(!crashed(root));
	assert.deepEqual(errors, []);
	assert.match(root.textContent!, /No labs yet/);
	assert.ok(button(root, "Reversing challenge…"), "named as it is everywhere else");
	assert.ok(button(root, "Exploitation challenge…"));
});

test("a course offers both kinds of challenge, and the labs panel lists what exists", async () => {
	const { view, root, errors } = await open(vaultFiles());
	view.screen = "folder";
	view.selectedFolder = "Arch";
	await view.render();
	assert.ok(!crashed(root));
	assert.deepEqual(errors, []);
	assert.ok(button(root, "Reversing challenge…"), "a way to build one to reverse");
	assert.ok(button(root, "Exploitation challenge…"), "and one to exploit");
	assert.match(root.textContent!, /Slot Machine/);
	assert.match(root.textContent!, /Frame of Mine/);
});

test("picking a kind opens a note picker, which passes the note and the kind on", async () => {
	const { view, root, asked } = await open(vaultFiles());
	view.screen = "folder";
	view.selectedFolder = "Arch";
	await view.render();

	button(root, "Exploitation challenge…")!.click();
	const picker = await until(() => Modal.opened[Modal.opened.length - 1]);
	assert.match(picker.contentEl.textContent!, /Which note\?/);
	const names = () => [...picker.contentEl.querySelectorAll(".rl-pick-name")].map((r) => r.textContent);
	// 01 Intro already carries a pwn challenge, so the bare note is offered first.
	assert.deepEqual(names(), ["02 Registers", "01 Intro"]);

	([...picker.contentEl.querySelectorAll(".rl-pick-row")][0] as HTMLElement).click();
	assert.deepEqual(asked, [{ note: "Arch/02 Registers.md", kind: "pwn" }], "the note picked, and the kind asked for");
	assert.equal(Modal.opened.includes(picker), false, "the picker closes behind itself");

	button(root, "Reversing challenge…")!.click();
	const second = await until(() => Modal.opened[Modal.opened.length - 1]);
	([...second.contentEl.querySelectorAll(".rl-pick-row")][1] as HTMLElement).click();
	assert.deepEqual(asked[1], { note: "Arch/01 Intro.md", kind: "binary" });
	Modal.opened.slice().forEach((m) => m.close());
});

test("the note picker says what each note already has, and why the order is what it is", async () => {
	const { view, root } = await open(vaultFiles());
	view.screen = "folder";
	view.selectedFolder = "Arch";
	await view.render();
	button(root, "Reversing challenge…")!.click();
	const picker = await until(() => Modal.opened[Modal.opened.length - 1]);

	const rows = [...picker.contentEl.querySelectorAll(".rl-pick-row")].map((r) => ({
		name: r.querySelector(".rl-pick-name")!.textContent,
		has: (r.querySelector(".rl-pick-has") ?? r.querySelector(".rl-pick-bare"))!.textContent,
	}));
	assert.deepEqual(rows[0], { name: "02 Registers", has: "nothing yet" }, "a note with nothing, said plainly");
	// 01 Intro: a 7-question quiz plus the question made from its one ==highlight==,
	// then a source lab, a reversing challenge and a pwn one.
	assert.deepEqual(rows[1], { name: "01 Intro", has: "8 q · 1 lab · 1 reversing · 1 pwn" });
	assert.match(picker.contentEl.textContent!, /Notes with none of these yet come first/);
	Modal.opened.slice().forEach((m) => m.close());
});

test("the tier picker says what each tier means, and differs by kind", () => {
	const picked: Tier[] = [];
	const pwn = new ChallengeModal({} as never, "05 The Stack", "pwn", (t) => picked.push(t));
	pwn.open();
	assert.match(pwn.contentEl.textContent!, /Build an exploitation challenge from "05 The Stack"/);
	assert.match(pwn.contentEl.textContent!, /Writing the exploit is yours/, "it is clear what Recall Lab will not do");
	for (const tier of ["Easy", "Hard", "Brutal"]) assert.ok(button(pwn.contentEl, tier), tier);
	assert.equal(
		button(pwn.contentEl, "Brutal")!.getAttribute("aria-label"),
		PWN_PROTECTIONS.brutal,
		"each tier says what it leaves you facing"
	);
	button(pwn.contentEl, "Hard")!.click();
	assert.deepEqual(picked, ["hard"], "the tier chosen is the tier passed on");
	assert.equal(Modal.opened.includes(pwn), false, "and it closes behind itself");

	const rev = new ChallengeModal({} as never, "03 Registers", "binary", () => {});
	rev.open();
	assert.match(rev.contentEl.textContent!, /Build a reversing challenge/);
	assert.match(rev.contentEl.textContent!, /binary to reverse with your own tools/);
	assert.ok(!rev.contentEl.textContent!.includes("Writing the exploit is yours"));
	rev.close();
});


// ------------------------------------------------ what was done by hand

test("the radar shows what was done by hand beside what can be answered", async () => {
	// One lab solved on Registers, one opened on Stack, and questions answered on both.
	const files = vaultFiles(answered("e1", "e2", "e3", "e4", "h1", "h2"));
	files["_quiz/progress/attempts.json"] = JSON.stringify({
		attempts: JSON.parse(files["_quiz/progress/attempts.json"]).attempts,
		sessions: [],
		labs: {
			"ctf-1": { labId: "ctf-1", attempts: 1, hintsUsed: 0, solvedAt: "2026-10-20T10:00:00.000Z" },
			"pwn-1": { labId: "pwn-1", attempts: 0, hintsUsed: 0, firstOpenedAt: "2026-10-20T09:00:00.000Z" },
		},
	});
	const { view, root, errors } = await open(files);
	view.screen = "folder";
	view.selectedFolder = "Arch";
	await view.render();
	assert.ok(!crashed(root));
	assert.deepEqual(errors, []);

	const rows = [...root.querySelectorAll(".rl-legend-row")].map((r) => ({
		label: r.querySelector(".rl-legend-label")!.textContent,
		hands: r.querySelector(".rl-legend-hands")?.textContent ?? null,
	}));
	const regs = rows.find((r) => r.label === "Registers")!;
	// lab-1 and ctf-1 both sit on the regs axis; one of them is solved.
	// attempts: 1 is the free first wrong flag, so it still scores 100.
	assert.equal(regs.hands, "1 of 2 solved · 100% · hardest easy");
	const stack = rows.find((r) => r.label === "Stack")!;
	assert.equal(stack.hands, "1 of 1 open", "opened and not finished reads differently from never touched");
	const flow = rows.find((r) => r.label === "Control flow")!;
	assert.equal(flow.hands, "no labs yet");
});

test("an area answered well but never done by hand is called out", async () => {
	const files = vaultFiles(answered("e1", "e2", "e3", "e4", "h1", "h2", "b1"));
	const { view, root } = await open(files);
	view.screen = "folder";
	view.selectedFolder = "Arch";
	await view.render();
	// Nothing is solved, and Registers has questions answered and labs waiting.
	assert.match(root.textContent!, /Answered well but never done by hand: Registers/);
	assert.match(root.textContent!, /not the same as having taken one apart/);
});
