import { test } from "node:test";
import { strict as assert } from "node:assert";
import { isMature, needingVariants, pickVariant, withVariants } from "../src/variants";
import { AnswerIndex } from "../src/history";
import { keyOf } from "../src/memory";
import { Tasks, checkVariant, variantPrompt } from "../src/tasks";
import { idOf, qkey, type Bank } from "../src/types";
import { attempt, makeVault, question } from "./helpers";

const ts = (day: number) => new Date(2026, 9, day, 9).toISOString();
const right = (day: number, extra = {}) => attempt("a", "q1", 100, ts(day), extra);
const variants = [question("q1~v1", { prompt: "first look" }), question("q1~v2", { prompt: "second look" })];
const q1 = question("q1", { variants });

test("a question is mature after two right answers running, not guesses", () => {
	assert.ok(!isMature([right(1)]));
	assert.ok(isMature([right(1), right(2)]));
	assert.ok(!isMature([right(1), attempt("a", "q1", 0, ts(2))]));
	assert.ok(!isMature([right(1), right(2, { confidence: "guess" })]), "a lucky guess does not count");
	assert.ok(isMature([attempt("a", "q1", 0, ts(1)), right(2), right(3)]), "only the last two matter");
});

test("variants rotate, least recently asked first", () => {
	assert.equal(pickVariant(q1, [right(1)]), null, "not mature yet");
	assert.equal(pickVariant(question("q2"), [right(1), right(2)]), null, "no variants to give");
	assert.equal(pickVariant(q1, [right(1), right(2)])!.id, "q1~v1");
	assert.equal(pickVariant(q1, [right(1), right(2), right(3, { variant: "q1~v1" })])!.id, "q1~v2");
	const both = [right(1), right(2), right(3, { variant: "q1~v1" }), right(4, { variant: "q1~v2" })];
	assert.equal(pickVariant(q1, both)!.id, "q1~v1");
});

test("a variant stands in for its original in the schedule", () => {
	const index = new AnswerIndex([right(1), right(2)]);
	const [item] = withVariants([{ bankId: "a", q: q1 }], index);
	assert.equal(item.q.id, "q1~v1");
	assert.equal(item.of, "q1");
	assert.equal(idOf(item), "q1");
	assert.equal(keyOf(item), qkey("a", "q1"));
	const [plain] = withVariants([{ bankId: "a", q: q1 }], new AnswerIndex([right(1)]));
	assert.equal(plain.of, undefined, "an immature question is asked as itself");
});

test("only mature questions without variants need them", () => {
	const bank: Bank = { id: "a", title: "A", questions: [q1, question("q2"), question("q3")] };
	const index = new AnswerIndex([
		right(1), right(2),
		attempt("a", "q2", 100, ts(1)), attempt("a", "q2", 100, ts(2)),
		attempt("a", "q3", 100, ts(1)),
	]);
	const need = needingVariants([bank], index);
	assert.deepEqual(need.map((n) => n.questions.map((q) => q.id)), [["q2"]]);
});

test("a variant must keep its original's type, and inherits what it tests", () => {
	const original = question("o", { tier: "hard", topic: "widths", axis: "regs", ref: "Note#Widths" });
	const good = question("x", { tier: "easy", topic: "other", axis: undefined, ref: undefined, choices: ["a", "b"], answer: 1 });
	assert.equal(checkVariant(original, good), null);
	assert.deepEqual([good.tier, good.topic, good.axis, good.ref], ["hard", "widths", "regs", "Note#Widths"]);
	assert.match(checkVariant(original, question("x", { type: "short" }))!, /not a mcq/);
	assert.match(checkVariant(original, question("x", { answer: 5 }))!, /answer index/);
	assert.match(checkVariant(question("s", { type: "short" }), question("x", { type: "short" }))!, /model answer/);
});

test("the variants prompt sends the questions but not their old variants", () => {
	const prompt = variantPrompt("Registers", "note", [q1], 2);
	assert.match(prompt, /Write 2 VARIANTS/);
	assert.ok(prompt.includes('"id": "q1"'));
	assert.ok(!prompt.includes("first look"), "existing variants are left out");
});

test("generated variants are checked, numbered and merged into the bank file", async () => {
	const vault = makeVault(0);
	const path = "_quiz/banks/a.json";
	const bank: Bank = { id: "a", title: "A", note: "C/a.md", questions: [question("q1"), question("q2")] };
	vault.files.set("C/a.md", "# A\n\nThe note.");
	vault.files.set(path, JSON.stringify(bank));
	const cli = {
		askJson: async () => {
			// An edit to the bank while Claude works must survive the write.
			const edited = { ...bank, questions: [...bank.questions, question("q3")] };
			vault.files.set(path, JSON.stringify(edited));
			return {
				ok: true,
				data: {
					variants: {
						q1: [
							{ type: "mcq", prompt: "Same idea, new look?", choices: ["no", "yes"], answer: 1, explain: "" },
							{ type: "short", prompt: "wrong type" },
						],
					},
				},
			};
		},
	};
	const tasks = new Tasks({ vault } as never, cli as never, {} as never, () => "normal", () => "_quiz/banks", () => "_quiz/courses");
	assert.equal(await tasks.generateVariants(bank, path, ["q1"]), 1);
	const saved = JSON.parse(vault.files.get(path)!) as Bank;
	assert.deepEqual(saved.questions.map((q) => q.id), ["q1", "q2", "q3"]);
	assert.equal(saved.questions[0].variants!.length, 1);
	assert.equal(saved.questions[0].variants![0].id, "q1~v1");
	assert.equal(saved.questions[1].variants, undefined);
});

test("a question rebuilt while its variants were written gets none of them", async () => {
	const vault = makeVault(0);
	const path = "_quiz/banks/a.json";
	const asked = question("q1", { prompt: "What does XOR EAX, EAX do?" });
	const bank: Bank = { id: "a", title: "A", questions: [asked] };
	vault.files.set(path, JSON.stringify(bank));
	const cli = {
		askJson: async () => {
			// "Rebuild this quiz" ran meanwhile: q1 now asks something else.
			const rebuilt = { ...bank, questions: [question("q1", { prompt: "Where does a function leave its result?" })] };
			vault.files.set(path, JSON.stringify(rebuilt));
			return { ok: true, data: { variants: { q1: [{ type: "mcq", prompt: "XOR again?", choices: ["a", "b"], answer: 0, explain: "" }] } } };
		},
	};
	const tasks = new Tasks({ vault } as never, cli as never, {} as never, () => "normal", () => "_quiz/banks", () => "_quiz/courses");
	const res = await tasks.generateVariants(bank, path, ["q1"]);
	assert.ok(typeof res === "object" && /changed/.test(res.error), JSON.stringify(res));
	assert.equal((JSON.parse(vault.files.get(path)!) as Bank).questions[0].variants, undefined);
});

test("a bank that cannot be read back is an error, not a throw", async () => {
	const vault = makeVault(0);
	const path = "_quiz/banks/a.json";
	const bank: Bank = { id: "a", title: "A", questions: [question("q1")] };
	vault.files.set(path, JSON.stringify(bank));
	const cli = {
		askJson: async () => {
			vault.files.set(path, "{ half a file");
			return { ok: true, data: { variants: { q1: [] } } };
		},
	};
	const tasks = new Tasks({ vault } as never, cli as never, {} as never, () => "normal", () => "_quiz/banks", () => "_quiz/courses");
	const res = await tasks.generateVariants(bank, path, ["q1"]);
	assert.ok(typeof res === "object" && /could not be read back/.test(res.error));
});

test("variants that are all unusable report an error and write nothing", async () => {
	const vault = makeVault(0);
	const path = "_quiz/banks/a.json";
	const bank: Bank = { id: "a", title: "A", questions: [question("q1")] };
	vault.files.set(path, JSON.stringify(bank));
	const cli = { askJson: async () => ({ ok: true, data: { variants: { q1: [{ type: "short", prompt: "x" }] } } }) };
	const tasks = new Tasks({ vault } as never, cli as never, {} as never, () => "normal", () => "_quiz/banks", () => "_quiz/courses");
	const res = await tasks.generateVariants(bank, path, ["q1"]);
	assert.ok(typeof res === "object" && /usable/.test(res.error));
	assert.equal(vault.files.get(path), JSON.stringify(bank));
});
