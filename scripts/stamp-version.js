// Stamp the canonical version (package.json) into every other file that must carry it.
// There is no build step and no shared version primitive across npm + Cargo/Tauri + a
// WebExtension manifest + a runtime JS constant, so this small script is how the single
// source of truth propagates. Run it after bumping package.json — npm's `version`
// lifecycle runs it automatically (see package.json "scripts"), or `npm run stamp`.
//
// Versioning is CalVer YY.M.micro (e.g. 26.7.0): micro resets per month, the whole
// string increases monotonically over time. Not cosmetic — every field is bounded by
// its strictest consumer, enforced here so a bad bump fails loudly instead of deep in a
// store upload or an MSI build:
//   - Windows MSI (Tauri's bundle): major & minor <= 255  ->  2-digit year, never 4.
//   - Chrome manifest: 1-4 integers, each 0-65535, no leading zeros.
//   - npm semver: exactly three non-negative integers.
// Dates also satisfy the "a newer version must compare greater" rule the Chrome Web
// Store and Windows Installer both enforce for updates. See CLAUDE.md and ROADMAP.md #6.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const write = (f, s) => fs.writeFileSync(path.join(root, f), s);

const version = JSON.parse(read("package.json")).version;

// Validate against the strictest consumer of each field (fail loud, fail here).
const bad = (msg) => {
  console.error(`stamp-version: invalid version "${version}" — ${msg}`);
  process.exit(1);
};
const parts = version.split(".");
if (parts.length !== 3) bad("need exactly 3 dot-separated parts (YY.M.micro)");
for (const p of parts) {
  if (!/^\d+$/.test(p)) bad(`part "${p}" is not a non-negative integer`);
  if (p.length > 1 && p[0] === "0")
    bad(`part "${p}" has a leading zero (Chrome rejects it)`);
}
const [yy, mm, micro] = parts.map(Number);
if (yy > 255)
  bad(`year ${yy} > 255 (Windows MSI major limit) — use a 2-digit year`);
if (mm > 255) bad(`month ${mm} > 255 (Windows MSI minor limit)`);
if (micro > 65535) bad(`micro ${micro} > 65535 (Chrome / MSI field limit)`);

// [file, regex whose two capture groups bracket the version value]. String-replace
// only — never JSON.parse + stringify — so hand-aligned files (manifest.json) and
// comments (Cargo.toml) keep their exact shape.
const targets = [
  ["manifest.json", /("version"\s*:\s*")[^"]*(")/],
  ["src-tauri/tauri.conf.json", /("version"\s*:\s*")[^"]*(")/],
  ["src-tauri/Cargo.toml", /(\[package\][\s\S]*?\nversion = ")[^"]*(")/],
  ["content/main.js", /(const PXLPEEP_VERSION = ")[^"]*(")/],
];

let changed = 0;
for (const [file, re] of targets) {
  const src = read(file);
  if (!re.test(src)) bad(`no version field found in ${file}`);
  const out = src.replace(re, `$1${version}$2`);
  if (out !== src) {
    write(file, out);
    console.log(`  updated ${file}`);
    changed++;
  }
}
console.log(
  `stamp-version: ${version} — ${changed} updated, ${targets.length - changed} already current.`,
);
