# Changelog

Every release of Recall Lab. Versions follow the plugin's manifest, and each
release is tagged with the bare version (`0.4.0`), as Obsidian expects. The
release workflow publishes a version's section below as its release notes.

## [Unreleased]

### Added

- **Tier gates.** The *Progression* settings now do what they say:
  - A quiz's Hard questions are asked once you own 80% of its Easy questions, and its Brutal questions once you own 80% of its Hard ones. Unanswered questions count as zero.
  - Exams leave locked tiers out, say on their first page what opens them, and offer **Include locked tiers** while the gate is advisory (the default).
  - Reviews bring in new questions only from open tiers.
  - The course view marks quizzes with locked tiers with a padlock.
  - The results page announces each tier a session opens.

### Removed

- The leftover render-check pages from the repository root.

### Documentation

- A shorter README, with screenshots of the plugin and a diagram of how it
  works. The full reference moved to `docs/`: a user guide, the question bank
  format, and development and release notes.

## [0.4.0] - 2026-10-19

Recall Lab grows from an exam generator into a long-term memory tool: answers
now drive a spaced-repetition schedule, memory shows on the notes themselves,
and there are new ways to practise that go beyond picking an option.

### Added

- **Daily review with FSRS spaced repetition** (#2). Every answer feeds a
  schedule; Today's review asks what is due across all courses, closest to
  forgotten first, then a daily allowance of new questions from notes you have
  completed or examined. Each course has its own review.
- **How sure are you?** (#3). Guessing, Submit and Sure tune the schedule: a
  lucky guess comes back soon, right-sure-and-quick goes further out. History
  shows how often each level of confidence was right.
- **Streaks, an activity calendar and keyboard shortcuts** (#4). A streak
  counts days that end with nothing overdue; finished days are kept, so a later
  settings change never rewrites them.
- **A radar that fades between reviews** (#5): each spoke is the score you would
  expect if asked now, with a dashed outline of where it stood a week ago.
- **Memory map** (#6): dots on headings in reading view, a due count and Review
  button in each note's footer, and today's due count in the status bar.
- **Recall before recognition** (#7): the options of a choice question can stay
  hidden until you have tried to recall the answer.
- **Hands-on question types** (#8): click the bug, step-through trace (register
  values checked at the register's width), order the steps, match, and
  fill-in-the-blank questions made on your device from your `==highlights==`.
- **Variants** (#9) of questions you have mastered, so you cannot answer from
  how a question looks.
- **Leech clinic** (#10): questions you keep missing get a diagnosis of the
  misconception, a short lesson and a fresh question.
- **Guided steps and a second try** (#11): brutal problems can be walked up to
  in small steps, and a missed written answer gets one nudge and another try.
- **Write it all down** (#12): a timed page for everything you remember about a
  note, compared with the note section by section before its quiz.
- **Teach it back** (#13): explain a note to a curious beginner played by
  Claude, then see which of its key points you conveyed.
- **CTF-style lab hints** (#16): three nudges of a few words, the way
  HackTheBox writes them, and **Shorten lab hints to CTF-style nudges** to
  rewrite the step-by-step hints of older labs.
- **CI and releases**: every push and pull request is type-checked, tested and
  built on Node 20 and 22; pushing a version tag publishes a release with the
  plugin files, a zip and checksums. Dependabot keeps tooling and actions
  current.

### Fixed

- Question ids come from each question's content, so rebuilding a quiz no
  longer hands a new question the old one's history (#1).
- An `attempts.json` that cannot be read is never overwritten with an empty
  log, and a marking that failed (Claude unreachable) no longer counts as a
  miss in the schedule, scores or calibration (#2, #3).
- The radar no longer crashes the overview when a course has an untested skill
  area (#15).
- Course Notes list: notes with labs no longer lose their name, chips no longer
  wrap or ride above the buttons, and big courses are grouped by module (#17).
- Revealing a lab hint no longer jumps to the top of the page, a wrong flag
  tried before costs nothing, and the flag box sits right after the challenge
  (#17).
- Ending an exam before answering no longer records an F, and the page heading,
  exam bar and History are tidied up (#17).

## [0.3.0] - 2026-10-18

The baseline: tiered exams over your notes (multiple choice, select-all, free
text, shell commands and image answers), marked instantly or by Claude through
the Claude Code CLI; CTF-style hands-on labs with hashed flags; a skill radar
per course; and a full answer history.

[Unreleased]: https://github.com/MYounas126/recall-lab/compare/0.4.0...HEAD
[0.4.0]: https://github.com/MYounas126/recall-lab/releases/tag/0.4.0
[0.3.0]: https://github.com/MYounas126/recall-lab/commit/23f4e9a
