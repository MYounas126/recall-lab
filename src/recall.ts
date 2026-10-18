import { QuestionType } from "./types";

/**
 * Recall before recognition: on choice questions the options stay hidden
 * until you have tried to produce the answer yourself. Producing an answer
 * builds memory better than picking it out of a list (the generation effect).
 */
export interface RecallStage {
	/** Which question of the session this belongs to. */
	index: number;
	/** What you typed from memory; may be empty if you only thought it. */
	text: string;
	shown: boolean;
}

/** Only choice questions have options to hide. */
export function recallApplies(on: boolean, type: QuestionType): boolean {
	return on && (type === "mcq" || type === "multi");
}

/** Whether the options for question `index` are still hidden. */
export function optionsHidden(on: boolean, type: QuestionType, stage: RecallStage | null, index: number): boolean {
	return recallApplies(on, type) && !(stage?.index === index && stage.shown);
}
