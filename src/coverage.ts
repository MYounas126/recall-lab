import { Bank, Lab, LabKind } from "./types";

/**
 * What a course has built on each of its notes, and what has been finished.
 *
 * Without this the note picker lists every note alike, so the easiest thing
 * is to keep picking the one at the top — which is how a course ends up with
 * four challenges on one note and none on the rest.
 */

export interface NoteCoverage {
	note: string;
	/** The note's name, as the picker shows it. */
	name: string;
	questions: number;
	/** Labs you solve by reading. */
	labs: number;
	/** Compiled challenges, by kind. */
	binary: number;
	pwn: number;
	/** How many of this note's labs and challenges are solved. */
	solved: number;
}

const kindOf = (lab: Lab): LabKind => lab.kind ?? "source";

/** What exists for each note, in the order the notes were given. */
export function coverage(
	notes: string[], banks: Bank[], labs: Lab[], solvedBy: Record<string, { solvedAt?: string }>
): NoteCoverage[] {
	return notes.map((note) => {
		const mine = labs.filter((l) => l.note === note);
		return {
			note,
			name: note.split("/").pop()!.replace(/\.md$/, ""),
			questions: banks.filter((b) => b.note === note).reduce((n, b) => n + b.questions.length, 0),
			labs: mine.filter((l) => kindOf(l) === "source").length,
			binary: mine.filter((l) => kindOf(l) === "binary").length,
			pwn: mine.filter((l) => kindOf(l) === "pwn").length,
			solved: mine.filter((l) => solvedBy[l.id]?.solvedAt).length,
		};
	});
}

/** What a note already has, in a few words, or null when it has nothing at all. */
export function describeCoverage(c: NoteCoverage): string | null {
	const parts: string[] = [];
	if (c.questions) parts.push(`${c.questions} q`);
	if (c.labs) parts.push(`${c.labs} lab${c.labs === 1 ? "" : "s"}`);
	if (c.binary) parts.push(`${c.binary} reversing`);
	if (c.pwn) parts.push(`${c.pwn} pwn`);
	if (!parts.length) return null;
	if (c.solved) parts.push(`${c.solved} solved`);
	return parts.join(" · ");
}

/** How many challenges of this kind a note already carries. */
function already(c: NoteCoverage, kind: LabKind): number {
	return kind === "pwn" ? c.pwn : kind === "binary" ? c.binary : c.labs;
}

/**
 * The notes to offer first when building something of this kind: the ones
 * that have none of it yet, then the ones with fewest. A note with a quiz
 * comes before one without, since a note Recall Lab has already read well
 * enough to question makes a better challenge. Ties keep the course's own
 * order, so the list still reads like the course.
 */
export function pickOrder(list: NoteCoverage[], kind: LabKind): NoteCoverage[] {
	return list
		.map((c, i) => ({ c, i }))
		.sort((a, b) =>
			already(a.c, kind) - already(b.c, kind) ||
			Number(b.c.questions > 0) - Number(a.c.questions > 0) ||
			a.i - b.i
		)
		.map((e) => e.c);
}

/** Whether every note already has one of these, so the order says nothing useful. */
export function allCovered(list: NoteCoverage[], kind: LabKind): boolean {
	return list.length > 0 && list.every((c) => already(c, kind) > 0);
}
