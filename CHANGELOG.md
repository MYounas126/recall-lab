# Changelog

Every release of Recall Lab. Versions follow the plugin's manifest, and each
release is tagged with the bare version (`0.4.0`), as Obsidian expects. The
release workflow publishes a version's section below as its release notes.

## [Unreleased]

### Development

- CI runs on Node 22 and 24, and releases build on Node 22. Node 20 reached
  end of life on 30 April 2026. This lets the view tests move to jsdom 30.
- Node's type definitions stay on version 22, and Dependabot no longer offers
  new majors of them.

## [0.5.1] - 2026-10-19

Fixes what Obsidian's community directory flagged in its review of 0.5.0.

### Fixed

- **Minimum Obsidian version.** The plugin now declares Obsidian 1.7.2 or
  later. It already used `Workspace.revealLeaf` returning a promise, from
  1.7.2, and `FileManager.trashFile`, from 1.6.6, which 1.5.0 did not have.
  On an older Obsidian you keep 0.5.0.
- Leftover quizzes, labs and courses always go to the trash through
  `FileManager.trashFile`, which follows your "Deleted files" setting. The
  fallback for older Obsidian versions is gone.
- Match questions lay out each pair as its own grid row instead of with
  `display: contents`, which older Electron versions support only in part.
  They look the same.

### Changed

- Each release file now has a GitHub build attestation. To check a file was
  built from this repository, run
  `gh attestation verify main.js -R MYounas126/recall-lab`. The extra zip and
  `SHA256SUMS.txt` are no longer attached, as Obsidian downloads only the
  three plugin files.
- The README explains how to install from Obsidian's Community plugins.

### Documentation

- A contributing guide: `CONTRIBUTING.md`.

## [0.5.0] - 2026-10-19

Tier gates make the Progression settings real, and highlights reach your
reviews sooner. Every screen now draws much faster. The plugin is also ready
for Obsidian's community directory.

### Added

- **Tier gates** (#26). The Progression settings now do what they say:
  - A quiz's Hard questions are asked once you own 80% of its Easy questions,
    and its Brutal questions once you own 80% of its Hard ones. Unanswered
    questions count as zero.
  - Exams leave locked tiers out and say on their first page what opens them.
    While the gate is advisory (the default), they offer **Include locked
    tiers**.
  - Reviews bring in new questions only from open tiers.
  - In the course view, quizzes with locked tiers show a padlock.
  - The results page names each tier a session opens.
- **Highlights reach the daily review sooner.** Questions made from your
  `==highlights==` come in as soon as you write them, without waiting for the
  note to be completed or examined.

### Changed

- **Much faster screens.** The review schedule is kept and extended instead of
  being replayed from the whole answer history on every screen. The streak
  resumes from the days already saved.
  - With a year of answers (about 11,000), an overview redraw drops from about
    0.7 s to about 35 ms.
  - The first draw after starting Obsidian takes about 0.25 s.
- attempts.json and the log are written through `Vault.process`, so a sync
  cannot slip a change in between a read and a write.
- The command **Open Recall Lab** is now **Open view**: the palette already
  shows "Recall Lab:" before it. The setting **Path to the claude binary** is
  now **Path to the Claude binary**.
- The plugin's author is Muhammad Younas, with [r00tlv.me](https://r00tlv.me)
  as the author's site in the manifest.
- Builds use esbuild 0.28 (#20). `builtin-modules` is gone, replaced by
  Node's own list.

### Removed

- The leftover render-check pages from the repository root.

### Documentation

- A shorter README, with screenshots of the plugin and a diagram of how it
  works (#25). The full reference moved to `docs/`: a user guide, the
  question bank format, and development and release notes.
- The README now discloses what Obsidian's developer policies ask for: the
  Claude account and plan, network use, the programs Recall Lab starts and
  the files it writes outside the vault.

### Development

- View tests draw every screen of the real view in jsdom, in CI. They check
  that each screen draws without an error, and that the screens say the
  right thing.
- `scripts/smoke-test.js` opens every screen in a real vault, answering
  nothing, to check a build before release.
- The code passes Obsidian's recommended lint rules
  (`eslint-plugin-obsidianmd`) with no errors.

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

[Unreleased]: https://github.com/MYounas126/recall-lab/compare/0.5.1...HEAD
[0.5.1]: https://github.com/MYounas126/recall-lab/releases/tag/0.5.1
[0.5.0]: https://github.com/MYounas126/recall-lab/releases/tag/0.5.0
[0.4.0]: https://github.com/MYounas126/recall-lab/releases/tag/0.4.0
[0.3.0]: https://github.com/MYounas126/recall-lab/commit/23f4e9a
