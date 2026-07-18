import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import AdmZip from "adm-zip";
import archiver from "archiver";
import sharp from "sharp";

const TARGET_WIDTH = 1986;
const TARGET_HEIGHT = 2648;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".tif", ".tiff"]);
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

interface PanelBox {
  order: number;
  x: number;
  y: number;
  width: number;
  height: number;
  maskColor: string;
  maskOpacity: number;
}

interface SidecarPage {
  image: string;
  panels: PanelBox[];
  fallback?: boolean;
}

interface PanelSidecar {
  version: number;
  pages: SidecarPage[];
}

interface PreparedPage {
  index: number;
  imageName: string;
  data: Buffer;
  width: number;
  height: number;
  panels: PanelBox[];
  position: "left" | "right" | "center";
}

interface Chapter {
  title: string;
  firstPage: number;
}

export interface GuidedBundlePlan {
  title: string;
  sourceCount: number;
  pageCount: number;
  authoredPanelCount: number;
  fallbackPageCount: number;
  creators: string[];
  publisher: string;
  description: string;
  language: string;
  date: string;
  subjects: string[];
  direction: "ltr" | "rtl";
}

export interface GuidedBundleOptions {
  direction?: "ltr" | "rtl" | "auto";
  wideRatio?: number;
}

export function hasPanelView(inputPath: string): boolean {
  const zip = new AdmZip(resolve(inputPath));
  return zip.getEntries().some((entry) => !entry.isDirectory && basename(entry.entryName).toLowerCase() === "panelview.json");
}

export async function createGuidedEpubBundle(
  inputPaths: string[],
  outputPath: string,
  title: string,
  options: GuidedBundleOptions = {},
): Promise<GuidedBundlePlan> {
  if (inputPaths.length === 0) throw new Error("Cannot create a Guided View bundle without CBZ files");
  const wideRatio = options.wideRatio ?? 1.125;
  const pages: PreparedPage[] = [];
  const chapters: Chapter[] = [];
  let inheritedMetadata: ReturnType<typeof parseComicInfo> | undefined;
  let authoredPanelCount = 0;
  let fallbackPageCount = 0;

  for (const inputPath of inputPaths) {
    const zip = new AdmZip(resolve(inputPath));
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
    const images = entries.filter((entry) => IMAGE_EXTENSIONS.has(extname(entry.entryName).toLowerCase()) && !basename(entry.entryName).startsWith("._"))
      .sort((a, b) => natural.compare(a.entryName, b.entryName));
    if (images.length === 0) throw new Error(`${basename(inputPath)} contains no supported images`);
    const comicInfo = entries.find((entry) => basename(entry.entryName).toLowerCase() === "comicinfo.xml")?.getData().toString("utf8") ?? "";
    const metadata = parseComicInfo(comicInfo, basename(inputPath, extname(inputPath)));
    inheritedMetadata ??= metadata;
    const direction = options.direction && options.direction !== "auto" ? options.direction : metadata.direction;
    const sidecarEntry = entries.find((entry) => basename(entry.entryName).toLowerCase() === "panelview.json");
    const sidecar = sidecarEntry ? parseSidecar(sidecarEntry.getData().toString("utf8"), images.length) : undefined;
    chapters.push({ title: metadata.title, firstPage: pages.length + 1 });

    for (const [sourceIndex, image] of images.entries()) {
      const source = sharp(image.getData(), { animated: false }).rotate().flatten({ background: "#000000" });
      const info = await source.metadata();
      const sourceWidth = info.width ?? 0;
      const sourceHeight = info.height ?? 0;
      if (!sourceWidth || !sourceHeight) throw new Error(`Could not read ${image.entryName}`);
      const sourcePanels = validatePanels(sidecar?.pages[sourceIndex]?.panels ?? []);
      const isSpread = sourceWidth / sourceHeight >= wideRatio;
      const halves = isSpread
        ? (direction === "rtl"
          ? [{ side: "right" as const, left: Math.floor(sourceWidth / 2), width: Math.ceil(sourceWidth / 2) }, { side: "left" as const, left: 0, width: Math.floor(sourceWidth / 2) }]
          : [{ side: "left" as const, left: 0, width: Math.floor(sourceWidth / 2) }, { side: "right" as const, left: Math.floor(sourceWidth / 2), width: Math.ceil(sourceWidth / 2) }])
        : [{ side: "center" as const, left: 0, width: sourceWidth }];
      for (const half of halves) {
        const bounds = contain(half.width, sourceHeight);
        const transformed = isSpread ? panelsForHalf(sourcePanels, half.left / sourceWidth, half.width / sourceWidth) : sourcePanels;
        const fallback = transformed.length === 0;
        const panelBoxes = fallback ? quadrantPanels(direction) : transformed;
        if (fallback) fallbackPageCount += 1;
        else authoredPanelCount += panelBoxes.length;
        const index = pages.length + 1;
        pages.push({
          index,
          imageName: `page-${String(index).padStart(5, "0")}.jpg`,
          data: await source.clone().extract({ left: half.left, top: 0, width: half.width, height: sourceHeight })
            .resize(bounds.width, bounds.height, { fit: "fill" })
            .jpeg({ quality: 76, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer(),
          width: bounds.width,
          height: bounds.height,
          panels: panelBoxes,
          position: half.side,
        });
      }
    }
  }

  const metadata = inheritedMetadata ?? parseComicInfo("", title);
  const plan: GuidedBundlePlan = {
    title,
    sourceCount: inputPaths.length,
    pageCount: pages.length,
    authoredPanelCount,
    fallbackPageCount,
    creators: metadata.creators,
    publisher: metadata.publisher,
    description: metadata.description,
    language: metadata.language,
    date: metadata.date,
    subjects: metadata.subjects,
    direction: options.direction && options.direction !== "auto" ? options.direction : metadata.direction,
  };
  await writeEpub(resolve(outputPath), plan, pages, chapters);
  return plan;
}

function parseSidecar(source: string, imageCount: number): PanelSidecar {
  const value = JSON.parse(source) as PanelSidecar;
  if (value.version !== 1 || !Array.isArray(value.pages) || value.pages.length !== imageCount) {
    throw new Error(`PanelView.json must be version 1 with ${imageCount} pages`);
  }
  return value;
}

function validatePanels(panels: PanelBox[]): PanelBox[] {
  return panels.filter((panel) => Number.isFinite(panel.x) && Number.isFinite(panel.y)
    && Number.isFinite(panel.width) && Number.isFinite(panel.height)
    && panel.x >= 0 && panel.y >= 0 && panel.width > 0 && panel.height > 0
    && panel.x + panel.width <= 1.000001 && panel.y + panel.height <= 1.000001)
    .sort((a, b) => a.order - b.order)
    .map((panel, index) => ({
      ...panel,
      order: index + 1,
      maskColor: /^#[0-9a-f]{6}$/iu.test(panel.maskColor) ? panel.maskColor : "#000000",
      maskOpacity: Number.isFinite(panel.maskOpacity) ? Math.max(0, Math.min(1, panel.maskOpacity)) : 1,
    }));
}

function panelsForHalf(panels: PanelBox[], halfX: number, halfWidth: number): PanelBox[] {
  const right = halfX + halfWidth;
  return panels.flatMap((panel): PanelBox[] => {
    const left = Math.max(panel.x, halfX);
    const clippedRight = Math.min(panel.x + panel.width, right);
    if (clippedRight - left <= 0.002) return [];
    return [{ ...panel, x: (left - halfX) / halfWidth, width: (clippedRight - left) / halfWidth }];
  }).map((panel, index) => ({ ...panel, order: index + 1 }));
}

function quadrantPanels(direction: "ltr" | "rtl"): PanelBox[] {
  const xs = direction === "rtl" ? [0.5, 0] : [0, 0.5];
  return [
    { order: 1, x: xs[0]!, y: 0, width: 0.5, height: 0.5, maskColor: "#000000", maskOpacity: 1 },
    { order: 2, x: xs[1]!, y: 0, width: 0.5, height: 0.5, maskColor: "#000000", maskOpacity: 1 },
    { order: 3, x: xs[0]!, y: 0.5, width: 0.5, height: 0.5, maskColor: "#000000", maskOpacity: 1 },
    { order: 4, x: xs[1]!, y: 0.5, width: 0.5, height: 0.5, maskColor: "#000000", maskOpacity: 1 },
  ];
}

function contain(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(TARGET_WIDTH / width, TARGET_HEIGHT / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function writeEpub(path: string, plan: GuidedBundlePlan, pages: PreparedPage[], chapters: Chapter[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const output = createWriteStream(temp);
      const archive = archiver("zip", { zlib: { level: 0 } });
      output.on("close", resolvePromise);
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      archive.append(Buffer.from("application/epub+zip"), { name: "mimetype", store: true });
      archive.append(Buffer.from(containerXml()), { name: "META-INF/container.xml" });
      archive.append(Buffer.from(contentOpf(plan, pages)), { name: "OEBPS/content.opf" });
      archive.append(Buffer.from(navXhtml(plan.title, chapters)), { name: "OEBPS/nav.xhtml" });
      archive.append(Buffer.from(tocNcx(plan.title, chapters)), { name: "OEBPS/toc.ncx" });
      archive.append(Buffer.from(css()), { name: "OEBPS/comic.css" });
      for (const page of pages) {
        archive.append(page.data, { name: `OEBPS/images/${page.imageName}` });
        archive.append(Buffer.from(pageXhtml(page)), { name: `OEBPS/pages/page-${page.index}.xhtml` });
      }
      void archive.finalize();
    });
    await rm(path, { force: true });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function pageXhtml(page: PreparedPage): string {
  const panels = page.panels.map((panel) => panelMarkup(page, panel)).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Page ${page.index}</title>
<meta name="viewport" content="width=${page.width}, height=${page.height}"/><link rel="stylesheet" href="../comic.css" type="text/css"/></head>
<body style="width:${page.width}px;height:${page.height}px"><img class="page" src="../images/${page.imageName}" alt="Page ${page.index}"/>
${panels}</body></html>`;
}

function panelMarkup(page: PreparedPage, panel: PanelBox): string {
  const id = `p${page.index}-${panel.order}`;
  const scale = Math.min(3, Math.min(1 / panel.width, 1 / panel.height));
  const imageWidth = page.width * scale;
  const imageHeight = page.height * scale;
  const left = (page.width - panel.width * imageWidth) / 2 - panel.x * imageWidth;
  const top = (page.height - panel.height * imageHeight) / 2 - panel.y * imageHeight;
  const magnify = xmlAttr(JSON.stringify({ targetId: `${id}-target`, ordinal: panel.order }));
  return `<div class="tap" style="left:${px(panel.x * page.width)};top:${px(panel.y * page.height)};width:${px(panel.width * page.width)};height:${px(panel.height * page.height)}"><a class="app-amzn-magnify" data-app-amzn-magnify='${magnify}'>&#160;</a></div>
<div id="${id}-target" class="target" style="width:${page.width}px;height:${page.height}px;background:${panel.maskColor};opacity:${panel.maskOpacity}"><img src="../images/${page.imageName}" style="width:${px(imageWidth)};height:${px(imageHeight)};left:${px(left)};top:${px(top)}" alt="Panel ${panel.order}"/></div>`;
}

function contentOpf(plan: GuidedBundlePlan, pages: PreparedPage[]): string {
  const pageItems = pages.map((page) => `<item id="p${page.index}" href="pages/page-${page.index}.xhtml" media-type="application/xhtml+xml"/>`).join("\n");
  const imageItems = pages.map((page, index) => `<item id="i${page.index}" href="images/${page.imageName}" media-type="image/jpeg"${index === 0 ? ' properties="cover-image"' : ""}/>`).join("\n");
  const spine = pages.map((page) => `<itemref idref="p${page.index}" linear="yes" properties="page-spread-${page.position}"/>`).join("\n");
  const creators = plan.creators.map((creator) => `<dc:creator>${xml(creator)}</dc:creator>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id" prefix="rendition: http://www.idpf.org/vocab/rendition/#"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:${randomUUID()}</dc:identifier><dc:title>${xml(plan.title)}</dc:title>${creators}<dc:language>${xml(plan.language)}</dc:language><dc:publisher>${xml(plan.publisher)}</dc:publisher><dc:description>${xml(plan.description)}</dc:description><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/u, "Z")}</meta><meta name="fixed-layout" content="true"/><meta name="book-type" content="comic"/><meta name="RegionMagnification" content="true"/><meta name="region-mag" content="true"/><meta name="orientation-lock" content="none"/><meta name="original-resolution" content="${TARGET_WIDTH}x${TARGET_HEIGHT}"/><meta property="rendition:layout">pre-paginated</meta><meta property="rendition:orientation">auto</meta><meta property="rendition:spread">landscape</meta><meta name="cover" content="i1"/></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="comic.css" media-type="text/css"/>${pageItems}${imageItems}</manifest><spine toc="ncx" page-progression-direction="${plan.direction === "rtl" ? "rtl" : "ltr"}">${spine}</spine></package>`;
}

function navXhtml(title: string, chapters: Chapter[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${xml(title)}</title></head><body><nav epub:type="toc"><ol>${chapters.map((chapter) => `<li><a href="pages/page-${chapter.firstPage}.xhtml">${xml(chapter.title)}</a></li>`).join("")}</ol></nav></body></html>`;
}

function tocNcx(title: string, chapters: Chapter[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>${xml(title)}</text></docTitle><navMap>${chapters.map((chapter, index) => `<navPoint id="c${index + 1}" playOrder="${index + 1}"><navLabel><text>${xml(chapter.title)}</text></navLabel><content src="pages/page-${chapter.firstPage}.xhtml"/></navPoint>`).join("")}</navMap></ncx>`;
}

function containerXml(): string { return `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`; }
function css(): string { return `html,body{margin:0;padding:0;overflow:hidden;background:#000}body{position:relative}.page{position:absolute;left:0;top:0;width:100%;height:100%}.tap{position:absolute;z-index:2}.tap a{display:block;width:100%;height:100%}.target{display:none;position:absolute;left:0;top:0;overflow:hidden;z-index:3}.target img{position:absolute}`; }

function parseComicInfo(source: string, fallbackTitle: string) {
  const value = (name: string) => decodeXml(source.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "iu"))?.[1]?.replace(/<[^>]+>/gu, "").trim() ?? "");
  const year = value("Year"); const month = value("Month"); const day = value("Day");
  return {
    title: value("Title") || fallbackTitle,
    creators: uniqueCsv([value("Writer"), value("Penciller"), value("Inker"), value("Colorist")]),
    publisher: value("Publisher"), description: value("Summary"), language: value("LanguageISO") || "en",
    date: /^\d{4}$/u.test(year) ? [year, month.padStart(2, "0"), day.padStart(2, "0")].filter(Boolean).join("-") : "",
    subjects: uniqueCsv([value("Genre"), value("Tags"), value("Characters")]),
    direction: value("Manga").toLowerCase().includes("righttoleft") ? "rtl" as const : "ltr" as const,
  };
}
function uniqueCsv(values: string[]): string[] { return values.flatMap((value) => value.split(/\s*,\s*/u)).filter(Boolean); }
function decodeXml(value: string): string { return value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"); }
function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function xmlAttr(value: string): string { return xml(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function px(value: number): string { return `${Math.round(value * 100) / 100}px`; }
