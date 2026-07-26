# Desktop smoke test — first hands-on drive

Scratch checklist for the first real drive of the Tauri desktop build. **Disposable** —
once the findings turn into fixes / ROADMAP items, delete this file. (The env-seam
follow-ups already have a permanent home in ROADMAP #6.)

## Get it running

- [ ] `npm run desktop` compiles + launches. First Rust build is slow (minutes); later runs are fast.
- [ ] **Loading an image.** The app only takes an image as `argv[1]` — no open dialog or drag-drop
      yet (both ROADMAP items). ⚠️ The exe `npm run desktop` (`tauri dev`) leaves at
      `target\debug\pxlpeep.exe` is **not standalone** — the debug binary loads the frontend from
      Tauri's dev server (`127.0.0.1:1430`), so running it on its own gives a WebView2
      "can't reach 127.0.0.1" error. To get a self-contained exe, build one with the frontend
      embedded: `npx tauri build --debug --no-bundle` (fast, no installer, devtools on), then run it
      with an **absolute** path:
      `.\src-tauri\target\debug\pxlpeep.exe "C:\full\path\to\test_images\rgb.png"`
      (relative paths may not resolve through the asset protocol). Rebuild after any frontend edit —
      a build embeds a snapshot; it doesn't hot-serve like `tauri dev`. (Loading `.\test_images` with
      a `.tif` still won't decode; use PNG/JPEG/BMP.)
- [ ] **Devtools** (right-click → Inspect; on in debug builds) — you'll want the console to poke
      `window.__pxlpeep`. If an image won't load, check `window.__pxlpeepImagePath` there.
- [ ] Use **PNG / JPEG / BMP** fixtures (`rgb.png`, `vgradF.jpeg`, `vgrad.bmp`, `trans.png`,
      `4x4.png`). The **`.tif` / CMYK fixtures will NOT load** — the desktop uses WebView2's image
      decoder, same as the browser, so TIFF is unsupported until the in-JS decoder (ROADMAP #5).

## The three env-seam questions I couldn't test headlessly (most important)

- [ ] **Reload** — Ctrl+R and F5 re-load the image without breaking. In devtools → Network, ideally
      see ONE re-fetch of the image (our `reloadImage` handler ran) rather than a full webview reload
      that blanks and rebuilds the app. Either way it should come back; the question is *which* path
      fires. WebView2 may swallow F5/Ctrl+R for its own reload before the page sees them.
- [ ] **Save** — Ctrl+S (original), Ctrl+Alt+S (mapped), Ctrl+Shift+S (screenshot), and the 💾
      toolbar buttons. **Does a file actually get written, and where** — Downloads folder, a dialog,
      or nothing? If nothing, the browser download-anchor doesn't work in WebView2 and it needs a
      native Tauri save override (the deferred follow-up). Confirm the mapped filename is the
      self-documenting one, e.g. `rgb_user_linear_grey.png`.
- [ ] **Clipboard** — Ctrl+C (copy mapped), Ctrl+Shift+C (copy screenshot); paste into Paint to
      confirm. If nothing lands, `navigator.clipboard` is blocked in WebView2 → needs a native
      clipboard override.

## Quick confirms

- [ ] Help overlay header reads **`pxlpeep 26.7.0`** (hold any unbound key, e.g. `?`, to show help).
- [ ] Console: `window.__pxlpeep.env.isDesktop === true` (the desktop.js env merge took effect).

## General smoke test (should behave exactly like the browser — same `main.js`)

- [ ] Zoom (wheel), pan (drag), Fit (Ctrl+1), 1:1 (Ctrl+2), position (Ctrl+3–7).
- [ ] Cursor info box (Space) — nested-square marker + 3 lines (X,Y / R,θ / value), snapping to
      whole pixels. Recently reworked, so eyeball it in a native window at high zoom.
- [ ] Palette cycle (V), transfer fn (F) + dip (+ / −), channels (R / G / B; Shift solos one).
- [ ] Rotate (A), flips (L / T), rulers (X), colorbar (C), info box (I).
- [ ] White balance: shift-drag an ROI, W to apply, Shift+W to reset — and confirm Fit-scale +
      colorbar update after WB (the per-channel min/max fold-in).
- [ ] Window resize keeps the WebGL canvas + overlay aligned and correct.
- [ ] Anything that feels off in a native window vs. the browser → jot it down.

---
_Findings → ROADMAP items / fixes, then delete this file._
