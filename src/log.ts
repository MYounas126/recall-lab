import { App, TFile, normalizePath } from "obsidian";

const MAX_LINES = 400;

/**
 * A plain-text log inside the vault. It exists so that a failure can be read
 * back later — by the user, or by Claude over the vault connection — instead of
 * vanishing into the developer console.
 */
export class Log {
	private queue: string[] = [];
	private flushing = false;

	constructor(private app: App, private path: () => string) {}

	private file(): string {
		return normalizePath(`${this.path()}/recall-lab.log`);
	}

	info(msg: string, extra?: Record<string, unknown>): void {
		this.write("INFO ", msg, extra);
	}

	error(msg: string, extra?: Record<string, unknown>): void {
		this.write("ERROR", msg, extra);
	}

	private write(level: string, msg: string, extra?: Record<string, unknown>): void {
		const detail = extra
			? " " + Object.entries(extra).map(([k, v]) => `${k}=${short(v)}`).join(" ")
			: "";
		this.queue.push(`${new Date().toISOString()} ${level} ${msg}${detail}`);
		void this.flush();
	}

	/** Writes become possible only once the workspace is ready. */
	ready = false;

	open(): void {
		this.ready = true;
		void this.flush();
	}

	private async flush(): Promise<void> {
		if (!this.ready || this.flushing || !this.queue.length) return;
		this.flushing = true;
		const lines = this.queue.splice(0, this.queue.length);
		try {
			const path = this.file();
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				const old = (await this.app.vault.read(existing)).split("\n");
				const next = [...old, ...lines].filter(Boolean).slice(-MAX_LINES);
				await this.app.vault.modify(existing, next.join("\n") + "\n");
			} else {
				await this.ensureFolder();
				await this.app.vault.create(path, lines.join("\n") + "\n");
			}
		} catch (e) {
			// Put them back rather than losing them; a later flush may succeed.
			this.queue.unshift(...lines);
			if (this.queue.length > MAX_LINES) this.queue.splice(0, this.queue.length - MAX_LINES);
			console.error("Recall Lab: could not write its log", e);
		} finally {
			this.flushing = false;
			if (this.queue.length) void this.flush();
		}
	}

	private async ensureFolder(): Promise<void> {
		const parts = normalizePath(this.path()).split("/").filter(Boolean);
		let acc = "";
		for (const part of parts) {
			acc = acc ? `${acc}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(acc)) {
				try { await this.app.vault.createFolder(acc); } catch { /* raced */ }
			}
		}
	}
}

function short(v: unknown): string {
	const s = typeof v === "string" ? v : JSON.stringify(v);
	const one = String(s ?? "").replace(/\s+/g, " ").trim();
	return one.length > 300 ? one.slice(0, 300) + "…" : one;
}
