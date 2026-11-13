import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Where challenge binaries are built. Recall Lab compiles a challenge, then
 * runs it once the way it is meant to be solved to confirm the flag really
 * comes out. Both happen inside a throwaway x86-64 Linux container with no
 * network, a read-only system and no privileges — never on your machine, and
 * never in your vault. You solve the finished binary wherever you like.
 *
 * The image holds a compiler and nothing else: the reversing tools live in
 * your own VM.
 */

/**
 * One toolchain a kind of challenge can be built in.
 *
 * Kinds declare the image they need rather than sharing one, so a vault that
 * only ever builds C challenges never downloads a compiler it has no use
 * for, and adding a language does not make the existing image fatter.
 */
export interface SandboxImage {
	/** The image tag. Bump the number whenever `dockerfile` changes. */
	tag: string;
	/** What to call it in a notice, e.g. "the C builder". */
	label: string;
	dockerfile: string;
}

/** x86-64 Linux and a C compiler: what reversing and exploitation are built with. */
export const C_BUILDER: SandboxImage = {
	tag: "recall-lab-build:1",
	label: "the C builder",
	dockerfile: `# Recall Lab's challenge builder: x86-64 Linux and a compiler, nothing more.
FROM --platform=linux/amd64 debian:trixie-slim
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \\
      gcc libc6-dev binutils file \\
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 build
USER build
WORKDIR /work
`,
};

/** The tag of the image every challenge was built in before kinds could choose. */
export const BUILDER_IMAGE = C_BUILDER.tag;

export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** Runs a program to completion. Swapped out in tests. */
export type Exec = (cmd: string, args: string[], opts: { timeoutMs: number }) => Promise<RunResult>;

export interface SandboxConfig {
	/** The docker command; blank finds it. */
	docker: string;
	/** A docker context, such as colima-ctf; blank uses the current one. */
	context: string;
}

/** Kept from a run: enough to read an error, never the whole of a runaway program's output. */
const MAX_OUTPUT = 64 * 1024;

const spawnExec: Exec = (cmd, args, opts) =>
	new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const child = spawn(cmd, args, {
			// A GUI app does not inherit the shell's PATH, and docker needs it.
			env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ""}` },
		});
		const timer = window.setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs);
		child.stdout.on("data", (d: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
		child.stderr.on("data", (d: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });
		child.on("error", (e) => { window.clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + String(e), timedOut }); });
		child.on("close", (code) => { window.clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
		child.stdin.end();
	});

/** Where docker usually lives, for an app that does not inherit the shell's PATH. */
const DOCKER_PATHS = [
	"/opt/homebrew/bin/docker",
	"/usr/local/bin/docker",
	"/usr/bin/docker",
	"/Applications/Docker.app/Contents/Resources/bin/docker",
];

/**
 * The docker arguments for one run: x86-64, no network, a read-only system
 * with a small scratch /tmp, every capability dropped, no privilege
 * escalation, and limits on processes, memory and CPU. Only the build
 * directory is shared. Pure, so it can be tested.
 */
export function runArgs(context: string, name: string, work: string, command: string[], image: SandboxImage): string[] {
	return [
		...(context ? ["--context", context] : []),
		"run", "--rm", "--name", name, "--platform", "linux/amd64",
		"--network", "none", "--read-only", "--tmpfs", "/tmp:rw,exec,size=64m",
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"--pids-limit", "64", "--memory", "512m", "--cpus", "1",
		"-e", "HOME=/tmp",
		"-v", `${work}:/work`, "-w", "/work",
		image.tag, ...command,
	];
}

export type SandboxStatus =
	| { ok: true; server: string }
	| { ok: false; error: string };

export class Sandbox {
	constructor(private config: () => SandboxConfig, private exec: Exec = spawnExec) {}

	private docker(): string {
		const set = this.config().docker.trim();
		if (set) return set.replace(/^~(?=$|\/)/, os.homedir());
		return DOCKER_PATHS.find((p) => fs.existsSync(p)) ?? "docker";
	}

	private ctx(): string[] {
		const c = this.config().context.trim();
		return c ? ["--context", c] : [];
	}

	/** Whether Docker answers at all. Which images exist is a separate question. */
	async status(): Promise<SandboxStatus> {
		const info = await this.exec(this.docker(), [...this.ctx(), "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20000 });
		if (info.code !== 0) {
			const why = (info.stderr || info.stdout).trim().split("\n").pop() ?? "";
			return { ok: false, error: `Docker is not answering${why ? `: ${why.slice(0, 200)}` : ""}` };
		}
		return { ok: true, server: info.stdout.trim() };
	}

	/** Whether one toolchain's image has been built here already. */
	async hasImage(image: SandboxImage): Promise<boolean> {
		const found = await this.exec(
			this.docker(), [...this.ctx(), "image", "inspect", image.tag, "--format", "{{.Id}}"], { timeoutMs: 20000 }
		);
		return found.code === 0;
	}

	/** Builds one toolchain's image. It downloads a base and the tools, once. */
	async buildImage(scratch: string, image: SandboxImage): Promise<RunResult> {
		const dir = fs.mkdtempSync(path.join(scratch, "builder-"));
		try {
			fs.writeFileSync(path.join(dir, "Dockerfile"), image.dockerfile);
			return await this.exec(
				this.docker(),
				[...this.ctx(), "build", "--platform", "linux/amd64", "-t", image.tag, dir],
				{ timeoutMs: 20 * 60 * 1000 }
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	/** Runs one command in a fresh locked-down container, with `work` as its /work. */
	async run(work: string, command: string[], timeoutMs: number, image: SandboxImage): Promise<RunResult> {
		const name = `recall-lab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const res = await this.exec(this.docker(), runArgs(this.config().context.trim(), name, work, command, image), { timeoutMs });
		// A killed docker client can leave its container running.
		if (res.timedOut) await this.exec(this.docker(), [...this.ctx(), "rm", "-f", name], { timeoutMs: 20000 });
		return res;
	}
}
