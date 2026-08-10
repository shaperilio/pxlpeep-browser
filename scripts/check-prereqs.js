// Preflight for building the extension. The ONLY hard requirement is Node.js — the extension
// build (scripts/build-extension.js) is pure Node stdlib, so no `npm install` is needed. This
// verifies the Node version and reports clearly. It intentionally does NOT install anything:
// installing system software is invasive and platform-specific, and Node is a one-time standard
// install. (If Node is missing entirely, this script can't run at all — install it first, per
// BUILD.md, then re-run.)

const MIN_MAJOR = 18; // fs.cpSync needs 16.7+; 18 is the safe current LTS floor.

const version = process.versions.node;
const major = Number(version.split(".")[0]);
const ok = major >= MIN_MAJOR;

console.log(`Node.js       : v${version}  ${ok ? "OK" : "TOO OLD"}`);
if (!ok) {
  console.error(
    `\nNeed Node ${MIN_MAJOR}+ to build. Install the current LTS from https://nodejs.org/ and re-run.`,
  );
  process.exit(1);
}

const fs = require("fs");
const path = require("path");
const hasModules = fs.existsSync(path.join(__dirname, "..", "node_modules"));
console.log(
  `node_modules  : ${hasModules ? "present" : "absent"}  (optional — only for \`npm run format\` and the Tauri desktop app; NOT needed to build the extension)`,
);

console.log("\nReady. Build both browser packages with:  npm run build");
console.log(
  "  → build/chrome/   (load in Chrome:  chrome://extensions → Developer mode → Load unpacked)",
);
console.log(
  "  → build/firefox/  (load in Firefox: about:debugging → This Firefox → Load Temporary Add-on → pick manifest.json)",
);
