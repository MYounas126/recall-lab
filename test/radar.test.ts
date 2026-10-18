import { test } from "node:test";
import { strict as assert } from "node:assert";
import { AxisScore, renderRadar, wrapLabel } from "../src/radar";
import { MockEl } from "./helpers";

const axis = (id: string, label: string, score: number, total = 10, seen = 5): AxisScore =>
	({ axis: { id, label }, score, total, seen });

const scores = [
	axis("dyn", "Dynamic Analysis & Instrumentation (adb, Emulator, Frida)", 62),
	axis("xss", '<b>Markup</b> "quoted"', 0, 10, 0),
	axis("static", "Static Analysis", 88),
	axis("none", "Nothing Yet", 0, 0, 0),
];

function draw(s: AxisScore[]): MockEl {
	const root = new MockEl("div");
	renderRadar(root as unknown as HTMLElement, s);
	return root;
}

test("the radar draws rings, spokes, one shape and a dot per axis", () => {
	const all = draw(scores).all();
	const count = (tag: string, cls: string) => all.filter((e) => e.tag === tag && e.cls.includes(cls)).length;
	assert.equal(count("polygon", "rl-radar-ring"), 4);
	assert.equal(count("line", "rl-radar-spoke"), 4);
	assert.equal(count("polygon", "rl-radar-shape"), 1);
	assert.equal(count("circle", "rl-radar-dot"), 4);
	assert.equal(count("circle", "rl-radar-dot-untested"), 2);
});

test("axis labels stay text and are never parsed as markup", () => {
	const texts = draw(scores).all().filter((e) => e.tag === "text").map((e) => e.textContent);
	assert.ok(texts.includes('<b>Markup</b> "quoted"'));
	assert.ok(texts.includes("62%"));
	assert.ok(texts.includes("not tested yet"));
	assert.ok(texts.includes("no questions yet"));
});

test("fewer than three axes explains itself instead of drawing", () => {
	const root = draw(scores.slice(0, 2));
	assert.equal(root.children.length, 1);
	assert.ok(root.children[0].cls.includes("rl-radar-empty"));
	assert.match(root.children[0].textContent ?? "", /at least three/);
});

test("long labels wrap to at most three lines", () => {
	const lines = wrapLabel("Network Traffic Interception and TLS Pinning Bypass Techniques Overall", 22);
	assert.ok(lines.length <= 3);
	assert.ok(lines.every((l) => l.length <= 22));
});
