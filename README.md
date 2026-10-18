# Recall Lab

An Obsidian plugin for tiered, graded quizzing over your own notes — multiple
choice, select-all, free text, shell commands and image answers, with a
persistent gradebook.

**It never calls an AI API and holds no API key.** Objective questions are
marked instantly and offline inside the plugin. Open answers are queued in a
file in your vault; Claude grades them through the Obsidian MCP connection you
already have and writes the verdicts back.

## Install

1. Quit Obsidian.
2. Copy the folder `recall-lab` from `~/Downloads/recall-lab-install/` into
   your vault's plugins folder:

   `<vault>/.obsidian/plugins/recall-lab/`

   It must contain `main.js`, `manifest.json` and `styles.css` directly — not a
   nested folder.
3. Start Obsidian → **Settings → Community plugins** → enable **Recall Lab**.
   (Community plugins must not be in restricted/safe mode.)
4. Click the graduation-cap ribbon icon, or run **Recall Lab: Open Recall Lab**.

## The grading loop

```
  you answer ──► MCQ / select-all / pattern match ──► marked instantly, offline
             └─► text, command, image ──► _quiz/claude/pending.json
                                              │
                                   you say "/grade-quiz" in Claude
                                              │
                                     _quiz/claude/verdicts.json
                                              │
                      plugin notices the file change and folds the
                      score, feedback, gaps and grade into the gradebook
```

The `/grade-quiz` slash command is installed at `~/.claude/commands/grade-quiz.md`.
You can also just say "grade my quiz answers" in any Claude session that has the
Obsidian connection.

## Files it uses, all inside your vault

| Path | What it is |
|---|---|
| `_quiz/banks/*.json` | Question banks. One per class. |
| `_quiz/progress/attempts.json` | Every answer, score and piece of feedback. |
| `_quiz/progress/Gradebook.md` | Generated. Mastery per tier, weak areas, session history. |
| `_quiz/claude/pending.json` | Open answers waiting to be graded. |
| `_quiz/claude/verdicts.json` | What Claude wrote back. Cleared once consumed. |

## Tiers

Easy, Hard and Brutal. Mastery of a tier counts unanswered questions as zero,
so the number answers *how much of this tier do I own*, not *how did I do on the
three I tried*. Hard unlocks at 80% of Easy, Brutal at 80% of Hard; both
thresholds are configurable, and the gate is advisory by default.

## Bank format

```jsonc
{
  "id": "arch1001-03",
  "title": "Arch1001 · 03 — Registers",
  "note": "Architecture 1001 - Intel x86-64 Assembly/03 Registers.md",
  "questions": [
    {
      "id": "r03-e13",
      "tier": "easy",              // easy | hard | brutal
      "type": "mcq",               // mcq | multi | short | command | image
      "topic": "abcd-ordering",    // aggregates into weak areas
      "prompt": "Which register number is `RBX`?",
      "code": "optional monospace block",
      "choices": ["`R3`", "`R1`", "`R2`", "`R4`"],
      "answer": 0,                 // mcq: index. multi: array of indices.
      "accept": ["^r3$"],          // short/command: instant pass, skips Claude
      "expected": "model answer",  // shown after answering; given to Claude
      "rubric": ["point one"],     // what full credit requires
      "explain": "shown whatever the verdict",
      "ref": "03 Registers#4.1 …", // click through to the note
      "timestamp": "P1 03:16",
      "slide": 13
    }
  ]
}
```

An `accept` pattern that does not match never fails the answer — it just sends
it to Claude. A correct answer phrased unusually must not be failed by a regex.

## Develop

```bash
npm install
npm run dev     # watch
npm run build   # typecheck + minified main.js
```
