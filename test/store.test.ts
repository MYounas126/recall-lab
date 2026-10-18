import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Store } from "../src/store";
import type { LabProgress, SessionSummary } from "../src/types";
import { makeVault } from "./helpers";

const PATH = "_quiz/progress/attempts.json";
const session: SessionSummary = {
	id: "s1", ts: "t", bankId: "b", tier: "mixed", asked: 0,
	meanScore: 0, grade: "F", weakTopics: [], coachingPending: true,
};
const lab: LabProgress = { labId: "lab1", attempts: 1, hintsUsed: 0, solvedAt: "now" };

function storeOn(vault: ReturnType<typeof makeVault>): Store {
	return new Store({ vault } as never, () => "_quiz/banks", () => "_quiz/progress");
}

test("changes made at the same moment are all kept", async () => {
	const vault = makeVault();
	const store = storeOn(vault);
	await store.recordSession([], session);
	await Promise.all([
		store.saveLabProgress(lab),
		store.markComplete("Notes/a.md"),
		store.saveCoaching("s1", "coaching text"),
	]);
	const data = JSON.parse(vault.files.get(PATH)!);
	assert.ok(data.labs?.lab1?.solvedAt, "lab progress was lost");
	assert.ok(data.completed?.["Notes/a.md"], "completion mark was lost");
	assert.equal(data.sessions[0].coaching, "coaching text");
	assert.equal(data.sessions[0].coachingPending, false);
});

test("completion marks and lab progress survive finishing an exam", async () => {
	const vault = makeVault(0);
	const store = storeOn(vault);
	await store.markComplete("Notes/a.md");
	await store.saveLabProgress(lab);
	await store.recordSession([], session);
	const data = JSON.parse(vault.files.get(PATH)!);
	assert.ok(data.completed?.["Notes/a.md"]);
	assert.ok(data.labs?.lab1);
});

test("fields this version does not know about are carried through", async () => {
	const vault = makeVault(0);
	vault.files.set(PATH, JSON.stringify({ version: 1, attempts: [], sessions: [], future: { kept: true } }));
	await storeOn(vault).markComplete("Notes/a.md");
	assert.deepEqual(JSON.parse(vault.files.get(PATH)!).future, { kept: true });
});

test("an empty read never shares state with the last one", async () => {
	const store = storeOn(makeVault(0));
	const first = await store.readProgress();
	first.completed!["leak.md"] = "x";
	const second = await store.readProgress();
	assert.equal(second.completed?.["leak.md"], undefined);
});

test("saveCoaching reports a session that no longer exists", async () => {
	const store = storeOn(makeVault(0));
	await store.recordSession([], session);
	assert.equal(await store.saveCoaching("gone", "x"), false);
});
