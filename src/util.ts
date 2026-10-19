/** A short stable id for a piece of text: 32-bit FNV-1a, as 8 hex digits. */
export function hashText(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/**
 * Text from a value parsed out of Claude's JSON: a string as it is, a number
 * or boolean written out, and anything else (an object, a list) as nothing,
 * never "[object Object]".
 */
export function textOf(v: unknown): string {
	return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
}

/** Fisher-Yates, on a copy. */
export function shuffled<T>(arr: T[]): T[] {
	const out = arr.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/**
 * Runs async jobs one at a time, in the order they were queued. A job that
 * throws rejects its own promise but never stalls the jobs behind it.
 */
export class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve();
	private depth = 0;

	/** True while a job is running or waiting to. */
	get busy(): boolean {
		return this.depth > 0;
	}

	run<T>(job: () => Promise<T>): Promise<T> {
		this.depth += 1;
		const result = this.tail.then(job).finally(() => { this.depth -= 1; });
		this.tail = result.catch(() => undefined);
		return result;
	}
}
