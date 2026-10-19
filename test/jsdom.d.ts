// The one part of jsdom the view tests use (see dom.ts).
declare module "jsdom" {
	export class JSDOM {
		constructor(html?: string, options?: { pretendToBeVisual?: boolean; url?: string });
		readonly window: Window & typeof globalThis;
	}
}
