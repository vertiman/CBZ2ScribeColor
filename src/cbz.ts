import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import AdmZip from "adm-zip";
import sharp from "sharp";
import { createComicKpf, type KpfPage } from "./kindle-kpf.js";

export const SCRIBE_COLORSOFT_WIDTH = 1986;
export const SCRIBE_COLORSOFT_HEIGHT = 2648;

export type ReadingDirection = "ltr" | "rtl";

export interface CbzOptions {
  direction?: ReadingDirection | "auto";
  wideRatio?: number;
  mozjpeg?: boolean;
}

export interface BookMetadata {
  title: string;
  series: string;
  number: string;
  creators: string[];
  publisher: string;
  description: string;
  language: string;
  date: string;
  subjects: string[];
  direction: ReadingDirection;
}

export interface SourcePage {
  index: number;
  sourceName: string;
  width: number;
  height: number;
  ratio: number;
  doublePage: boolean;
}

export interface ConversionPlan {
  inputPath: string;
  title: string;
  direction: ReadingDirection;
  wideRatio: number;
  targetWidth: number;
  targetHeight: number;
  sourcePages: SourcePage[];
  outputPageCount: number;
  comicInfoFound: boolean;
  metadata: BookMetadata;
}

interface Inspection {
  plan: ConversionPlan;
  metadata: BookMetadata;
  imageEntries: AdmZip.IZipEntry[];
}

interface Bounds {
  width: number;
  height: number;
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".tif", ".tiff"]);
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const DEFAULT_WIDE_RATIO = 1.125;
const PAGE_BACKGROUND = "#000000";
// Table 1 at quality 76 matched or exceeded the former quality-90 encoder in the project benchmark.
const MOZJPEG_OPTIONS = {
  quality: 76,
  chromaSubsampling: "4:4:4",
  mozjpeg: true,
  quantisationTable: 1,
} as const;
const FAST_JPEG_OPTIONS = {
  quality: 90,
  chromaSubsampling: "4:4:4",
} as const;

export async function planCbz(inputPath: string, options: CbzOptions = {}): Promise<ConversionPlan> {
  return (await inspectCbz(resolve(inputPath), options)).plan;
}

export async function createKpfFromCbz(
  inputPath: string,
  outputPath: string,
  options: CbzOptions = {},
): Promise<ConversionPlan> {
  const inspection = await inspectCbz(resolve(inputPath), options);
  const pages = await preparePages(inspection, options.mozjpeg ?? true);
  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  await createComicKpf(destination, pages, {
    title: inspection.metadata.title,
    creators: inspection.metadata.creators,
    language: inspection.metadata.language,
    direction: inspection.metadata.direction,
  });
  return inspection.plan;
}

async function inspectCbz(inputPath: string, options: CbzOptions): Promise<Inspection> {
  const wideRatio = options.wideRatio ?? DEFAULT_WIDE_RATIO;
  if (!Number.isFinite(wideRatio) || wideRatio <= 0) throw new Error("wideRatio must be a positive number");

  const zip = new AdmZip(inputPath);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  const imageEntries = entries
    .filter((entry) => IMAGE_EXTENSIONS.has(extname(entry.entryName).toLowerCase()) && !basename(entry.entryName).startsWith("._"))
    .sort((a, b) => natural.compare(a.entryName, b.entryName));
  if (imageEntries.length === 0) throw new Error(`${basename(inputPath)} contains no supported images`);

  const comicInfo = entries.find((entry) => basename(entry.entryName).toLowerCase() === "comicinfo.xml")?.getData();
  const fallbackTitle = basename(inputPath, extname(inputPath));
  const metadata = parseComicInfo(comicInfo?.toString("utf8") ?? "", fallbackTitle);
  const direction = options.direction && options.direction !== "auto" ? options.direction : metadata.direction;
  const sourcePages: SourcePage[] = [];

  for (const [zeroIndex, entry] of imageEntries.entries()) {
    const imageMetadata = await sharp(entry.getData(), { animated: false }).metadata();
    let width = imageMetadata.width ?? 0;
    let height = imageMetadata.height ?? 0;
    if ([5, 6, 7, 8].includes(imageMetadata.orientation ?? 1)) [width, height] = [height, width];
    if (!width || !height) throw new Error(`Could not read image dimensions for ${entry.entryName}`);
    const ratio = width / height;
    sourcePages.push({
      index: zeroIndex + 1,
      sourceName: entry.entryName,
      width,
      height,
      ratio,
      doublePage: ratio >= wideRatio,
    });
  }

  const nativeMetadata = { ...metadata, direction };
  return {
    plan: {
      inputPath,
      title: nativeMetadata.title,
      direction,
      wideRatio,
      targetWidth: SCRIBE_COLORSOFT_WIDTH,
      targetHeight: SCRIBE_COLORSOFT_HEIGHT,
      sourcePages,
      outputPageCount: sourcePages.reduce((total, page) => total + (page.doublePage ? 2 : 1), 0),
      comicInfoFound: Boolean(comicInfo),
      metadata: nativeMetadata,
    },
    metadata: nativeMetadata,
    imageEntries,
  };
}

async function preparePages(inspection: Inspection, useMozjpeg: boolean): Promise<KpfPage[]> {
  const pages: KpfPage[] = [];
  const jpegOptions = useMozjpeg ? MOZJPEG_OPTIONS : FAST_JPEG_OPTIONS;
  for (const [sourceIndex, source] of inspection.plan.sourcePages.entries()) {
    const entry = inspection.imageEntries[sourceIndex];
    if (!entry) throw new Error(`Missing source image ${source.sourceName}`);
    const pipeline = sharp(entry.getData(), { animated: false }).rotate().flatten({ background: PAGE_BACKGROUND });

    if (!source.doublePage) {
      const bounds = containBounds(source.width, source.height);
      pages.push({
        data: await pipeline.resize(bounds.width, bounds.height, { fit: "fill" })
          .jpeg(jpegOptions).toBuffer(),
        width: bounds.width,
        height: bounds.height,
        sourceName: source.sourceName,
      });
      continue;
    }

    const leftWidth = Math.floor(source.width / 2);
    const rightWidth = source.width - leftWidth;
    const halves = inspection.plan.direction === "rtl"
      ? [
          { side: "right", left: leftWidth, width: rightWidth },
          { side: "left", left: 0, width: leftWidth },
        ]
      : [
          { side: "left", left: 0, width: leftWidth },
          { side: "right", left: leftWidth, width: rightWidth },
        ];
    const spreadPair = `source-${source.index}`;
    for (const half of halves) {
      const bounds = containBounds(half.width, source.height);
      pages.push({
        data: await pipeline.clone()
          .extract({ left: half.left, top: 0, width: half.width, height: source.height })
          .resize(bounds.width, bounds.height, { fit: "fill" })
          .jpeg(jpegOptions).toBuffer(),
        width: bounds.width,
        height: bounds.height,
        sourceName: `${source.sourceName}#${half.side}`,
        spreadPair,
      });
    }
  }
  return pages;
}

function containBounds(sourceWidth: number, sourceHeight: number): Bounds {
  const scale = Math.min(SCRIBE_COLORSOFT_WIDTH / sourceWidth, SCRIBE_COLORSOFT_HEIGHT / sourceHeight);
  return {
    width: Math.min(SCRIBE_COLORSOFT_WIDTH, Math.max(1, Math.round(sourceWidth * scale))),
    height: Math.min(SCRIBE_COLORSOFT_HEIGHT, Math.max(1, Math.round(sourceHeight * scale))),
  };
}

function parseComicInfo(source: string, fallbackTitle: string): BookMetadata {
  const value = (name: string) => decodeXml(source.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "iu"))?.[1]?.replace(/<[^>]+>/gu, "").trim() ?? "");
  const comicTitle = value("Title") || fallbackTitle;
  const readingOrderPrefix = fallbackTitle.match(/^(\d+\s*-\s*)/u)?.[1] ?? "";
  const title = readingOrderPrefix && !comicTitle.startsWith(readingOrderPrefix) ? `${readingOrderPrefix}${comicTitle}` : comicTitle;
  const creators = uniqueCsv([value("Writer"), value("Penciller"), value("Inker"), value("Colorist"), value("Letterer"), value("CoverArtist"), value("Editor")]);
  const subjects = uniqueCsv([value("Genre"), value("Tags"), value("Characters"), value("Teams"), value("Locations"), value("StoryArc")]);
  const year = value("Year");
  const monthValue = Number(value("Month"));
  const dayValue = Number(value("Day"));
  const month = Number.isSafeInteger(monthValue) && monthValue >= 1 && monthValue <= 12 ? String(monthValue).padStart(2, "0") : "";
  const day = month && Number.isSafeInteger(dayValue) && dayValue >= 1 && dayValue <= 31 ? String(dayValue).padStart(2, "0") : "";
  const date = /^\d{4}$/u.test(year) ? [year, month, day].filter(Boolean).join("-") : "";
  return {
    title,
    series: value("Series"),
    number: value("Number"),
    creators,
    publisher: value("Publisher"),
    description: value("Summary"),
    language: value("LanguageISO") || "en",
    date,
    subjects,
    direction: value("Manga").toLowerCase().includes("righttoleft") ? "rtl" : "ltr",
  };
}

function uniqueCsv(values: string[]): string[] {
  return values.flatMap((entry) => entry.split(/\s*,\s*/u)).filter(Boolean).filter((entry, index, all) => all.indexOf(entry) === index);
}

function decodeXml(value: string): string {
  return value.replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
