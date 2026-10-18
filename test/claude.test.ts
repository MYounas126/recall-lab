import { test } from "node:test";
import { strict as assert } from "node:assert";
import { extractJson } from "../src/claude";

const parsed = (reply: string) => {
	const json = extractJson(reply);
	return json === null ? null : JSON.parse(json);
};

test("extractJson finds a plain object", () => {
	assert.deepEqual(parsed('{"a":1}'), { a: 1 });
});

test("extractJson keeps an object that holds an array", () => {
	assert.deepEqual(parsed('{"labs":[{"x":1},{"y":2}]}'), { labs: [{ x: 1 }, { y: 2 }] });
});

test("extractJson keeps a top-level array of objects whole", () => {
	assert.deepEqual(parsed('[{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }]);
	assert.deepEqual(parsed('```json\n[{"a":1},{"b":2}]\n```'), [{ a: 1 }, { b: 2 }]);
});

test("extractJson is not fooled by brackets in prose", () => {
	assert.deepEqual(parsed('Sure [1]: {"a":1}'), { a: 1 });
	assert.deepEqual(parsed('[note] {"a":[1]} [end]'), { a: [1] });
});

test("extractJson returns null when there is no JSON", () => {
	assert.equal(extractJson("no json here"), null);
});
