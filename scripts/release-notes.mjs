// Prints the notes for a GitHub release: that version's section of
// CHANGELOG.md, then how to install it. The release workflow uses it.
//
//   node scripts/release-notes.mjs 0.4.0 > notes.md
import { readFileSync } from "node:fs";

const version = String(process.argv[2] ?? "").replace(/^refs\/tags\//, "");
if (!version) {
	console.error("Usage: node scripts/release-notes.mjs <version>");
	process.exit(1);
}

const log = readFileSync("CHANGELOG.md", "utf8");
const heading = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "m");
const start = log.search(heading);
if (start < 0) {
	console.error(`CHANGELOG.md has no "## [${version}]" section. Add one before tagging.`);
	process.exit(1);
}
const rest = log.slice(start);
const next = rest.slice(1).search(/^## \[/m);
const section = (next < 0 ? rest : rest.slice(0, next + 1))
	.replace(/^## .*\n/, "") // the heading: the release has its own title
	.replace(/^\[[^\]]+\]: \S+$/gm, "") // link definitions at the foot of the file
	.trim();

console.log(`${section}

### Install or update

Download \`main.js\`, \`manifest.json\` and \`styles.css\` below into
\`<vault>/.obsidian/plugins/recall-lab/\` (or unpack \`recall-lab-${version}.zip\`,
which holds them in a \`recall-lab\` folder), then reload Obsidian and enable
**Recall Lab** under Settings → Community plugins. \`SHA256SUMS.txt\` lists each
file's checksum. Recall Lab needs the Claude Code CLI; see the README.`);
