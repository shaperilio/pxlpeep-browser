// Build the browser extension for both targets into build/chrome/ and build/firefox/ — each a
// complete, loadable unpacked extension (generated manifest + the shared source files). No more
// swapping a single root manifest.json per browser.
//
// The two browsers diverge on exactly two manifest keys (see manifest.base.json / CLAUDE.md):
//   - background: Chrome `service_worker`, Firefox `scripts` (no Firefox background SW as of 2026).
//   - incognito:  Chrome `"split"` (needed to load viewer.html in incognito tabs); Firefox omits it
//                 (rejects "split" → not_allowed; the "spanning" default already works there).
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
    // Chrome-only: Firefox rejects "split" (→ not_allowed) and is fine on the "spanning" default.
    ...(target === "chrome" ? { incognito: "split" } : {}),
    web_accessible_resources: base.web_accessible_resources,
  };
}

function build(target) {
  const out = path.join(root, "build", target);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const f of FILES) {
    const dst = path.join(out, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(root, f), dst);
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
