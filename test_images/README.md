# Test images

Purpose-built image fixtures from the original C++ pxlpeep — each exercises a specific behavior (a
format, a bit depth, a channel/colorspace, transparency, or an awkward size). Attributes were read
via .NET GDI+ and, where noted, verified against the file's own tags/pixels.

| file                 | bytes   | dims    | format         | target                                                        |
| -------------------- | ------- | ------- | -------------- | ------------------------------------------------------------- |
| `rgb.png`            | 2,967   | 100×100 | 24bpp RGB      | pure R / G / B shapes on black — the 3-channel path + R/G/B channel-solo |
| `vgrad.bmp`          | 21,080  | 100×200 | 8bpp grey      | vertical greyscale gradient (0→255 top→bottom, constant per row), BMP path |
| `vgrad.tif`          | 39,396  | 100×200 | 8bpp grey      | same vertical gradient, TIFF path                             |
| `vgradF.jpeg`        | 14,251  | 100×200 | 8bpp grey      | same vertical gradient, JPEG path — lossy (values drift, e.g. 251 vs the lossless 252) |
| `100x100 f grey.tif` | 31,748  | 100×100 | 8bpp grey      | greyscale "f", square                                         |
| `33x100 f grey.tif`  | 22,648  | 33×100  | 8bpp grey      | greyscale "f", non-square / narrow                            |
| `3x5 grey.tif`       | 18,100  | 3×5     | 8bpp grey      | tiny greyscale — extreme-zoom per-pixel readout               |
| `4x4.png`            | 956     | 4×4     | 32bpp ARGB     | tiny exact-pixel render (renamed from `2x2.png`; name now matches actual size) |
| `4x4 1bit.png`       | 144     | 4×4     | 1bpp           | 1-bit bitmap, PNG                                             |
| `4x4 1bit.tif`       | 17,028  | 4×4     | 1bpp           | 1-bit bitmap, TIFF                                            |
| `trans.png`          | 2,811   | 4×4     | 32bpp ARGB     | transparency / alpha handling                                |
| `CMYK.tif`           | 574,572 | 4×4     | CMYK           | CMYK colorspace handling                                      |
| `test.tif`           | 73,504  | 317×159 | 8bpp grey      | real photo-style image (see note below)                      |
| `test2.tif`          | 74,420  | 317×159 | 8bpp grey      | metadata-variant of `test.tif` (see note below)              |

**`test.tif` vs `test2.tif` — pixel-identical, differ only in metadata.** Verified: **0 differing
pixels** across all 50,403, and both are uncompressed 8-bit greyscale 317×159 with the same
`BitsPerSample`/`Compression`/`Photometric` tags. The only difference is embedded metadata —
`test2.tif` carries an extra IPTC block (TIFF tag 33723) and is ~900 bytes larger; both include
Photoshop / XMP / Exif / ICC tags. So they read as two metadata-variant *saves* of the same image
(likely a photo editor round-trip), not a deliberate pixel-difference pair. Useful as a
"real-world, metadata-heavy TIFF that still has to decode to the right pixels" fixture; if that
wasn't the intent, one of the two is redundant.

Notes:
- Every fixture here is ≤ 8-bit (or 1-bit); there is **no 16-bit fixture yet** — testing the 16-bit
  pipeline (`ROADMAP.md` Feature #5) will need one added.
- Browsers can't decode TIFF or CMYK, so those fixtures currently exercise only the desktop build
  (or the future in-JS TIFF decoder).
