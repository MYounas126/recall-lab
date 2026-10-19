import { spawn } from "child_process";
import * as os from "os";
import { textOf } from "./util";

export interface ClaudeReply {
	ok: boolean;
	/** The model's text, with any markdown fence stripped. */
	text: string;
	error?: string;
	costUsd?: number;
}

const WINDOWS = process.platform === "win32";

const CANDIDATES = WINDOWS
	? [`${os.homedir()}\\.local\\bin\\claude.exe`]
	: [
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
		"/usr/bin/claude",
		`${os.homedir()}/.local/bin/claude`,
		`${os.homedir()}/.claude/local/claude`,
		`${os.homedir()}/.bun/bin/claude`,
	];

/**
 * How to get the CLI, for every message that says it is missing. On Windows
 * an npm install gives only claude.cmd, which cannot be spawned without a
 * shell, so only the native installer's claude.exe works.
 */
export const INSTALL_HINT = WINDOWS
	? "Install Claude Code with its native installer, then set the path to claude.exe in Recall Lab settings. " +
		"An npm install only provides claude.cmd, which Recall Lab cannot start."
	: "Install it with: npm install -g @anthropic-ai/claude-code";

/**
 * Runs the Claude Code CLI headlessly, as the signed-in user. No API key: the
 * CLI uses the same credentials as the desktop app. The plugin does all file
 * I/O itself, so Claude is given no tools and needs no permissions.
 */
export class ClaudeCli {
	private resolved: string | null | undefined;
	/** Set by the plugin so failures end up somewhere readable. */
	onLog: (level: "info" | "error", msg: string, extra?: Record<string, unknown>) => void = () => {};

	constructor(
		private override: () => string,
		private model: () => string
	) {}

	/** Absolute path to the binary, or null if it cannot be found. */
	async locate(): Promise<string | null> {
		if (this.resolved !== undefined) return this.resolved;

		const manual = this.override().trim();
		if (manual) {
			this.resolved = (await this.works(manual)) ? manual : null;
			return this.resolved;
		}
		for (const path of CANDIDATES) {
			if (await this.works(path)) {
				this.resolved = path;
				this.onLog("info", "found the Claude CLI", { path });
				return path;
			}
		}
		// A GUI app does not inherit the shell PATH, so ask a login shell. On
		// Windows there is no login shell; where.exe reads the real PATH.
		try {
			const found = WINDOWS
				? await this.run("where.exe", ["claude"], "", 15000)
				: await this.run(process.env.SHELL || "/bin/zsh", ["-lc", "command -v claude"], "", 15000);
			const hits = found.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
			// where.exe also lists an npm install's claude.cmd, which cannot be
			// spawned without a shell, so only an .exe counts there.
			const path = WINDOWS ? hits.find((h) => /\.exe$/i.test(h)) : hits.pop();
			if (path && (await this.works(path))) {
				this.resolved = path;
				this.onLog("info", "found the Claude CLI via the login shell", { path });
				return path;
			}
		} catch (e) {
			this.onLog("error", "login-shell lookup for the CLI failed", { error: String(e) });
		}
		this.resolved = null;
		this.onLog("error", "could not find the Claude CLI", { tried: CANDIDATES.join(", ") });
		return null;
	}

	/** Forget a cached lookup, so a newly installed CLI is picked up. */
	forget(): void { this.resolved = undefined; }

	private async works(path: string): Promise<boolean> {
		try {
			const r = await this.run(path, ["--version"], "", 15000);
			return r.code === 0 && /\d+\.\d+/.test(r.stdout);
		} catch (e) {
			// ENOENT for a path that is not there is the normal case, not a fault.
			const code = (e as { code?: string })?.code;
			if (code && code !== "ENOENT") this.onLog("error", "probing the CLI failed", { path, error: String(e) });
			return false;
		}
	}

	/** Sends a prompt and returns the reply text. */
	async ask(prompt: string, timeoutMs = 300000): Promise<ClaudeReply> {
		const bin = await this.locate();
		if (!bin) {
			return { ok: false, text: "", error: `The Claude Code CLI was not found. ${INSTALL_HINT}` };
		}

		const args = [
			"-p",
			"--output-format", "json",
			"--model", this.model(),
			"--strict-mcp-config",     // do not load the vault's MCP servers
			"--no-session-persistence",
			"--allowedTools", "",      // Claude needs no tools; the plugin writes files
		];

		const started = Date.now();
		this.onLog("info", "calling Claude", { model: this.model(), promptChars: prompt.length });

		let res;
		try {
			res = await this.run(bin, args, prompt, timeoutMs);
		} catch (e) {
			this.onLog("error", "could not start the Claude CLI", { bin, error: String(e) });
			return { ok: false, text: "", error: `Could not start ${bin}: ${String(e)}` };
		}
		const secs = Math.round((Date.now() - started) / 100) / 10;
		if (res.timedOut) {
			this.onLog("error", "Claude timed out", { secs });
			return { ok: false, text: "", error: `Claude did not answer within ${Math.round(timeoutMs / 1000)}s.` };
		}

		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(res.stdout) as Record<string, unknown>;
		} catch {
			const tail = (res.stderr || res.stdout).trim().slice(-400);
			this.onLog("error", "the CLI did not return JSON", { code: res.code, secs, tail });
			return { ok: false, text: "", error: tail || `Claude exited with code ${res.code}.` };
		}
		if (parsed.is_error) {
			this.onLog("error", "Claude reported an error", { secs, result: textOf(parsed.result) });
			return { ok: false, text: "", error: textOf(parsed.result) || "Claude reported an error." };
		}
		this.onLog("info", "Claude replied", { secs, costUsd: parsed.total_cost_usd, chars: textOf(parsed.result).length });
		return {
			ok: true,
			text: stripFence(textOf(parsed.result)),
			costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined,
		};
	}

	/** Sends a prompt and parses the reply as JSON. */
	async askJson<T>(prompt: string, timeoutMs = 300000): Promise<{ ok: true; data: T; costUsd?: number } | { ok: false; error: string }> {
		const reply = await this.ask(prompt, timeoutMs);
		if (!reply.ok) return { ok: false, error: reply.error ?? "unknown error" };
		const json = extractJson(reply.text);
		if (!json) return { ok: false, error: `Claude did not return JSON. It said: ${reply.text.slice(0, 300)}` };
		try {
			return { ok: true, data: JSON.parse(json) as T, costUsd: reply.costUsd };
		} catch (e) {
			return { ok: false, error: `Claude returned malformed JSON (${String(e)}).` };
		}
	}

	private run(
		cmd: string,
		args: string[],
		stdin: string,
		timeoutMs: number
	): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
		return new Promise((resolve, reject) => {
			let child;
			try {
				child = spawn(cmd, args, {
					env: {
						...process.env,
						// The usual install dirs, which a GUI app's PATH lacks. Not on
						// Windows: its separator is ";", so this prefix would corrupt
						// the first real PATH entry.
						...(WINDOWS ? {} : { PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ""}` }),
					},
				});
			} catch (e) { reject(e instanceof Error ? e : new Error(String(e))); return; }

			let stdout = "", stderr = "", timedOut = false;
			const timer = window.setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);

			child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
			child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
			child.on("error", (e) => { window.clearTimeout(timer); reject(e); });
			child.on("close", (code) => { window.clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });

			if (stdin) child.stdin.write(stdin);
			child.stdin.end();
		});
	}
}

function stripFence(s: string): string {
	const m = s.match(/^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
	return m ? m[1] : s;
}

/** Pulls the outermost JSON object or array out of a reply. */
export function extractJson(s: string): string | null {
	const text = stripFence(s).trim();
	const span = (open: string, close: string) => {
		const start = text.indexOf(open);
		const end = text.lastIndexOf(close);
		return start !== -1 && end > start ? { start, end } : null;
	};
	const slice = (r: { start: number; end: number }) => text.slice(r.start, r.end + 1);
	const obj = span("{", "}");
	const arr = span("[", "]");

	// A top-level array of objects encloses the object span, and slicing from
	// its first `{` to its last `}` drops the brackets, leaving `{…},{…}` that
	// cannot parse. The array wins only when it encloses the object and is
	// valid itself, so a stray "[1]" in prose before an object reply does not
	// hijack it.
	if (arr && (!obj || (arr.start < obj.start && arr.end > obj.end && parses(slice(arr))))) return slice(arr);
	return obj ? slice(obj) : null;
}

function parses(s: string): boolean {
	try {
		JSON.parse(s);
		return true;
	} catch {
		return false;
	}
}
