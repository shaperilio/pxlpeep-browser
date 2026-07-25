# Test images

Purpose-built image fixtures from the original C++ pxlpeep — each exercises a specific behavior (a
format, a bit depth, a channel/colorspace, transparency, or an awkward size). Descriptions below are
from **viewing** each image; dimensions/format are from .NET GDI+.

| file                 | bytes   | dims    | format      | content → what it exercises                                          |
| -------------------- | ------- | ------- | ----------- | ------------------------------------------------------------------- |
| `rgb.png`            | 2,967   | 100×100 | 24bpp RGB   | red / green / blue rectangles on black → 3-channel decode + R/G/B channel-solo |
| `CMYK.tif`           | 574,572 | 4×4     | CMYK        | the same colored-block idea in CMYK → CMYK decode (colors shift vs `rgb.png`) |
| `vgrad.bmp`          | 21,080  | 100×200 | 8bpp grey   | plain vertical greyscale gradient (0→255 top→bottom), BMP path       |
| `vgrad.tif`          | 39,396  | 100×200 | 8bpp grey   | same plain gradient, TIFF path                                       |
| `vgradF.jpeg`        | 14,251  | 100×200 | 8bpp grey   | that gradient **with a black "F"** on the light half, JPEG → lossy artifacts around the hard F-edges (and value drift, e.g. 251 vs the lossless 252) |
| `100x100 f grey.tif` | 31,748  | 100×100 | 8bpp grey   | white "f" on black, square                                          |
| `33x100 f grey.tif`  | 22,648  | 33×100  | 8bpp grey   | the "f" in a narrow non-square frame                                |
| `3x5 grey.tif`       | 18,100  | 3×5     | 8bpp grey   | tiny 3×5 black/white glyph → extreme-zoom per-pixel readout          |
| `4x4.png`            | 956     | 4×4     | 32bpp ARGB  | tiny 4×4 exact-pixel render (renamed from `2x2.png`; name now matches the real size) |
| `4x4 1bit.png`       | 144     | 4×4     | 1bpp        | 1-bit black square on white, PNG                                    |
| `4x4 1bit.tif`       | 17,028  | 4×4     | 1bpp        | 1-bit black square on white, TIFF                                   |
| `trans.png`          | 2,811   | 4×4     | 32bpp ARGB  | transparency / alpha handling                                       |
| `test.tif`           | 73,504  | 317×159 | 8bpp grey   | hand-drawn "Test" doodle (bubble letters + a wizard with wand & stars), B/W line-art |
| `test2.tif`          | 74,420  | 317×159 | 8bpp grey   | metadata-variant of `test.tif` (see note)                           |

**`test.tif` vs `test2.tif` — pixel-identical, differ only in metadata.** Verified: **0 differing
pixels** across all 50,403; both are uncompressed 8-bit greyscale 317×159 with the same
`BitsPerSample`/`Compression`/`Photometric` tags. The only difference is embedded metadata —
`test2.tif` carries an extra IPTC block (TIFF tag 33723) and is ~900 bytes larger; both include
Photoshop / XMP / Exif / ICC tags. So they read as two metadata-variant *saves* of the same doodle
(a photo-editor round-trip), not a deliberate pixel-difference pair. Useful as a "metadata-heavy
TIFF that must still decode to the right pixels" fixture; if that wasn't the intent, one is
redundant.

Notes:
- Every fixture here is ≤ 8-bit (or 1-bit); there is **no 16-bit fixture yet** — testing the 16-bit
  pipeline (`ROADMAP.md` Feature #5) will need one added.
- Browsers can't decode TIFF or CMYK, so those fixtures currently exercise only the desktop build
  (or the future in-JS TIFF decoder).
