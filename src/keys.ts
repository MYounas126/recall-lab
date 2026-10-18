import { Confidence } from "./types";

export type KeyAction =
	| { do: "choose"; slot: number }
	| { do: "submit"; confidence: Confidence }
	| { do: "skip" }
	| { do: "next" }
	| { do: "leave-text" };

export interface KeyPress {
	key: string;
	/** Cmd on macOS, Ctrl elsewhere. */
	mod: boolean;
	/** Ctrl on macOS, the Windows or Super key elsewhere: never a shortcut here. */
	otherMod: boolean;
	alt: boolean;
	/** Focus is in a text box, where letters and Enter belong to the text. */
	typing: boolean;
	/** Focus is on a button, which handles its own Enter and Space. */
	onButton: boolean;
	/** The answer has been marked and the feedback is showing. */
	answered: boolean;
}

/**
 * What a key press means on the exam screen, or null to leave it alone:
 * 1–9 pick an option, Enter submits, G and S submit as Guessing and Sure,
 * D gives up on a written answer, and Enter or Space moves on once the
 * feedback is showing. In a text box only Escape (leave it) and Cmd/Ctrl+Enter
 * (submit) are taken; every other key types.
 */
export function keyAction(p: KeyPress): KeyAction | null {
	if (p.alt || p.otherMod) return null;
	if (p.typing) {
		if (p.key === "Escape") return { do: "leave-text" };
		if (p.key === "Enter" && p.mod) return p.answered ? { do: "next" } : { do: "submit", confidence: "unsure" };
		return null;
	}
	if (p.mod) return null;
	const key = p.key.length === 1 ? p.key.toLowerCase() : p.key;
	if (p.answered) {
		return (key === "Enter" || key === " ") && !p.onButton ? { do: "next" } : null;
	}
	if (/^[1-9]$/.test(key)) return { do: "choose", slot: Number(key) - 1 };
	if (key === "Enter" && !p.onButton) return { do: "submit", confidence: "unsure" };
	if (key === "g") return { do: "submit", confidence: "guess" };
	if (key === "s") return { do: "submit", confidence: "sure" };
	if (key === "d") return { do: "skip" };
	return null;
}
