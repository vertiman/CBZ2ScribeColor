import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import AdmZip from "adm-zip";
import sharp from "sharp";
import type { TaskRunner } from "./concurrency.js";
import { encodeJpegli } from "./jpegli.js";
import { createComicKpf, type KpfPage, type KpfPanel, type KpfTocEntry } from "./kindle-kpf.js";

export const SCRIBE_COLORSOFT_WIDTH = 1986;
export const SCRIBE_COLORSOFT_HEIGHT = 2648;

export type ReadingDirection = "ltr" | "rtl";
export type PageJpegEncoder = "mozjpeg" | "jpegli" | "legacy";

export interface CbzOptions {
  direction?: ReadingDirection | "auto";
  wideRatio?: number;
  jpegEncoder?: PageJpegEncoder;
  cjpegliPath?: string;
  pageTaskRunner?: TaskRunner;
  includeAuthoringSources?: boolean;
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

export interface BundleConversionPlan {
  inputPaths: string[];
  title: string;
  direction: ReadingDirection;
  books: ConversionPlan[];
  outputPageCount: number;
  pageCount: number;
  authoredPanelCount: number;
  fallbackPageCount: number;
  metadata: BookMetadata;
}

interface Inspection {
  plan: ConversionPlan;
  metadata: BookMetadata;
  imageEntries: AdmZip.IZipEntry[];
  sidecarPanels?: KpfPanel[][];
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
  const jpegEncoder = options.jpegEncoder ?? "mozjpeg";
  if (!["mozjpeg", "jpegli", "legacy"].includes(jpegEncoder)) {
    throw new Error(`Unsupported JPEG encoder: ${jpegEncoder}`);
  }
  const pages = await preparePages(inspection, jpegEncoder, options.cjpegliPath, options.pageTaskRunner);
  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  await createComicKpf(destination, pages, {
    title: inspection.metadata.title,
    creators: inspection.metadata.creators,
    language: inspection.metadata.language,
    direction: inspection.metadata.direction,
    virtualPanels: pages.every((page) => page.panels?.length) ? "off" : "horizontal",
    ...(options.includeAuthoringSources === undefined ? {} : { includeAuthoringSources: options.includeAuthoringSources }),
  });
  return inspection.plan;
}

export async function planCbzBundle(
  inputPaths: string[],
  title: string,
  options: CbzOptions = {},
): Promise<BundleConversionPlan> {
  return (await inspectCbzBundle(inputPaths, title, options)).plan;
}

export async function createKpfFromCbzBundle(
  inputPaths: string[],
  outputPath: string,
  title: string,
  options: CbzOptions = {},
): Promise<BundleConversionPlan> {
  const bundle = await inspectCbzBundle(inputPaths, title, options);
  const jpegEncoder = options.jpegEncoder ?? "mozjpeg";
  if (!["mozjpeg", "jpegli", "legacy"].includes(jpegEncoder)) {
    throw new Error(`Unsupported JPEG encoder: ${jpegEncoder}`);
  }
  const pages: KpfPage[] = [];
  const toc: KpfTocEntry[] = [];
  const preparedBooks = await Promise.all(bundle.inspections.map((inspection) =>
    preparePages(inspection, jpegEncoder, options.cjpegliPath, options.pageTaskRunner)));
  for (const [bookIndex, inspection] of bundle.inspections.entries()) {
    toc.push({ label: inspection.plan.title, pageIndex: pages.length });
    const bookPages = preparedBooks[bookIndex]!;
    for (const page of bookPages) {
      pages.push({
        ...page,
        sourceName: `${basename(inspection.plan.inputPath)}/${page.sourceName}`,
        ...(page.spreadPair ? { spreadPair: `book-${bookIndex + 1}-${page.spreadPair}` } : {}),
      });
    }
  }
  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  await createComicKpf(destination, pages, {
    title: bundle.plan.title,
    creators: bundle.plan.metadata.creators,
    language: bundle.plan.metadata.language,
    direction: bundle.plan.direction,
    virtualPanels: pages.every((page) => page.panels?.length) ? "off" : "horizontal",
    ...(options.includeAuthoringSources === undefined ? {} : { includeAuthoringSources: options.includeAuthoringSources }),
    toc,
  });
  bundle.plan.authoredPanelCount = pages.filter((page) => page.panelSource === "authored").reduce((sum, page) => sum + (page.panels?.length ?? 0), 0);
  bundle.plan.fallbackPageCount = pages.filter((page) => page.panelSource === "fallback").length;
  return bundle.plan;
}

async function inspectCbzBundle(
  inputPaths: string[],
  title: string,
  options: CbzOptions,
): Promise<{ plan: BundleConversionPlan; inspections: Inspection[] }> {
  if (inputPaths.length === 0) throw new Error("Cannot create a bundle without CBZ files");
  const bundleTitle = title.trim();
  if (!bundleTitle) throw new Error("Bundle title must not be empty");
  const inspections: Inspection[] = [];
  for (const inputPath of inputPaths) inspections.push(await inspectCbz(resolve(inputPath), options));
  const direction = inspections[0]!.plan.direction;
  const mismatched = inspections.find((inspection) => inspection.plan.direction !== direction);
  if (mismatched) {
    throw new Error(`Bundle contains mixed reading directions; ${basename(mismatched.plan.inputPath)} is ${mismatched.plan.direction} while the first book is ${direction}. Pass --direction ltr or --direction rtl to override.`);
  }
  const firstMetadata = inspections[0]!.metadata;
  const metadata: BookMetadata = { ...firstMetadata, title: bundleTitle, direction };
  return {
    plan: {
      inputPaths: inspections.map((inspection) => inspection.plan.inputPath),
      title: bundleTitle,
      direction,
      books: inspections.map((inspection) => inspection.plan),
      outputPageCount: inspections.reduce((total, inspection) => total + inspection.plan.outputPageCount, 0),
      pageCount: inspections.reduce((total, inspection) => total + inspection.plan.outputPageCount, 0),
      authoredPanelCount: 0,
      fallbackPageCount: 0,
      metadata,
    },
    inspections,
  };
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
  const panelView = entries.find((entry) => basename(entry.entryName).toLowerCase() === "panelview.json")?.getData();
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

  const sidecarPanels = panelView ? parsePanelView(panelView.toString("utf8"), imageEntries.length) : undefined;

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
    ...(sidecarPanels ? { sidecarPanels } : {}),
  };
}

async function preparePages(
  inspection: Inspection,
  jpegEncoder: PageJpegEncoder,
  cjpegliPath?: string,
  pageTaskRunner?: TaskRunner,
): Promise<KpfPage[]> {
  if (pageTaskRunner) {
    const batches = await Promise.all(inspection.plan.sourcePages.map((_, sourceIndex) => pageTaskRunner(
      () => prepareSourcePage(inspection, sourceIndex, jpegEncoder, cjpegliPath),
    )));
    return batches.flat();
  }

  const batches: KpfPage[][] = [];
  for (const sourceIndex of inspection.plan.sourcePages.keys()) {
    batches.push(await prepareSourcePage(inspection, sourceIndex, jpegEncoder, cjpegliPath));
  }
  return batches.flat();
}

async function prepareSourcePage(
  inspection: Inspection,
  sourceIndex: number,
  jpegEncoder: PageJpegEncoder,
  cjpegliPath?: string,
): Promise<KpfPage[]> {
  const source = inspection.plan.sourcePages[sourceIndex];
  if (!source) throw new Error(`Missing source page at index ${sourceIndex}`);
  const entry = inspection.imageEntries[sourceIndex];
  if (!entry) throw new Error(`Missing source image ${source.sourceName}`);
  const pipeline = sharp(entry.getData(), { animated: false }).rotate().flatten({ background: PAGE_BACKGROUND });
  const sourcePanels = inspection.sidecarPanels?.[sourceIndex];

  if (!source.doublePage) {
    const bounds = containBounds(source.width, source.height);
    return [{
      data: await encodePage(
        pipeline.resize(bounds.width, bounds.height, { fit: "fill" }),
        jpegEncoder,
        cjpegliPath,
      ),
      width: bounds.width,
      height: bounds.height,
      sourceName: source.sourceName,
      ...(sourcePanels ? panelFields(sourcePanels, inspection.plan.direction) : {}),
    }];
  }

  const pages: KpfPage[] = [];
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
      data: await encodePage(
        pipeline.clone()
          .extract({ left: half.left, top: 0, width: half.width, height: source.height })
          .resize(bounds.width, bounds.height, { fit: "fill" }),
        jpegEncoder,
        cjpegliPath,
      ),
      width: bounds.width,
      height: bounds.height,
      sourceName: `${source.sourceName}#${half.side}`,
      spreadPair,
      ...(sourcePanels ? panelFields(panelsForHalf(sourcePanels, half.left / source.width, half.width / source.width), inspection.plan.direction) : {}),
    });
  }
  return pages;
}

function panelFields(panels: KpfPanel[], direction: ReadingDirection): Pick<KpfPage, "panels" | "panelSource"> {
  const authored = validatePanels(panels);
  return authored.length > 0
    ? { panels: authored, panelSource: "authored" }
    : { panels: quadrantPanels(direction), panelSource: "fallback" };
}

function parsePanelView(source: string, imageCount: number): KpfPanel[][] {
  const value = JSON.parse(source) as { version?: number; pages?: Array<{ panels?: KpfPanel[] }> };
  if (value.version !== 1 || !Array.isArray(value.pages) || value.pages.length !== imageCount) {
    throw new Error(`PanelView.json must be version 1 with ${imageCount} pages`);
  }
  return value.pages.map((page) => validatePanels(page.panels ?? []));
}

function validatePanels(panels: KpfPanel[]): KpfPanel[] {
  return panels.filter((panel) => Number.isFinite(panel.x) && Number.isFinite(panel.y)
    && Number.isFinite(panel.width) && Number.isFinite(panel.height)
    && panel.x >= 0 && panel.y >= 0 && panel.width > 0 && panel.height > 0
    && panel.x + panel.width <= 1.000001 && panel.y + panel.height <= 1.000001)
    .sort((a, b) => a.order - b.order)
    .map((panel, index) => ({
      ...panel,
      order: index + 1,
      maskColor: /^#[0-9a-f]{6}$/iu.test(panel.maskColor ?? "") ? panel.maskColor! : "#000000",
      maskOpacity: Number.isFinite(panel.maskOpacity) ? Math.max(0, Math.min(1, panel.maskOpacity!)) : 1,
    }));
}

function panelsForHalf(panels: KpfPanel[], halfX: number, halfWidth: number): KpfPanel[] {
  const right = halfX + halfWidth;
  return panels.flatMap((panel): KpfPanel[] => {
    const left = Math.max(panel.x, halfX);
    const clippedRight = Math.min(panel.x + panel.width, right);
    if (clippedRight - left <= 0.002) return [];
    return [{ ...panel, x: (left - halfX) / halfWidth, width: (clippedRight - left) / halfWidth }];
  }).map((panel, index) => ({ ...panel, order: index + 1 }));
}

function quadrantPanels(direction: ReadingDirection): KpfPanel[] {
  const xs = direction === "rtl" ? [0.5, 0] : [0, 0.5];
  return [
    { order: 1, x: xs[0]!, y: 0, width: 0.5, height: 0.5, maskColor: "#000000", maskOpacity: 1 },
    { order: 2, x: xs[1]!, y: 0, width: 0.5, height: 0.5, maskColor: "#000000", maskOpacity: 1 },
    { order: 3, x: xs[0]!, y: 0.5, width: 0.5, height: 0.5, maskColor: "#000000", maskOpacity: 1 },
    { order: 4, x: xs[1]!, y: 0.5, width: 0.5, height: 0.5, maskColor: "#000000", maskOpacity: 1 },
  ];
}

async function encodePage(
  pipeline: ReturnType<typeof sharp>,
  jpegEncoder: PageJpegEncoder,
  cjpegliPath?: string,
): Promise<Buffer> {
  if (jpegEncoder === "mozjpeg") return pipeline.jpeg(MOZJPEG_OPTIONS).toBuffer();
  if (jpegEncoder === "legacy") return pipeline.jpeg(FAST_JPEG_OPTIONS).toBuffer();

  const { data, info } = await pipeline.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`JPEGli requires RGB input; Sharp produced ${info.channels} channels`);
  return encodeJpegli(data, info.width, info.height, cjpegliPath ?? process.env.CJPEGLI_PATH ?? "cjpegli");
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
