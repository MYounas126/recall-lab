/**
 * Just enough of the "obsidian" module for Recall Lab's logic to run under
 * Node. The test runner swaps every `import … from "obsidian"` for this file.
 */
export class TAbstractFile {
	constructor(public path: string) {}
	get name(): string {
		return this.path.split("/").pop() ?? "";
	}
}

export class TFile extends TAbstractFile {
	get extension(): string {
		return this.path.split(".").pop() ?? "";
	}
	get basename(): string {
		return this.name.replace(/\.[^.]+$/, "");
	}
}

export class TFolder extends TAbstractFile {}

export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

export class Notice {
	constructor(..._args: unknown[]) {}
	hide(): void {}
}
