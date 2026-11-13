import { CRACKME } from "./crackme";
import { ExerciseKind } from "./exercise";
import { PWN } from "./pwn";
import { Lab } from "./types";

/**
 * Every kind of verified exercise Recall Lab can write.
 *
 * This is the one list. Adding a kind means writing its descriptor and
 * putting it here: the loop, the toolchain it is built in, the commands and
 * the settings all read from this rather than branching on a name.
 */
export const KINDS: ExerciseKind[] = [CRACKME, PWN];

/** The kind a lab was written by, or null for a plain source lab. */
export function kindOf(lab: Lab): ExerciseKind | null {
	return KINDS.find((k) => k.kind === lab.kind) ?? null;
}

/** The distinct images the kinds need, so each is built and reported once. */
export function imagesNeeded(): ExerciseKind["image"][] {
	const seen = new Map<string, ExerciseKind["image"]>();
	for (const k of KINDS) if (!seen.has(k.image.tag)) seen.set(k.image.tag, k.image);
	return [...seen.values()];
}
