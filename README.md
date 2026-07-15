# CBZ2ScribeColor

CBZ2ScribeColor converts CBZ comic archives into sideloadable KFX books tuned for the Kindle Scribe Colorsoft. It creates fixed-layout comics with native facing-page spreads, Kindle Virtual Panels, black letterboxing, and a maximum artwork canvas of 1986×2648 per physical page.

Four-corner navigation uses Kindle's own synthetic Virtual Panels feature.

> [!IMPORTANT]
> This is an unofficial, independently developed tool. KPF and KFX are undocumented Amazon formats and may change. Test generated books on your own Kindle. Only convert material you have the right to use.

## What it does

For each CBZ, the tool:

1. Reads page images in natural filename order (`1.jpg`, `2.jpg`, `10.jpg`).
2. Reads bibliographic and reading-direction metadata from `ComicInfo.xml` when present.
3. Detects double-page artwork using its width-to-height ratio.
4. Splits each detected spread into its original left and right halves and places them in one native facing-page KFX section.
5. Resizes artwork without changing its aspect ratio, up to 1986×2648 pixels per physical page.
6. Encodes artwork as progressive 4:4:4 JPEGs using tuned MozJPEG compression by default.
7. Uses the artwork dimensions as the KFX logical page dimensions. This prevents Kindle's four Virtual Panels from magnifying black aspect-ratio margins.
8. Adds a black fixed-layout page background, comic flags, horizontal Virtual Panels, reading direction, cover, and native spread metadata.
9. Builds a Kindle Publishing Format (`.kpf`) package in Node.js.
10. Uses Calibre's KFX Output plugin to compile the KPF into a sideloadable `.kfx` file.
11. Writes supported ComicInfo fields into the final KFX metadata with Calibre's `ebook-meta`.

The original CBZ is never modified.

## Requirements

- [Node.js](https://nodejs.org/) 22.5 or newer. Node 22.5 introduced the built-in SQLite API used to construct KPF packages.
- [Calibre](https://calibre-ebook.com/download).
- The [KFX Output plugin](https://www.mobileread.com/forums/showthread.php?t=272407) installed in Calibre.
- [Kindle Previewer 3](https://kdp.amazon.com/en_US/help/topic/G202131170), used by KFX Output's conversion pipeline.

Windows is the primary tested platform. The tool also checks the standard macOS Calibre location and can use `calibre-debug` from `PATH` on other systems. A working KFX Output/Kindle Previewer setup is still required.

### Installing KFX Output

1. Install and start Calibre once.
2. Download the current KFX Output plugin ZIP from its MobileRead thread.
3. In Calibre, open **Preferences → Plugins → Load plugin from file**.
4. Select the downloaded plugin ZIP and restart Calibre.
5. Install Kindle Previewer 3.

The converter verifies the plugin by running:

```text
calibre-debug -r "KFX Output" -- --help
```

If Calibre is installed somewhere unusual, pass the full `calibre-debug` path with `--calibre-debug` or set the `CALIBRE_DEBUG_PATH` environment variable.

## Install

Install the command globally from npm:

```bash
npm install --global cbz2scribecolor
cbz2scribe --help
```

The installed package also provides `cbz2scribecolor` as an alias for `cbz2scribe`.

### Run without installing

Use `npx` to download and run the current release without installing it globally:

```bash
npx cbz2scribecolor "D:\Comics\Issue 001.cbz"
```

> [!NOTE]
> `npx` supplies only the CBZ2ScribeColor Node.js command. You still need Node.js 22.5 or newer, Calibre, the KFX Output plugin installed in Calibre, and Kindle Previewer 3. Ensure `calibre-debug` is discoverable in a standard Calibre installation or on `PATH`; otherwise pass `--calibre-debug <path>` or set `CALIBRE_DEBUG_PATH`.

Pass CLI options after the input path in the same way as a global installation:

```bash
npx cbz2scribecolor "D:\Comics" --output "D:\Kindle Comics" --recursive
```

### Build from source

```bash
git clone https://github.com/vertiman/CBZ2ScribeColor.git
cd CBZ2ScribeColor
npm install
npm run build
```

Run the compiled CLI directly:

```bash
node dist/cli.js --help
```

Or register the `cbz2scribe` command from the source checkout:

```bash
npm link
cbz2scribe --help
```

## Usage

Convert one CBZ into the default `kfx-output` directory:

```bash
cbz2scribe "D:\Comics\Issue 001.cbz"
```

Choose an output directory:

```bash
cbz2scribe "D:\Comics\Issue 001.cbz" --output "D:\Kindle Comics"
```

Convert every CBZ immediately inside a directory:

```bash
cbz2scribe "D:\Comics" --output "D:\Kindle Comics"
```

Convert nested directories while preserving their relative directory structure:

```bash
cbz2scribe "D:\Comics" --output "D:\Kindle Comics" --recursive
```

Write each KFX beside its source CBZ:

```bash
cbz2scribe "D:\Comics" --recursive --in-place
```

Analyze spread detection without creating files:

```bash
cbz2scribe "D:\Comics" --recursive --dry-run
```

Force right-to-left manga reading and retain the generated KPF for inspection:

```bash
cbz2scribe manga.cbz --direction rtl --keep-kpf
```

Use the former, faster JPEG encoder when conversion speed matters more than output size:

```bash
cbz2scribe manga.cbz --no-mozjpeg
```

## Command-line options

| Option | Default | Description |
| --- | --- | --- |
| `<input>` | Required | A `.cbz` file or a directory containing CBZ files. |
| `-o, --output <directory>` | `kfx-output` | Destination directory. Relative subdirectories are preserved for directory input. |
| `--in-place` | Off | Write `.kfx` and optional `.kpf` files beside each source CBZ. Overrides the practical use of `--output`. |
| `--recursive` | Off | Search below nested directories. Without it, only CBZ files directly inside the input directory are processed. |
| `--dry-run` | Off | Inspect pages, dimensions, direction, and spread detection without producing KPF/KFX files. Calibre is not required for a dry run. |
| `--direction <auto\|ltr\|rtl>` | `auto` | Reading direction. `auto` uses `ComicInfo.xml`; absent recognized manga metadata, it uses left-to-right. |
| `--wide-ratio <number>` | `1.125` | Treat a source image as a double-page spread when `width / height` is at least this value. |
| `--calibre-debug <path>` | Auto-detected | Full path to Calibre's `calibre-debug` executable. |
| `-j, --jobs <count>` | `12` | Maximum number of CBZ files prepared concurrently. Each completed KPF is then compiled through KFX Output. |
| `--keep-kpf` | Off | Keep the intermediate Kindle Publishing Format package after successful KFX compilation. Failed conversions retain their KPF for diagnosis. |
| `--no-mozjpeg` | MozJPEG on | Use the former quality-90, 4:4:4 JPEG encoder. It is much faster but produces larger page images. |
| `-h, --help` | — | Show CLI help. |

Existing destination KFX files with the same name are replaced. When processing multiple files, successful conversions are retained even if another input fails; the command exits non-zero and reports every failed filename at the end.

## ComicInfo metadata

When `ComicInfo.xml` exists, the following fields are mapped into native KPF/KFX metadata where supported:

| ComicInfo fields | KFX use |
| --- | --- |
| `Title` | Title and title sort |
| `Writer`, `Penciller`, `Inker`, `Colorist`, `Letterer`, `CoverArtist`, `Editor` | Creators/authors |
| `Publisher` | Publisher |
| `Summary` | Description/comments |
| `LanguageISO` | Language |
| `Year`, `Month`, `Day` | Publication date |
| `Genre`, `Tags`, `Characters`, `Teams`, `Locations`, `StoryArc` | Subjects/tags |
| `Series`, `Number` | Series and index when accepted by Calibre's KFX metadata writer |
| `Manga` containing `RightToLeft` | Right-to-left reading direction |

If a filename begins with a reading-order prefix such as `003 - `, that prefix is added to the native title unless the ComicInfo title already starts with it. Without ComicInfo, the filename becomes the title and reading direction defaults to LTR.

KFX has no general-purpose container entry for preserving the original `ComicInfo.xml` file, so the source XML itself is not embedded. The CBZ remains unchanged.

## Pages, spreads, and margins

Single pages are resized to fit within 1986×2648 while preserving aspect ratio. The KFX page background is black.

A source image whose width-to-height ratio meets `--wide-ratio` is treated as a spread. It is split once at its horizontal midpoint. The two original halves become paired physical pages in a native facing section:

- In portrait mode, Kindle can display each half independently.
- In landscape mode, supported Kindle firmware can show the pair as a combined spread.
- The original center gutter remains continuous because no padding is inserted between the halves.

KFX image resources contain only the resized artwork bounds. Letterboxing is provided by the black logical page background rather than being baked into those resources. Kindle's synthetic four-corner Virtual Panels therefore divide and magnify the artwork rather than including top, bottom, or outside-edge bars.

## JPEG compression

Page artwork is encoded by default with Sharp's built-in MozJPEG mode using progressive scans and 4:4:4 chroma sampling. The quality and quantization-table settings were calibrated against the previous quality-90 JPEG encoder, rather than assuming that equal numeric quality values produce equal fidelity with different quantization tables. No additional MozJPEG executable or package is required.

An encoder-only benchmark on this project's primary Windows test PC used three full comics: 82 source images producing 87 physical pages, including five split spreads. Every candidate encoded the same resized, uncompressed pixels.

| Encoder | Page data | JPEG encode time | PSNR | Mean global SSIM |
| --- | ---: | ---: | ---: | ---: |
| Previous quality-90, 4:4:4 JPEG | 123.28 MiB | 3.5 s | 40.12 dB | 0.99958 |
| Tuned MozJPEG, 4:4:4 | 98.57 MiB | 54.5 s | 40.91 dB | 0.99966 |

In this sample, MozJPEG made the image payload **20.0% smaller** while slightly improving both measured fidelity scores. JPEG encoding itself was **15.6 times slower**. Total conversion is not expected to be 15.6 times slower because CBZ reading, image decoding and resizing, KPF assembly, KFX compilation, and metadata writing are unchanged. Savings in a finished KPF or KFX can also vary with the artwork and non-image container overhead. Pass `--no-mozjpeg` to restore the benchmark's previous encoder when speed is more important than the size saving.

## Reading direction

Direction affects both page turns and the order of split spread halves:

- `ltr`: left half, then right half.
- `rtl`: right half, then left half.
- `auto`: right-to-left when ComicInfo's `Manga` field contains `RightToLeft`; otherwise left-to-right.

Use `--direction` when an archive has missing or incorrect metadata.

## Sideloading

Copy generated `.kfx` files to the Kindle's `documents` folder over USB. They are generated as personal documents (`PDOC`) but carry fixed-layout comic and Virtual Panel metadata.

KFX files are device-oriented output, not KDP upload sources. Keep the original CBZ and KPF if you need editable/archive sources.

## How the KPF writer works

The native TypeScript KPF writer constructs:

- a fingerprinted SQLite `book.kdf` fragment database;
- Amazon Ion structures for fixed-layout sections, image resources, reading order, cover, and metadata;
- explicit facing sections for source double-page spreads;
- `yj_fixed_layout=1` and `yj_publisher_panels=0` capability metadata;
- a Virtual Panel direction on every page template;
- black background styles and artwork-sized logical pages;
- Kindle Create-compatible KCB and manifest files.

Calibre's KFX Output plugin converts that KPF into the final KFX container. `ebook-meta` then applies the supported bibliographic fields.

## Development

```bash
npm test
npm run typecheck
npm run build
```

Tests create synthetic CBZ/KPF fixtures and verify image dimensions, spread pairing, Virtual Panel configuration, ComicInfo mapping, KPF fragment structure, and batch concurrency. End-to-end KFX compilation is not run in CI because Calibre, KFX Output, and Kindle Previewer are external desktop dependencies.

## Local processing

CBZ2ScribeColor reads local CBZ files, invokes locally installed conversion tools, and writes the generated books to the selected output directory. Source CBZ archives remain unchanged.

## Attribution and license

The native KPF writer is based on format research and the MIT-licensed implementation in [HankunYu/kindle-comic-workaround-5.19.x](https://github.com/HankunYu/kindle-comic-workaround-5.19.x). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

CBZ2ScribeColor is released under the [MIT License](LICENSE).
