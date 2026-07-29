use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // The first CLI argument, if any, is the image to open — this is how an OS file
  // association / "Open with" hands us a file, which is the whole reason the desktop
  // build exists (an extension can't own file associations).
  //
  // Canonicalize it to an absolute path so the info box always shows the full path,
  // even when launched with a relative arg (`pxlpeep .\test_images\morris.jpg`). On
  // Windows canonicalize() returns an extended-length "verbatim" path: `\\?\C:\...`
  // for a drive path, or `\\?\UNC\server\share\...` for a network share. Strip the
  // `\\?\` so the display is a plain `C:\...`, and rewrite the `\\?\UNC\` form back to
  // a real `\\server\share\...` — a bare `\\?\` strip would leave a broken
  // `UNC\server\...` that neither displays nor loads (convertFileSrc) correctly. If
  // canonicalize fails (missing file, odd path), keep the raw arg untouched.
  let image_path: Option<String> = std::env::args().nth(1).map(|p| {
    std::fs::canonicalize(&p)
      .ok()
      .map(|abs| {
        let s = abs.to_string_lossy().into_owned();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
          format!(r"\\{}", rest) // \\?\UNC\server\share -> \\server\share
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
          rest.to_string() //        \\?\C:\...          -> C:\...
        } else {
          s
        }
      })
      .unwrap_or(p)
  });

  tauri::Builder::default()
    .setup(move |app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Hand the path to the frontend *before* any page script runs, so
      // content/desktop.js can set window.__pxlpeepImageUrl synchronously and
      // main.js finds it already in place — same contract as viewer.js.
      // serde_json does the escaping (Windows paths are full of backslashes).
      let init = format!(
        "window.__pxlpeepImagePath = {};",
        serde_json::to_string(&image_path).unwrap_or_else(|_| "null".into())
      );

      WebviewWindowBuilder::new(app, "main", WebviewUrl::App("desktop.html".into()))
        .title("pxlpeep")
        .inner_size(1000.0, 700.0)
        .initialization_script(&init)
        .build()?;

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
