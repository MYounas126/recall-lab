# Contributing to Recall Lab

Thank you for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug or asking for a feature

Open an [issue](https://github.com/MYounas126/recall-lab/issues). For a bug, include:

- what you did, what you expected and what happened instead;
- your Obsidian version and operating system;
- the end of `_quiz/progress/recall-lab.log` from your vault, which records what went wrong. It names files in your vault, so read it before you post it.

## Making a change

1. Set up the project as described in [docs/development.md](docs/development.md).
2. Make the change on a branch. Match the code around it: its naming, its comments and the way it is laid out.
3. Add or update a test in `test/` for anything that changes what the plugin does.
4. Run `npm run build` and `npm test`. Both must pass, as they do in CI.
5. If the change touches anything a user sees, update [docs/user-guide.md](docs/user-guide.md) as well.
6. Open a pull request that says what changed and why.

Before a release, the plugin is also checked with Obsidian's [ESLint rules](https://github.com/obsidianmd/eslint-plugin), the same rules the community directory reviews it with. Code that adds an error there can't be released.

## Ground rules

- Recall Lab makes no network requests of its own and has no telemetry. Anything that needs judgement goes through the user's own Claude Code CLI.
- Everything it keeps stays in the vault. The one exception is a lab the user chooses to write to disk.
- `attempts.json` is the user's whole history. A change that writes to it must never lose or overwrite what is already there.

By contributing, you agree that your contribution is released under the [MIT License](LICENSE).
