/**
 * A browser for the tests that draw the Recall Lab view: jsdom's DOM, made
 * global, with the helpers Obsidian adds to every element (createDiv,
 * setText, addClass…) written to behave as Obsidian's do. Imported first by
 * those tests; every other test runs without a DOM.
 */
import { JSDOM } from "jsdom";

const { window: win } = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const doc = win.document;

type Attr = string | number | boolean | null;
interface Info {
	cls?: string | string[];
	text?: string | DocumentFragment;
	attr?: Record<string, Attr>;
	title?: string;
	value?: string;
	type?: string;
	placeholder?: string;
	href?: string;
	prepend?: boolean;
}

function setUp(el: Element, o: Info | string | undefined, svg: boolean): void {
	const info: Info = typeof o === "string" ? { cls: o } : o ?? {};
	if (info.cls) {
		const tokens = Array.isArray(info.cls) ? info.cls : [info.cls];
		// As in Obsidian: an HTML element takes the classes as its class
		// attribute, while an SVG one adds each token, and a space throws.
		if (svg) el.classList.add(...tokens);
		else el.className = tokens.join(" ");
	}
	if (info.text !== undefined) setText(el, info.text);
	for (const [k, v] of Object.entries(info.attr ?? {})) if (v !== null) el.setAttribute(k, String(v));
	if (info.title) el.setAttribute("title", info.title);
	const fields = el as unknown as Record<string, unknown>;
	for (const k of ["value", "type", "placeholder", "href"] as const) if (info[k] !== undefined) fields[k] = info[k];
}

function setText(el: Node, text: string | DocumentFragment): void {
	if (typeof text === "string") el.textContent = text;
	else {
		while (el.firstChild) el.removeChild(el.firstChild);
		el.appendChild(text);
	}
}

type Callback = (el: Element) => void;
function add<T extends Element>(parent: Node, el: T, o: Info | string | undefined, cb?: Callback): T {
	if (typeof o === "object" && o.prepend) (parent as ParentNode).prepend(el);
	else parent.appendChild(el);
	cb?.(el);
	return el;
}

const node = win.Node.prototype as unknown as Record<string, unknown>;
const element = win.Element.prototype as unknown as Record<string, unknown>;

Object.assign(node, {
	createEl(this: Node, tag: string, o?: Info | string, cb?: Callback) {
		const el = doc.createElement(tag);
		setUp(el, o, false);
		return add(this, el, o, cb);
	},
	createDiv(this: Node, o?: Info | string, cb?: Callback) {
		return (this as unknown as { createEl: (t: string, o?: Info | string, cb?: Callback) => Element }).createEl("div", o, cb);
	},
	createSpan(this: Node, o?: Info | string, cb?: Callback) {
		return (this as unknown as { createEl: (t: string, o?: Info | string, cb?: Callback) => Element }).createEl("span", o, cb);
	},
	createSvg(this: Node, tag: string, o?: Info | string, cb?: Callback) {
		const el = doc.createElementNS("http://www.w3.org/2000/svg", tag);
		setUp(el, o, true);
		return add(this, el, o, cb);
	},
	empty(this: Node) {
		while (this.firstChild) this.removeChild(this.firstChild);
	},
	setText(this: Node, text: string | DocumentFragment) {
		setText(this, text);
	},
	appendText(this: Node, text: string) {
		this.appendChild(doc.createTextNode(text));
	},
});

Object.assign(element, {
	addClass(this: Element, ...cls: string[]) { this.classList.add(...cls); },
	addClasses(this: Element, cls: string[]) { this.classList.add(...cls); },
	removeClass(this: Element, ...cls: string[]) { this.classList.remove(...cls); },
	toggleClass(this: Element, cls: string | string[], on: boolean) {
		for (const c of Array.isArray(cls) ? cls : [cls]) this.classList.toggle(c, on);
	},
	hasClass(this: Element, cls: string) { return this.classList.contains(cls); },
	setAttr(this: Element, k: string, v: Attr) {
		if (v === null) this.removeAttribute(k);
		else this.setAttribute(k, String(v));
	},
	getText(this: Element) { return this.textContent ?? ""; },
	setCssProps(this: HTMLElement, props: Record<string, string>) {
		for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
	},
	// jsdom lays nothing out, so there is nowhere to scroll to.
	scrollIntoView() {},
});

const globals = globalThis as unknown as Record<string, unknown>;
for (const name of [
	"Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLButtonElement",
	"SVGElement", "DocumentFragment", "Event", "KeyboardEvent", "MouseEvent", "FileReader",
]) {
	globals[name] = (win as unknown as Record<string, unknown>)[name];
}
globals.window = win;
globals.document = doc;
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.CSS = { escape: (s: string) => s.replace(/["\\]/g, "\\$&") };

export { win, doc };
