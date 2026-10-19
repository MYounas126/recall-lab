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
	/** Every message shown, for a test to look into. */
	static shown: string[] = [];
	constructor(message?: unknown, ..._rest: unknown[]) {
		Notice.shown.push(typeof message === "string" ? message : "");
	}
	hide(): void {}
}

// ------------------------------------------------------------------ view
// What the Recall Lab view uses of Obsidian's UI, for the tests that draw it
// over the DOM set up in dom.ts. Nothing here touches the DOM until used.

export class App {}
export class WorkspaceLeaf {}
export const Platform = { isMacOS: true, isDesktop: true, isDesktopApp: true, isMobile: false };

export class Component {
	private cleanups: (() => void)[] = [];
	load(): void {}
	unload(): void {
		for (const f of this.cleanups.splice(0)) f();
	}
	addChild<T>(child: T): T {
		return child;
	}
	register(cb: () => void): void {
		this.cleanups.push(cb);
	}
	registerEvent(): void {}
	registerInterval(id: number): number {
		return id;
	}
	registerDomEvent(el: EventTarget, type: string, cb: (e: never) => unknown): void {
		const listener = cb as unknown as EventListener;
		el.addEventListener(type, listener);
		this.register(() => el.removeEventListener(type, listener));
	}
}

export class ItemView extends Component {
	app: unknown;
	containerEl: HTMLElement;
	contentEl: HTMLElement;

	constructor(public leaf: { app?: unknown }) {
		super();
		this.app = leaf.app;
		this.containerEl = document.createElement("div");
		this.containerEl.className = "workspace-leaf-content";
		this.containerEl.createDiv({ cls: "view-header" });
		this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
	}
}

export function setIcon(parent: HTMLElement, icon: string): void {
	parent.empty();
	parent.createSvg("svg", { cls: "svg-icon", attr: { "data-icon": icon } });
}

export class ButtonComponent {
	buttonEl: HTMLButtonElement;
	private click: ((e: MouseEvent) => unknown) | null = null;

	constructor(containerEl: HTMLElement) {
		this.buttonEl = containerEl.createEl("button");
		this.buttonEl.addEventListener("click", (e) => {
			if (!this.buttonEl.disabled) void this.click?.(e);
		});
	}
	setButtonText(name: string): this {
		this.buttonEl.setText(name);
		return this;
	}
	setIcon(icon: string): this {
		setIcon(this.buttonEl, icon);
		return this;
	}
	setTooltip(tooltip: string): this {
		this.buttonEl.setAttr("aria-label", tooltip);
		return this;
	}
	setCta(): this {
		this.buttonEl.addClass("mod-cta");
		return this;
	}
	removeCta(): this {
		this.buttonEl.removeClass("mod-cta");
		return this;
	}
	setWarning(): this {
		this.buttonEl.addClass("mod-warning");
		return this;
	}
	setClass(cls: string): this {
		this.buttonEl.addClass(cls);
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.buttonEl.disabled = disabled;
		return this;
	}
	onClick(cb: (e: MouseEvent) => unknown): this {
		this.click = cb;
		return this;
	}
}

/** Markdown as plain text in a paragraph: enough to find a label by what it says. */
export const MarkdownRenderer = {
	async render(_app: unknown, markdown: string, el: HTMLElement): Promise<void> {
		el.createEl("p", { text: markdown });
	},
};

export class Modal {
	/** Modals open now, oldest first, for a test to look into. */
	static opened: Modal[] = [];
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;

	constructor(public app: unknown) {
		this.modalEl = document.createElement("div");
		this.titleEl = this.modalEl.createDiv();
		this.contentEl = this.modalEl.createDiv();
	}
	open(): void {
		Modal.opened.push(this);
		this.onOpen();
	}
	close(): void {
		Modal.opened = Modal.opened.filter((m) => m !== this);
		this.onClose();
	}
	onOpen(): void {}
	onClose(): void {}
}

// Settings import these; their page is never drawn in tests.
export class PluginSettingTab {
	constructor(public app: unknown, public plugin: unknown) {}
}
export class Setting {
	constructor(public settingEl: unknown) {}
}
