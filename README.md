# Recall Lab

An Obsidian plugin for tiered, graded exams over your own notes — multiple
choice, select-all, free text, shell commands and image answers — with
CTF-style hands-on labs, a skill radar per course, and a full answer history.

**It holds no API key.** Multiple choice and select-all are marked instantly
and offline inside the plugin. Everything that needs judgement — marking
written answers, end-of-exam feedback, and writing quizzes and labs — runs
through the Claude Code CLI on your own subscription. The plugin calls the CLI
itself and waits for the reply, so there is nothing for you to type or run.

## Requirements

- Obsidian 1.5 or later, on desktop.
- The Claude Code CLI, installed and signed in. Recall Lab looks in the usual
  install locations and asks your login shell; if it still cannot find it, set
  the path under **Settings → Recall Lab → Path to the claude binary** and use
  **Check the connection** to test it.
- macOS or Linux. It is developed and tested on macOS. On Windows it needs
  `claude.exe` from Claude Code's native installer — an npm install only
  provides `claude.cmd`, which it cannot start — and it is untested there.

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

## How marking works

```
  you answer ──► MCQ / select-all / accept pattern ──► marked instantly, offline
             └─► text, command, image ──► Claude Code CLI ──► score, feedback,
                                                               missed rubric points
  you finish ──► Claude reads the whole exam back ──► coaching on the pattern
                                                      behind your mistakes
```

An open answer is marked in place: the model answer shows while Claude marks,
then the score, the feedback and any rubric points you missed. If Claude cannot
be reached, the answer is recorded as 0 with the reason, so an exam never
stalls. **Strictness** (lenient, normal or brutal) is set in settings and
written into every marking request.

## Daily review

Every answer you give, in any exam, feeds a spaced-repetition schedule run by
[FSRS](https://github.com/open-spaced-repetition/ts-fsrs), the scheduler Anki
added in version 23.10. **Today's review** on the overview, or **Start today's
review** from the command palette, asks what is due across every course, the
questions you are closest to forgetting first, then up to a daily allowance of
new questions. New questions only come from notes you have marked complete or
already taken an exam on. Each course has its own review as well.

A miss brings a question back the next day; each correct answer pushes it
further out. Answers are saved as you go, so you can stop at any point. Reviews
stay offline apart from marking written answers: feedback from Claude is one
button away rather than automatic.

**How sure are you?** Every question has three submit buttons: *Guessing*,
*Submit* and *Sure*. A right answer you were guessing at comes back as if you
had missed it; right, sure and faster than your usual pace is spaced out
further. Plain *Submit* claims neither. Mistakes you were sure about get their
own list on the results screen (they stick unusually well once corrected), and
History shows how often each level of confidence turned out right.

**Streaks and keys.** Your streak counts days that end with nothing overdue,
not how much you answered, and today cannot break it until it is over.
History shows a year of activity as a calendar, with days that ended overdue
outlined. On the exam screen, `1`–`9` pick an option, `Enter` submits, `G` and
`S` submit as Guessing and Sure, `D` gives up on a written answer, and `Enter`
or `Space` moves on. In a text box, `Cmd`/`Ctrl`+`Enter` submits and `Esc`
leaves the box.

**Settings → Daily review** sets the target recall (90% by default; higher
means more frequent reviews) and how many new questions a day may bring in
(20). The schedule itself is never stored: it is rebuilt from `attempts.json`
each time, so it cannot drift out of step with your answer history.

## Building courses, quizzes and labs

- **Set up a course.** Pick a folder in the Recall Lab sidebar and press *Set
  up this course*. Claude samples its notes and names 5–7 skill areas, which
  become the spokes of the course's radar.
- **Quiz a note.** Press *Generate* beside it, press *Complete* at the foot of
  any note in a course folder, or run **Quiz me on this note**.
- **Every missing quiz at once.** *Generate all N missing quizzes…* in the
  course view shows an estimate, asks first, and can be stopped at any point.
- **Labs.** *Labs* beside a note that has a quiz writes three CTF-style
  challenges — one source file each, solvable by reading. Only a SHA-256 hash
  of each flag is kept.

Builds run one at a time. Anything you ask for while one is running is queued
behind it, and asking twice for the same note does not build it twice.

## Files it uses, all inside your vault

| Path | What it is |
|---|---|
| `_quiz/courses/*.json` | Course definitions: the folder each one covers and its skill areas. |
| `_quiz/banks/*.json` | Question banks, one per note. |
| `_quiz/labs/*.json` | Labs, with each flag stored only as a hash. |
| `_quiz/progress/attempts.json` | Every answer, score and piece of feedback; every exam; notes marked complete; lab progress. |
| `_quiz/progress/recall-lab.log` | A plain-text log of the last 400 events, for when something goes wrong. |

A lab you choose to write out — to compile or run it yourself — goes to
`~/RecallLab/labs/`, outside the vault.

Quizzes and labs are tied to their note by path, and courses to their folder.
After deleting or renaming notes, run **Remove leftover quizzes, labs and
courses**: it lists what no longer has a note or folder and, once you confirm,
moves it to the trash. Your answer history is kept.

## Tiers

Easy (recall), Hard (application) and Brutal (synthesis and hands-on). An exam
ramps through all three — about 45% easy, 35% hard and 20% brutal — and within
each tier asks unseen questions first, then your weakest, then the ones you
have not seen for longest.

Mastery counts unanswered questions as zero, so a radar spoke answers *how
much of this area do I own*, not *how did I do on the three I tried*. A
question's mastery is the mean of its last three scores, so one lucky guess
does not erase a history of getting it wrong.

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
      "axis": "register-model",    // the course skill area it feeds on the radar
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
npm test        # unit tests, run under Node with a stand-in for Obsidian
```
