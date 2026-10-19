# Development

## Set up

You need Node.js 20 or later.

```bash
git clone https://github.com/MYounas126/recall-lab.git
cd recall-lab
npm install
```

| Command | What it does |
|---|---|
| `npm run dev` | Rebuilds `main.js` on every change. |
| `npm run build` | Type-checks, then makes a minified production `main.js`. |
| `npm test` | Runs the unit tests under Node, with a stand-in for Obsidian. |
| `npm run check` | Checks that `manifest.json`, `package.json` and `versions.json` agree. |

To try a build in Obsidian:

1. Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/recall-lab/`.
2. Reload Obsidian.

## Project layout

| Path | What it holds |
|---|---|
| `src/main.ts` | The entry point: commands, the ribbon icon, the status bar, and the note footers and memory dots. |
| `src/view.ts` | The Recall Lab pane: overview, courses, exams, labs and history. |
| `src/tasks.ts` | Every prompt sent to Claude, and the checks on what comes back. |
| `src/claude.ts` | Finds and runs the Claude Code CLI. |
| `src/store.ts` | Reads banks and courses, and saves attempts, sessions and lab progress. |
| `src/memory.ts` | The FSRS review schedule, rebuilt from the answer history. |
| `src/radar.ts`, `src/notemap.ts` | The skill radar, and the memory dots on headings. |
| `src/labs.ts`, `highlights.ts`, `blurt.ts`, `teach.ts`, `leeches.ts`, `variants.ts`, `guided.ts`, `recall.ts` | One feature each. |
| `test/` | Unit tests (see below). |
| `scripts/` | Release helpers: `check-release.mjs`, `release-notes.mjs` and `version-bump.mjs`. |

`test/run.mjs` bundles each test with esbuild, using `test/obsidian-shim.ts` in place of the `obsidian` module. It then runs the bundle with Node's built-in test runner.

## CI/CD

```mermaid
flowchart LR
    PR["Pull request"] --> CI["CI on Node 20 and 22: type-check, test, build, plus a dependency audit"]
    PR --> CR["Claude review, except drafts and bots"]
    CI --> M["Merge to main"]
    CR --> M
    M --> T["npm version x.y.z, then push the tag"]
    T --> R["Release workflow: test, build, check the tag"]
    R --> G["GitHub release: main.js, manifest.json, styles.css, zip, SHA256SUMS"]
```

| Workflow | Runs on | What it does |
|---|---|---|
| [`ci.yml`](../.github/workflows/ci.yml) | Every push to `main` and every pull request | See below. |
| [`release.yml`](../.github/workflows/release.yml) | Pushing a version tag | Builds and publishes a release. See [Releasing](#releasing). |
| [`claude-code-review.yml`](../.github/workflows/claude-code-review.yml) | Pull requests, except drafts and Dependabot's | Claude reviews the change. |
| [`claude.yml`](../.github/workflows/claude.yml) | `@claude` in an issue or review comment | Claude answers or helps with the change. |
| [Dependabot](../.github/dependabot.yml) | Weekly, on Mondays | Opens pull requests for build tooling and for the workflows' actions. |

**CI** runs on Node 20 and 22:

1. Installs exactly the versions in `package-lock.json`.
2. Type-checks, runs the tests and makes the production build.
3. Checks the manifest.

The run's summary shows the bundle size. The built plugin is kept as an artifact for 14 days, so you can try any commit in a vault.

A second CI job audits dependencies. A security advisory in a package that ships inside `main.js` fails the run. One that affects only build tooling gives a warning.

**Dependabot** leaves `ts-fsrs` alone. That package computes every review schedule, so updating it should be a deliberate change.

**The Claude workflows** need the `CLAUDE_CODE_OAUTH_TOKEN` repository secret and use your Claude plan.

## Releasing

```bash
# 1. Add a "## [0.5.0] - <date>" section to CHANGELOG.md and commit it.
# 2. Bump package.json, manifest.json and versions.json, commit, and tag 0.5.0:
npm version 0.5.0
# 3. Publish:
git push && git push origin 0.5.0
```

Pushing the tag runs `release.yml`, which does the following:

1. Type-checks, tests and builds that exact commit.
2. Refuses the tag if it doesn't match `manifest.json`.
3. Publishes a GitHub release with `main.js`, `manifest.json`, `styles.css`, a zip of the plugin folder and their SHA-256 checksums.

The release notes are that version's section of `CHANGELOG.md`.

Tags are the bare version, as Obsidian expects: `0.5.0`, not `v0.5.0`. `.npmrc` sets this up for `npm version`. A tag with a suffix, such as `0.5.0-beta.1`, is published as a pre-release.
