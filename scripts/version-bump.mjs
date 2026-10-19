// Run by `npm version <x.y.z>` (the "version" script in package.json): copies
// the new version into manifest.json and records its minimum Obsidian version
// in versions.json, which Obsidian reads to offer each user the newest release
// their app can run.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.npm_package_version;
if (!version) {
	console.error("Run this through `npm version <x.y.z>`, which sets npm_package_version.");
	process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[version] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`manifest.json and versions.json now at ${version} (Obsidian ${manifest.minAppVersion}+)`);
