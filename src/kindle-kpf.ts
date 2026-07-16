import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";

// The KPF container and Ion fragment layout are based on format research and
// the MIT-licensed generator in HankunYu/kindle-comic-workaround-5.19.x.
// See THIRD_PARTY_NOTICES.md. This implementation is native Node and supports
// explicit source-spread pairs, Virtual Panels, and black artwork backgrounds.

export interface KpfPage {
  data: Buffer;
  width: number;
  height: number;
  sourceName: string;
  spreadPair?: string;
}

export interface KpfMetadata {
  title: string;
  creators: string[];
  language: string;
  direction: "ltr" | "rtl";
  virtualPanels?: "off" | "horizontal" | "vertical";
  toc?: KpfTocEntry[];
}

export interface KpfTocEntry {
  label: string;
  pageIndex: number;
}

interface PageInfo extends KpfPage {
  format: "jpg" | "png";
  filename: string;
}

interface ImageIds {
  containerEid: string;
  leafEid: string;
  resourceEid: string;
  resourceId: string;
  auxiliaryId: string;
}

interface SectionIds {
  pageIndices: number[];
  facing: boolean;
  sectionId: string;
  structureEid: string;
  storylineId: string;
  images: ImageIds[];
}

type Fragment = [id: string, payloadType: "blob" | "path", payloadValue: Buffer | string];
type FragmentProperty = [id: string, key: string, value: string];

const BVM = Buffer.from([0xe0, 0x01, 0x00, 0xea]);
const BASE32 = "0123456789ABCDEFGHJKMNPRSTUVWXYZ";
const TOOL_VERSION = "1.113.0.0";

const S = {
  formatVersion: 16,
  backgroundColor: 21,
  width: 56,
  height: 57,
  pageWidth: 66,
  pageHeight: 67,
  pageTemplateType: 140,
  sectionContent: 141,
  count: 144,
  offset: 143,
  children: 146,
  locationId: 155,
  layoutType: 156,
  nodeType: 159,
  format: 161,
  externalResource: 164,
  location: 165,
  readingOrders: 169,
  sections: 170,
  sectionId: 174,
  resourceId: 175,
  storylineId: 176,
  readingOrderName: 178,
  positionMap: 181,
  fitType: 183,
  eid: 185,
  layout: 192,
  metadata: 258,
  storyline: 259,
  section: 260,
  container: 270,
  leaf: 271,
  png: 284,
  jpg: 285,
  value: 307,
  fixed: 320,
  block: 323,
  fitBoth: 324,
  fixedLayout: 326,
  default: 351,
  fixedLayoutRtl: 375,
  fixedLayoutLtr: 376,
  absolute: 377,
  imageWidth: 422,
  imageHeight: 423,
  virtualPanelDirection: 434,
  spreadLayout: 437,
  rightToLeftBinding: 441,
  toc: 212,
  navType: 235,
  navContainerName: 239,
  navUnitName: 240,
  representation: 241,
  label: 244,
  target: 246,
  entries: 247,
  bookMetadata: 490,
  categories: 491,
  key: 492,
  categoryName: 495,
  documentData: 538,
  positionType: 546,
  rightToLeftPage: 557,
  leftToRightPage: 558,
  pageProgressionDirection: 560,
  binding: 581,
  contentFeatures: 585,
  namespace: 586,
  majorVersion: 587,
  minorVersion: 588,
  properties: 589,
  featuresList: 590,
  auxiliaryData: 597,
  selfRef: 598,
  bucketIndex: 602,
  structure: 608,
  sectionPositionIdMap: 609,
  eidHashSectionMap: 610,
  sectionPidCountMap: 611,
  resourceListRef: 613,
  bookNavigation: 389,
  navContainer: 391,
  navContainers: 392,
  navUnit: 393,
  localSourceFileName: 852,
} as const;

const LOCAL_SYMBOLS = [
  "yj.authoring.source_file_name",
  "yj.authoring.original_resource",
  "yj.authoring.preserved_original_resource",
];

class IdAllocator {
  private readonly counters = new Map<string, number>();

  next(prefix: string): string {
    const index = this.counters.get(prefix) ?? 0;
    this.counters.set(prefix, index + 1);
    return `${prefix}${toBase32(index)}`;
  }

  get total(): number {
    return [...this.counters.values()].reduce((sum, value) => sum + value, 0);
  }
}

export async function createComicKpf(outputPath: string, pages: KpfPage[], metadata: KpfMetadata): Promise<void> {
  if (pages.length === 0) throw new Error("Cannot create a KPF without pages");
  const virtualPanels = metadata.virtualPanels ?? "horizontal";
  const pageInfo = pages.map((page, index): PageInfo => ({
    ...page,
    format: detectImageFormat(page.data),
    filename: `page-${String(index + 1).padStart(4, "0")}.jpg`,
  }));
  const groups: number[][] = [];
  for (let index = 0; index < pageInfo.length;) {
    const current = pageInfo[index];
    const next = pageInfo[index + 1];
    if (current?.spreadPair && next?.spreadPair === current.spreadPair) {
      groups.push([index, index + 1]);
      index += 2;
    } else {
      groups.push([index]);
      index += 1;
    }
  }

  const ids = new IdAllocator();
  const resourceListAuxiliaryId = ids.next("d");
  const sections: SectionIds[] = groups.map((pageIndices) => ({
    pageIndices,
    facing: pageIndices.length === 2,
    sectionId: ids.next("c"),
    structureEid: ids.next("t"),
    storylineId: ids.next("l"),
    images: pageIndices.map(() => ({
      containerEid: ids.next("i"),
      leafEid: ids.next("i"),
      resourceEid: ids.next("e"),
      resourceId: ids.next("rsrc"),
      auxiliaryId: ids.next("d"),
    })),
  }));
  const sectionIds = sections.map((section) => section.sectionId);
  const pageContainerEids: string[] = Array(pageInfo.length);
  for (const section of sections) {
    for (const [imageIndex, image] of section.images.entries()) {
      pageContainerEids[section.pageIndices[imageIndex]!] = image.containerEid;
    }
  }
  const toc = (metadata.toc ?? []).map((entry) => {
    if (!entry.label.trim()) throw new Error("KPF TOC labels must not be empty");
    if (!Number.isSafeInteger(entry.pageIndex) || entry.pageIndex < 0 || entry.pageIndex >= pageInfo.length) {
      throw new Error(`KPF TOC page index is out of range: ${entry.pageIndex}`);
    }
    return { label: entry.label.trim(), targetEid: pageContainerEids[entry.pageIndex]! };
  });
  const resourceAuxiliaryIds = sections.flatMap((section) => section.images.map((image) => image.auxiliaryId));
  const fragments: Fragment[] = [];
  const fragmentProperties: FragmentProperty[] = [];
  const gcReachable = new Set<string>();
  const gcFragmentProperties: FragmentProperty[] = [];
  const addGlobal = (id: string, data: Buffer, type: string) => {
    fragments.push([id, "blob", data]);
    fragmentProperties.push([id, "element_type", type]);
    gcReachable.add(id);
  };

  addGlobal("$ion_symbol_table", buildIonSymbolTable(), "$ion_symbol_table");
  addGlobal("max_id", buildMaxId(), "max_id");
  addGlobal("book_navigation", buildBookNavigation(toc), "book_navigation");
  gcFragmentProperties.push(["book_navigation", "child", "book_navigation"]);
  addGlobal("book_metadata", buildBookMetadata(metadata.language, sections[0]!.images[0]!.resourceEid, virtualPanels), "book_metadata");
  addGlobal("content_features", buildContentFeatures(virtualPanels), "content_features");
  fragments.push(["document_data", "blob", buildDocumentData(sectionIds, resourceListAuxiliaryId, ids.total, metadata.direction, virtualPanels)]);
  fragmentProperties.push(["document_data", "element_type", "document_data"], ["document_data", "child", resourceListAuxiliaryId]);
  gcFragmentProperties.push(["document_data", "child", resourceListAuxiliaryId]);
  gcReachable.add("document_data");
  addGlobal("metadata", buildMetadata(sectionIds), "metadata");
  addGlobal(resourceListAuxiliaryId, buildResourceListAuxiliaryData(resourceListAuxiliaryId, resourceAuxiliaryIds), "auxiliary_data");

  const eidSectionMap: Array<[string, string]> = [];
  const modifiedTime = Math.floor(Date.now() / 1000);
  for (const section of sections) {
    const infos = section.pageIndices.map((index) => pageInfo[index]!);
    const displayWidths = infos.map((info) => info.width);
    const displayHeights = infos.map((info) => info.height);
    if (section.facing && displayHeights[0] !== displayHeights[1]) {
      const targetHeight = Math.max(...displayHeights);
      for (let index = 0; index < 2; index += 1) {
        if (displayHeights[index] !== targetHeight) {
          displayWidths[index] = Math.round(displayWidths[index]! * targetHeight / displayHeights[index]!);
          displayHeights[index] = targetHeight;
        }
      }
    }
    const sectionWidth = section.facing ? displayWidths.reduce((sum, width) => sum + width, 0) : displayWidths[0]!;
    const sectionHeight = Math.max(...displayHeights);
    const sid = section.sectionId;
    fragments.push([sid, "blob", buildSection(sid, section.structureEid, section.storylineId, sectionWidth, sectionHeight, section.facing, virtualPanels)]);
    fragmentProperties.push([sid, "element_type", "section"], [sid, "child", `${sid}-ad`], [sid, "child", section.storylineId]);
    gcReachable.add(sid);
    gcReachable.add(`${sid}-ad`);

    const positionMapId = `${sid}-spm`;
    fragments.push([positionMapId, "blob", section.facing
      ? buildFacingSectionPositionIdMap(sid, section.structureEid, section.images)
      : buildSectionPositionIdMap(sid, section.structureEid, section.images[0]!.containerEid, section.images[0]!.leafEid)]);
    fragmentProperties.push([positionMapId, "element_type", "section_position_id_map"]);
    gcReachable.add(positionMapId);

    fragments.push([section.storylineId, "blob", buildStoryline(section.storylineId, section.images.map((image) => image.containerEid))]);
    fragmentProperties.push([section.storylineId, "element_type", "storyline"]);
    for (const image of section.images) {
      fragmentProperties.push([section.storylineId, "child", image.containerEid]);
      gcFragmentProperties.push([section.storylineId, "child", image.containerEid]);
    }
    fragmentProperties.push([section.storylineId, "child", section.storylineId]);
    gcFragmentProperties.push([section.storylineId, "child", section.storylineId]);
    gcReachable.add(section.storylineId);

    for (const [imageIndex, image] of section.images.entries()) {
      const info = infos[imageIndex]!;
      const displayWidth = displayWidths[imageIndex]!;
      const displayHeight = displayHeights[imageIndex]!;
      fragments.push([image.containerEid, "blob", section.facing
        ? buildFacingStructureContainer(image.containerEid, displayWidth, displayHeight, image.leafEid)
        : buildStructureContainer(image.containerEid, displayWidth, displayHeight, image.leafEid)]);
      fragmentProperties.push([image.containerEid, "element_type", "structure"], [image.containerEid, "child", image.leafEid]);
      gcReachable.add(image.containerEid);
      fragments.push([image.leafEid, "blob", buildStructureLeaf(image.leafEid, displayWidth, displayHeight, image.resourceEid)]);
      fragmentProperties.push([image.leafEid, "element_type", "structure"], [image.leafEid, "child", image.resourceEid]);
      gcReachable.add(image.leafEid);
      fragments.push([image.resourceEid, "blob", buildExternalResource(image.resourceEid, info.filename, info.format === "jpg" ? S.jpg : S.png, image.resourceId, image.auxiliaryId, info.width, info.height)]);
      fragmentProperties.push([image.resourceEid, "element_type", "external_resource"], [image.resourceEid, "child", image.auxiliaryId], [image.resourceEid, "child", image.resourceId]);
      gcReachable.add(image.resourceEid);
      fragments.push([image.resourceId, "path", `res/${image.resourceId}`]);
      fragmentProperties.push([image.resourceId, "element_type", "bcRawMedia"]);
      gcReachable.add(image.resourceId);
      fragments.push([image.auxiliaryId, "blob", buildAuxiliaryData(image.auxiliaryId, image.resourceId, info.data.length, modifiedTime, info.sourceName)]);
      fragmentProperties.push([image.auxiliaryId, "element_type", "auxiliary_data"]);
      gcReachable.add(image.auxiliaryId);
      eidSectionMap.push([image.containerEid, sid], [image.leafEid, sid]);
    }
    eidSectionMap.push([sid, sid], [section.structureEid, sid]);
  }

  const bucketCount = eidSectionMap.length > 10 ? Math.max(1, Math.round(eidSectionMap.length / 10.3)) : Math.max(1, eidSectionMap.length);
  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const id = `eidbucket_${bucketIndex}`;
    const entries = eidSectionMap.filter(([eid]) => eidHashBucket(eid, bucketCount) === bucketIndex);
    addGlobal(id, buildEidHashBucket(bucketIndex, entries), "yj.eidhash_eid_section_map");
  }
  addGlobal("yj.section_pid_count_map", buildSectionPidCountMap(sections.map((section) => [section.sectionId, section.facing ? 5 : 3])), "yj.section_pid_count_map");

  const workDirectory = join(tmpdir(), `kindle-kpf-${randomUUID()}`);
  const databasePath = join(workDirectory, "book.kdf");
  try {
    await mkdir(workDirectory, { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE capabilities(key char(20), version smallint, primary key (key, version)) without rowid");
    database.exec("CREATE TABLE fragments(id char(40), payload_type char(10), payload_value blob, primary key (id))");
    database.exec("CREATE TABLE fragment_properties(id char(40), key char(40), value char(40), primary key (id, key, value)) without rowid");
    database.exec("CREATE TABLE gc_fragment_properties(id varchar(40), key varchar(40), value varchar(40), primary key (id, key, value)) without rowid");
    database.exec("CREATE TABLE gc_reachable(id varchar(40), primary key (id)) without rowid");
    database.prepare("INSERT INTO capabilities VALUES ('db.schema', 1)").run();
    const insertFragment = database.prepare("INSERT INTO fragments VALUES (?, ?, ?)");
    for (const [id, type, value] of fragments) insertFragment.run(id, type, typeof value === "string" ? Buffer.from(value) : value);
    const insertProperty = database.prepare("INSERT OR IGNORE INTO fragment_properties VALUES (?, ?, ?)");
    for (const property of fragmentProperties) insertProperty.run(...property);
    const insertGcProperty = database.prepare("INSERT OR IGNORE INTO gc_fragment_properties VALUES (?, ?, ?)");
    for (const property of gcFragmentProperties) insertGcProperty.run(...property);
    const insertReachable = database.prepare("INSERT OR IGNORE INTO gc_reachable VALUES (?)");
    for (const id of [...gcReachable].sort()) insertReachable.run(id);
    database.close();

    const kdfData = addFingerprints(await readFile(databasePath));
    const zip = new AdmZip();
    const hashes: Record<string, string> = {};
    const add = (name: string, data: Buffer) => {
      zip.addFile(name, data);
      hashes[name] = md5(data);
    };
    add("resources/book.kdf", kdfData);
    add("resources/book.kdf-journal", Buffer.alloc(0));
    add("resources/ManifestFile", Buffer.from("AmazonYJManifest\ndigital_content_manifest::{\n  version:1,\n  storage_type:\"localSqlLiteDB\",\n  digital_content_name:\"book.kdf\"\n}\n"));
    for (const section of sections) {
      for (const [imageIndex, image] of section.images.entries()) add(`resources/res/${image.resourceId}`, pageInfo[section.pageIndices[imageIndex]!]!.data);
    }
    for (const [index, page] of pageInfo.entries()) add(`book_${index + 1}.jpg`, page.data);
    const now = new Date().toUTCString();
    add("action.log", Buffer.from(`[${now}][INFO] [Action] EE NewBook\n[${now}][INFO] [Action] EE ZoomPage\n[${now}][INFO] [Action] E SaveBook - SaveforExport\n`));
    zip.addFile("book.kcb", Buffer.from(JSON.stringify({
      book_state: {
        book_fl_type: 1,
        book_input_type: 4,
        book_reading_direction: metadata.direction === "rtl" ? 2 : 1,
        book_reading_option: virtualPanels === "off" ? 1 : 2,
        book_target_type: 3,
        book_virtual_panelmovement: virtualPanels === "horizontal" ? 1 : virtualPanels === "vertical" ? 2 : 0,
      },
      content_hash: hashes,
      metadata: {
        book_path: "resources",
        edited_tool_versions: [TOOL_VERSION],
        format: "yj",
        global_styling: true,
        id: randomUUID(),
        platform: process.platform === "darwin" ? "mac" : "win",
        tool_name: "KC",
        tool_version: TOOL_VERSION,
        title: metadata.title,
        author: metadata.creators.join(", "),
      },
    }, null, 3)));
    await writeZip(zip, outputPath);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

function buildIonSymbolTable(): Buffer {
  const maxId = 851 + LOCAL_SYMBOLS.length;
  const imported = ionStruct([[4, ionString("YJ_symbols")], [5, ionInt(10)], [8, ionInt(842)]]);
  return wrap(ionAnnotation([3], ionStruct([[8, ionInt(maxId)], [6, ionList([imported])], [7, ionList(LOCAL_SYMBOLS.map(ionString))]])));
}

function buildMaxId(): Buffer {
  return wrap(ionInt(851 + LOCAL_SYMBOLS.length));
}

function buildSection(
  sectionId: string,
  structureEid: string,
  storylineId: string,
  width: number,
  height: number,
  facing: boolean,
  virtualPanels: NonNullable<KpfMetadata["virtualPanels"]>,
): Buffer {
  const structureFields: Array<[number, Buffer]> = [
    [S.selfRef, ionEidRef(structureEid)], [S.storylineId, ionEidRef(storylineId)], [S.pageWidth, ionInt(width)],
    [S.pageHeight, ionInt(height)], [S.layoutType, ionSymbol(facing ? S.spreadLayout : S.fixedLayout)],
    [S.pageTemplateType, ionSymbol(S.fixed)], [S.nodeType, ionSymbol(S.container)],
  ];
  if (!facing) structureFields.push([S.backgroundColor, ionInt(0xff000000)]);
  if (virtualPanels !== "off") structureFields.push([S.virtualPanelDirection, ionSymbol(S.rightToLeftBinding)]);
  const structure = ionAnnotation([S.structure], ionStruct(structureFields));
  return wrap(ionAnnotation([S.section], ionStruct([[S.sectionId, ionEidRef(sectionId)], [S.sectionContent, ionList([structure])]])));
}

function buildSectionPositionIdMap(sectionId: string, structureEid: string, containerEid: string, leafEid: string): Buffer {
  return wrap(ionAnnotation([S.sectionPositionIdMap], ionStruct([
    [S.sectionId, ionEidRef(sectionId)],
    [S.positionMap, ionList([[structureEid, 1], [containerEid, 2], [leafEid, 3]].map(([eid, index]) => ionList([ionInt(index as number), ionEidRef(eid as string)])))],
  ])));
}

function buildFacingSectionPositionIdMap(sectionId: string, structureEid: string, images: ImageIds[]): Buffer {
  const ids = [structureEid, images[0]!.containerEid, images[0]!.leafEid, images[1]!.containerEid, images[1]!.leafEid];
  return wrap(ionAnnotation([S.sectionPositionIdMap], ionStruct([
    [S.sectionId, ionEidRef(sectionId)],
    [S.positionMap, ionList(ids.map((eid, index) => ionList([ionInt(index + 1), ionEidRef(eid)])))],
  ])));
}

function buildStoryline(storylineId: string, containerEids: string[]): Buffer {
  return wrap(ionAnnotation([S.storyline], ionStruct([[S.storylineId, ionEidRef(storylineId)], [S.children, ionList(containerEids.map(ionEidRef))]])));
}

function buildStructureContainer(eid: string, width: number, height: number, childEid: string): Buffer {
  return wrap(ionAnnotation([S.structure], ionStruct([
    [S.selfRef, ionEidRef(eid)], [S.width, ionInt(width)], [S.height, ionInt(height)], [S.positionType, ionSymbol(S.absolute)],
    [S.layoutType, ionSymbol(S.block)], [S.nodeType, ionSymbol(S.container)], [S.backgroundColor, ionInt(0xff000000)],
    [S.children, ionList([ionEidRef(childEid)])],
  ])));
}

function buildFacingStructureContainer(eid: string, width: number, height: number, childEid: string): Buffer {
  return wrap(ionAnnotation([S.structure], ionStruct([
    [S.selfRef, ionEidRef(eid)], [S.positionType, ionSymbol(S.absolute)], [S.pageWidth, ionInt(width)], [S.pageHeight, ionInt(height)],
    [S.layoutType, ionSymbol(S.fixedLayout)], [S.pageTemplateType, ionSymbol(S.fixed)], [S.nodeType, ionSymbol(S.container)],
    [S.backgroundColor, ionInt(0xff000000)], [S.children, ionList([ionEidRef(childEid)])],
  ])));
}

function buildStructureLeaf(eid: string, width: number, height: number, resourceEid: string): Buffer {
  return wrap(ionAnnotation([S.structure], ionStruct([
    [S.selfRef, ionEidRef(eid)], [S.width, ionInt(width)], [S.height, ionInt(height)], [S.resourceId, ionEidRef(resourceEid)],
    [S.positionType, ionSymbol(S.absolute)], [S.nodeType, ionSymbol(S.leaf)], [S.fitType, ionSymbol(S.fitBoth)],
  ])));
}

function buildExternalResource(resourceEid: string, filename: string, format: number, location: string, auxiliaryId: string, width: number, height: number): Buffer {
  return wrap(ionAnnotation([S.externalResource], ionStruct([
    [S.localSourceFileName, ionString(filename)], [S.format, ionSymbol(format)], [S.location, ionString(location)],
    [S.auxiliaryData, ionEidRef(auxiliaryId)], [S.imageWidth, ionFloat(width)], [S.resourceId, ionEidRef(resourceEid)], [S.imageHeight, ionFloat(height)],
  ])));
}

function metadataItem(key: string, value: Buffer): Buffer {
  return ionStruct([[S.key, ionString(key)], [S.value, value]]);
}

function buildAuxiliaryData(id: string, location: string, size: number, modifiedTime: number, sourceName: string): Buffer {
  return wrap(ionAnnotation([S.auxiliaryData], ionStruct([
    [S.selfRef, ionEidRef(id)],
    [S.metadata, ionList([
      metadataItem("type", ionString("resource")), metadataItem("resource_stream", ionString(location)), metadataItem("size", ionString(String(size))),
      metadataItem("modified_time", ionString(String(modifiedTime))), metadataItem("location", ionString(sourceName)),
    ])],
  ])));
}

function buildResourceListAuxiliaryData(id: string, resourceIds: string[]): Buffer {
  return wrap(ionAnnotation([S.auxiliaryData], ionStruct([
    [S.selfRef, ionEidRef(id)], [S.metadata, ionList([metadataItem("auxData_resource_list", ionList(resourceIds.map(ionEidRef)))])],
  ])));
}

function readingOrder(sectionIds: string[]): Buffer {
  return ionStruct([[S.readingOrderName, ionSymbol(S.default)], [S.sections, ionList(sectionIds.map(ionEidRef))]]);
}

function buildBookNavigation(entries: Array<{ label: string; targetEid: string }>): Buffer {
  const navUnits = entries.map((entry) => ionAnnotation([S.navUnit], ionStruct([
    [S.navUnitName, ionString(entry.label)],
    [S.representation, ionStruct([[S.label, ionString(entry.label)]])],
    [S.target, ionStruct([[S.locationId, ionEidRef(entry.targetEid)], [S.offset, ionInt(0)]])],
  ])));
  const tocContainer = ionAnnotation([S.navContainer], ionStruct([
    [S.navType, ionSymbol(S.toc)],
    [S.navContainerName, ionString("toc")],
    [S.entries, ionList(navUnits)],
  ]));
  const navigation = ionStruct([
    [S.readingOrderName, ionSymbol(S.default)],
    [S.navContainers, ionList(entries.length > 0 ? [tocContainer] : [])],
  ]);
  return wrap(ionAnnotation([S.bookNavigation], ionList([navigation])));
}

function buildDocumentData(
  sectionIds: string[],
  resourceListAuxiliaryId: string,
  maxEid: number,
  direction: "ltr" | "rtl",
  virtualPanels: NonNullable<KpfMetadata["virtualPanels"]>,
): Buffer {
  return wrap(ionAnnotation([S.documentData], ionStruct([
    [S.formatVersion, ionFloat(16)], [S.pageProgressionDirection, ionSymbol(virtualPanels === "vertical" ? S.leftToRightPage : S.rightToLeftPage)], [8, ionInt(maxEid)],
    [S.layout, ionSymbol(direction === "rtl" ? S.fixedLayoutRtl : S.fixedLayoutLtr)], [S.binding, ionSymbol(S.rightToLeftBinding)],
    [S.auxiliaryData, ionStruct([[S.resourceListRef, ionEidRef(resourceListAuxiliaryId)]])], [S.readingOrders, ionList([readingOrder(sectionIds)])],
  ])));
}

function buildMetadata(sectionIds: string[]): Buffer {
  return wrap(ionAnnotation([S.metadata], ionStruct([[S.readingOrders, ionList([readingOrder(sectionIds)])]])));
}

function buildBookMetadata(
  language: string,
  coverResourceEid: string,
  virtualPanels: NonNullable<KpfMetadata["virtualPanels"]>,
): Buffer {
  const category = (name: string, values: Buffer[]) => ionStruct([[S.categoryName, ionString(name)], [S.metadata, ionList(values)]]);
  const entry = (key: string, value: Buffer) => ionStruct([[S.key, ionString(key)], [S.value, value]]);
  return wrap(ionAnnotation([S.bookMetadata], ionStruct([[S.categories, ionList([
    category("kindle_capability_metadata", [entry("yj_publisher_panels", ionInt(virtualPanels === "off" ? 1 : 0)), entry("yj_fixed_layout", ionInt(1))]),
    category("kindle_title_metadata", [entry("book_id", ionString(`P_${randomUUID().replaceAll("-", "").slice(0, 21)}`)), entry("language", ionString(language)), entry("cover_image", ionString(coverResourceEid))]),
    category("kindle_ebook_metadata", [entry("selection", ionString("enabled"))]),
    category("kindle_audit_metadata", [entry("file_creator", ionString("KC")), entry("creator_version", ionString(TOOL_VERSION))]),
  ])]])));
}

function buildContentFeatures(virtualPanels: NonNullable<KpfMetadata["virtualPanels"]>): Buffer {
  const version = ionStruct([[5, ionStruct([[S.majorVersion, ionInt(2)], [S.minorVersion, ionInt(0)]])]]);
  const feature = (key: string) => ionStruct([[S.namespace, ionString("com.amazon.yjconversion")], [S.key, ionString(key)], [S.properties, version]]);
  const features = [feature("yj_non_pdf_fixed_layout")];
  if (virtualPanels === "off") features.push(feature("yj_publisher_panels"));
  return wrap(ionAnnotation([S.contentFeatures], ionStruct([[S.selfRef, ionSymbol(S.contentFeatures)], [S.featuresList, ionList(features)]])));
}

function buildEidHashBucket(index: number, entries: Array<[string, string]>): Buffer {
  return wrap(ionAnnotation([S.eidHashSectionMap], ionStruct([
    [S.bucketIndex, ionInt(index)], [S.positionMap, ionList(entries.map(([eid, sectionId]) => ionStruct([[S.eid, ionEidRef(eid)], [S.sectionId, ionEidRef(sectionId)]])))],
  ])));
}

function buildSectionPidCountMap(entries: Array<[string, number]>): Buffer {
  return wrap(ionAnnotation([S.sectionPidCountMap], ionStruct([[S.positionMap, ionList(entries.map(([sectionId, count]) => ionStruct([[S.sectionId, ionEidRef(sectionId)], [S.count, ionInt(count)]])))]])));
}

function toBase32(value: number): string {
  if (value === 0) return "0";
  let result = "";
  for (let current = value; current > 0; current = Math.floor(current / 32)) result = BASE32[current % 32] + result;
  return result;
}

function varUInt(value: number): Buffer {
  const groups: number[] = [];
  for (let current = value; current > 0; current >>= 7) groups.unshift(current & 0x7f);
  if (groups.length === 0) groups.push(0);
  groups[groups.length - 1] = groups[groups.length - 1]! | 0x80;
  return Buffer.from(groups);
}

function descriptor(type: number, length: number): Buffer {
  return length < 14 ? Buffer.from([(type << 4) | length]) : Buffer.concat([Buffer.from([(type << 4) | 14]), varUInt(length)]);
}

function ionInt(value: number): Buffer {
  if (value === 0) return Buffer.from([0x20]);
  const bytes: number[] = [];
  for (let current = Math.abs(value); current > 0; current = Math.floor(current / 256)) bytes.unshift(current & 0xff);
  return Buffer.concat([descriptor(value < 0 ? 3 : 2, bytes.length), Buffer.from(bytes)]);
}

function ionFloat(value: number): Buffer {
  const buffer = Buffer.alloc(9);
  buffer[0] = 0x48;
  buffer.writeDoubleBE(value, 1);
  return buffer;
}

function ionSymbol(id: number): Buffer {
  if (id === 0) return Buffer.from([0x70]);
  const bytes: number[] = [];
  for (let current = id; current > 0; current = Math.floor(current / 256)) bytes.unshift(current & 0xff);
  return Buffer.concat([descriptor(7, bytes.length), Buffer.from(bytes)]);
}

function ionString(value: string): Buffer {
  const data = Buffer.from(value, "utf8");
  return Buffer.concat([descriptor(8, data.length), data]);
}

function ionList(items: Buffer[]): Buffer {
  const body = Buffer.concat(items);
  return Buffer.concat([descriptor(11, body.length), body]);
}

function ionStruct(fields: Array<[number, Buffer]>): Buffer {
  const body = Buffer.concat(fields.flatMap(([id, value]) => [varUInt(id), value]));
  return Buffer.concat([descriptor(13, body.length), body]);
}

function ionAnnotation(ids: number[], value: Buffer): Buffer {
  const annotations = Buffer.concat(ids.map(varUInt));
  const body = Buffer.concat([varUInt(annotations.length), annotations, value]);
  return Buffer.concat([descriptor(14, body.length), body]);
}

function ionEidRef(value: string): Buffer {
  return ionAnnotation([S.selfRef], ionString(value));
}

function wrap(value: Buffer): Buffer {
  return Buffer.concat([BVM, value]);
}

function eidHashBucket(eid: string, buckets: number): number {
  return [...eid].reduce((sum, character) => sum + character.charCodeAt(0), 0) % buckets;
}

function addFingerprints(data: Buffer): Buffer {
  if (data.length < 1024) return data;
  const fingerprint = Buffer.alloc(1024);
  fingerprint.set([0xfa, 0x50, 0x0a, 0x5f, 0x01, 0x00, 0x00, 0x40]);
  const parts: Buffer[] = [data.subarray(0, 1024)];
  for (let offset = 1024;;) {
    parts.push(fingerprint);
    if (offset >= data.length) break;
    const next = Math.min(offset + 1024 * 1024, data.length);
    parts.push(data.subarray(offset, next));
    offset = next;
  }
  return Buffer.concat(parts);
}

function detectImageFormat(data: Buffer): "jpg" | "png" {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  throw new Error("KPF pages must be JPEG or PNG images");
}

function md5(data: Buffer): string {
  return createHash("md5").update(data).digest("hex");
}

function writeZip(zip: AdmZip, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => zip.writeZip(outputPath, (error) => error ? reject(error) : resolve()));
}
