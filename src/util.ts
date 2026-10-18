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
