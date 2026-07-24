use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // The first CLI argument, if any, is the image to open — this is how an OS file
  // association / "Open with" hands us a file, which is the whole reason the desktop
  // build exists (an extension can't own file associations).
  let image_path: Option<String> = std::env::args().nth(1);

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
