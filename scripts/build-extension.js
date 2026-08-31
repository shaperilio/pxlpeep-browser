// Build the browser extension for both targets into build/chrome/ and build/firefox/ — each a
// complete, loadable unpacked extension (generated manifest + the shared source files). No more
// swapping a single root manifest.json per browser.
//
// The two browsers diverge on one manifest key (see manifest.base.json / CLAUDE.md):
//   - background: Chrome `service_worker`, Firefox `scripts` (no Firefox background SW as of 2026).
// Both use the default "spanning" incognito mode (no `incognito` key): Firefox rejects "split", and
// under split Chrome's separate incognito SW can't reliably register the context menu — so the menu
// is handled in the shared SW and incognito clicks route to the raw image URL (see background/worker.js).
// The version comes from package.json (the single source of truth) — the manifest is fully generated.
//
// Pure Node stdlib: no npm install needed to build. Usage:
//   node scripts/build-extension.js            -> both targets
//   node scripts/build-extension.js chrome     -> just one
// Output (build/) is gitignored: unpacked extensions aren't end-user-installable without the stores
// (Chrome blocks sideloading; Firefox requires AMO signing) — see BUILD.md.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

// Everything the manifest references, transitively. Deliberately NOT: content/desktop.{js,html}
// (Tauri desktop only), src-tauri/, test_images/, scripts/, node_modules/, docs.
const FILES = [
  "content/takeover.js",
  "content/imgdetect.js",
  "content/main.js",
  "background/worker.js",
  "viewer.html",
  "viewer.js",
];
const DIRS = ["loupe.iconset"];

const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const base = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.base.json"), "utf8"),
);

function manifestFor(target) {
  const background =
    target === "chrome"
      ? { service_worker: "background/worker.js" }
      : { scripts: ["background/worker.js"] };
  return {
    manifest_version: base.manifest_version,
    name: base.name,
    version: pkg.version,
    description: base.description,
    icons: base.icons,
    background,
    content_scripts: base.content_scripts,
    permissions: base.permissions,
    host_permissions: base.host_permissions,
    web_accessible_resources: base.web_accessible_resources,
  };
}

function build(target) {
  const out = path.join(root, "build", target);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  for (const f of FILES) {
    const src = path.join(root, f);
    const dst = path.join(out, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    // content/main.js carries non-ASCII UI text (…, ×, ‹ ›, °, emoji). It's loaded as an external
    // <script> where the encoding often isn't declared — notably the in-place takeover injects it
    // into the page's image document — and Firefox then decodes it as Latin-1 → mojibake. Prepend a
    // UTF-8 BOM (highest-priority encoding signal) to the shipped copy; the source stays BOM-free so
    // an editor can't silently strip it.
    if (f === "content/main.js") {
      const bytes = fs.readFileSync(src);
      const hasBom = bytes.length >= 3 && bytes.subarray(0, 3).equals(BOM);
      fs.writeFileSync(dst, hasBom ? bytes : Buffer.concat([BOM, bytes]));
    } else {
      fs.copyFileSync(src, dst);
    }
  }
  for (const d of DIRS) {
    fs.cpSync(path.join(root, d), path.join(out, d), { recursive: true });
  }
  fs.writeFileSync(
    path.join(out, "manifest.json"),
    JSON.stringify(manifestFor(target), null, 2) + "\n",
  );
  console.log(`build: build/${target}/  (${target}, v${pkg.version})`);
}

const requested = process.argv.slice(2);
const targets = requested.length ? requested : ["chrome", "firefox"];
for (const t of targets) {
  if (t !== "chrome" && t !== "firefox") {
    console.error(
      `build-extension: unknown target "${t}" — use "chrome" or "firefox"`,
    );
    process.exit(1);
  }
  build(t);
}
