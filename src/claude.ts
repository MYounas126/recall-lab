import { spawn } from "child_process";
import * as os from "os";

export interface ClaudeReply {
	ok: boolean;
	/** The model's text, with any markdown fence stripped. */
	text: string;
	error?: string;
	costUsd?: number;
}

const CANDIDATES = [
	"/opt/homebrew/bin/claude",
	"/usr/local/bin/claude",
	"/usr/bin/claude",
	`${os.homedir()}/.local/bin/claude`,
	`${os.homedir()}/.claude/local/claude`,
	`${os.homedir()}/.bun/bin/claude`,
];

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
		// A GUI app does not inherit the shell PATH, so ask a login shell.
		try {
			const shell = process.env.SHELL || "/bin/zsh";
			const found = await this.run(shell, ["-lc", "command -v claude"], "", 15000);
			const path = found.stdout.trim().split("\n").pop()?.trim();
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
			return { ok: false, text: "", error: "The Claude Code CLI was not found. Install it with: npm install -g @anthropic-ai/claude-code" };
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
			parsed = JSON.parse(res.stdout);
		} catch {
			const tail = (res.stderr || res.stdout).trim().slice(-400);
			this.onLog("error", "the CLI did not return JSON", { code: res.code, secs, tail });
			return { ok: false, text: "", error: tail || `Claude exited with code ${res.code}.` };
		}
		if (parsed.is_error) {
			this.onLog("error", "Claude reported an error", { secs, result: String(parsed.result ?? "") });
			return { ok: false, text: "", error: String(parsed.result ?? "Claude reported an error.") };
		}
		this.onLog("info", "Claude replied", { secs, costUsd: parsed.total_cost_usd, chars: String(parsed.result ?? "").length });
		return {
			ok: true,
			text: stripFence(String(parsed.result ?? "")),
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
						PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ""}`,
					},
				});
			} catch (e) { reject(e); return; }

			let stdout = "", stderr = "", timedOut = false;
			const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);

			child.stdout.on("data", (d) => (stdout += d.toString()));
			child.stderr.on("data", (d) => (stderr += d.toString()));
			child.on("error", (e) => { clearTimeout(timer); reject(e); });
			child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });

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
	for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
		const start = text.indexOf(open);
		const end = text.lastIndexOf(close);
		if (start !== -1 && end > start) return text.slice(start, end + 1);
	}
	return null;
}
