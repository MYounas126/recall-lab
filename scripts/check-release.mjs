// Checks that the plugin is consistent enough to ship, before CI passes it or
// a release goes out.
//
//   node scripts/check-release.mjs             manifest, package and versions agree
//   node scripts/check-release.mjs --built     ...and main.js, manifest.json and styles.css exist
//   node scripts/check-release.mjs --tag 0.4.0 ...and the tag names exactly this version
//
// Obsidian finds a release by the manifest's version, so the git tag must be
// that version exactly ("0.4.0", not "v0.4.0"), and versions.json must record
// the oldest Obsidian each version runs on.
import { readFileSync, statSync } from "node:fs";

const args = process.argv.slice(2);
const tagAt = args.indexOf("--tag");
const tag = tagAt >= 0 ? String(args[tagAt + 1] ?? "").replace(/^refs\/tags\//, "") : null;
const built = args.includes("--built");

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const problems = [];
const read = (file) => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		problems.push(`${file} could not be read: ${e.message}`);
		return {};
	}
};

const manifest = read("manifest.json");
const pkg = read("package.json");
const versions = read("versions.json");

for (const key of ["id", "name", "version", "minAppVersion", "description", "author"]) {
	if (typeof manifest[key] !== "string" || !manifest[key].trim()) problems.push(`manifest.json has no "${key}".`);
}
if (manifest.id && manifest.id !== "recall-lab") problems.push(`manifest.json's id is "${manifest.id}"; installed copies are found by "recall-lab".`);
if (manifest.version && !SEMVER.test(manifest.version)) problems.push(`manifest.json's version "${manifest.version}" is not x.y.z.`);
if (manifest.minAppVersion && !SEMVER.test(manifest.minAppVersion)) problems.push(`manifest.json's minAppVersion "${manifest.minAppVersion}" is not x.y.z.`);
if (typeof manifest.isDesktopOnly !== "boolean") problems.push("manifest.json must say whether the plugin is desktop-only (isDesktopOnly).");
if (pkg.version !== manifest.version) {
	problems.push(`package.json is ${pkg.version} but manifest.json is ${manifest.version}; bump both with \`npm version <x.y.z>\`.`);
}
if (manifest.version && versions[manifest.version] !== manifest.minAppVersion) {
	problems.push(`versions.json does not map ${manifest.version} to its minAppVersion ${manifest.minAppVersion}.`);
}
if (tag !== null && tag !== manifest.version) {
	problems.push(`Tag "${tag}" does not match the plugin's version ${manifest.version}. Tag releases with the bare version, no "v".`);
}
if (built) {
	for (const file of ["main.js", "manifest.json", "styles.css"]) {
		try {
			if (!statSync(file).size) problems.push(`${file} is empty.`);
		} catch {
			problems.push(`${file} is missing; run the production build first.`);
		}
	}
}

if (problems.length) {
	for (const p of problems) console.error(`✗ ${p}`);
	process.exit(1);
}
console.log(
	`✓ Recall Lab ${manifest.version}, for Obsidian ${manifest.minAppVersion} and later` +
		(tag !== null ? `; tag ${tag} matches` : "") +
		(built ? "; release files built" : "")
);
