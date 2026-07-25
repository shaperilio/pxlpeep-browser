# Test images

Purpose-built image fixtures imported from the original C++ pxlpeep source
(`pxlpeep/test_images`). Each was designed to exercise a specific behavior — a format, a bit depth,
a channel/colorspace, transparency, or an awkward size. We'll extend this set over time.

Attributes below are as **.NET GDI+** reads the files (real width/height/pixel-format), useful as a
sanity reference — but they **may not reflect a TIFF's true source bit depth**: GDI can down-convert,
and pxlpeep's C++ pipeline handles 16-bit where GDI reports 8-bit. The "likely target" column is
**inferred** from filename + attributes; the author designed these, so treat it as a starting point
to confirm/annotate, not authoritative.

| file                 | bytes   | dims (GDI) | GDI pixel format | likely target (inferred)                          |
| -------------------- | ------- | ---------- | ---------------- | ------------------------------------------------- |
| `f.png`              | 2,967   | 100×100    | 24bpp RGB        | color "f", baseline PNG decode                    |
| `f.jpeg`             | 14,251  | 100×200    | 8bpp indexed     | same subject via the JPEG path                    |
| `f.bmp`              | 21,080  | 100×200    | 8bpp indexed     | same subject via the BMP path                     |
| `f.tif`              | 39,396  | 100×200    | 8bpp indexed     | same subject via the TIFF path                    |
| `100x100 f grey.tif` | 31,748  | 100×100    | 8bpp indexed     | greyscale "f"                                     |
| `33x100 f grey.tif`  | 22,648  | 33×100     | 8bpp indexed     | greyscale, non-square / odd width                 |
| `3x5 grey.tif`       | 18,100  | 3×5        | 8bpp indexed     | tiny greyscale, extreme-zoom per-pixel readout    |
| `2x2.png`            | 956     | 4×4        | 32bpp ARGB       | tiny exact-pixel render (name says 2×2 — verify)  |
| `4x4 1bit.png`       | 144     | 4×4        | 1bpp indexed     | 1-bit bitmap, PNG                                 |
| `4x4 1bit.tif`       | 17,028  | 4×4        | 1bpp indexed     | 1-bit bitmap, TIFF                                |
| `trans.png`          | 2,811   | 4×4        | 32bpp ARGB       | transparency / alpha handling                     |
| `CMYK.tif`           | 574,572 | 4×4        | CMYK             | CMYK colorspace handling                          |
| `test.tif`           | 73,504  | 317×159    | 8bpp indexed     | general / larger image                            |
| `test2.tif`          | 74,420  | 317×159    | 8bpp indexed     | general / larger image                            |

Browsers can't decode TIFF or CMYK today, so several of these currently exercise **only the desktop
build** (or the future in-JS TIFF decoder — see `ROADMAP.md` Feature #5).
