import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import AdmZip from "adm-zip";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createKpfFromCbz, createKpfFromCbzBundle, planCbz } from "./cbz.js";
import { createTaskRunner } from "./concurrency.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CBZ to KPF preparation", () => {
  it("imports ComicInfo, splits spreads, and writes margin-free artwork resources", async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, "003 - Example.cbz");
    const output = join(directory, "Example.kpf");
    const comicInfo = "<ComicInfo><Title>Example</Title><Writer>Writer One</Writer><Publisher>Publisher</Publisher><Manga>YesAndRightToLeft</Manga></ComicInfo>";
    await createCbz(input, comicInfo, [[1000, 1000], [2400, 1800]]);

    const plan = await createKpfFromCbz(input, output);

    expect(plan.title).toBe("003 - Example");
    expect(plan.direction).toBe("rtl");
    expect(plan.sourcePages.map((page) => page.doublePage)).toEqual([false, true]);
    expect(plan.outputPageCount).toBe(3);
    expect(plan.comicInfoFound).toBe(true);
    const kpf = new AdmZip(output);
    expect(kpf.getEntries().filter((entry) => /^book_\d+\.jpg$/u.test(entry.entryName))).toHaveLength(3);
    const single = await sharp(kpf.getEntry("book_1.jpg")?.getData()).metadata();
    const firstHalf = await sharp(kpf.getEntry("book_2.jpg")?.getData()).metadata();
    const secondHalf = await sharp(kpf.getEntry("book_3.jpg")?.getData()).metadata();
    expect([single.width, single.height]).toEqual([1986, 1986]);
    expect([firstHalf.width, firstHalf.height]).toEqual([1765, 2648]);
    expect([secondHalf.width, secondHalf.height]).toEqual([1765, 2648]);
    expect([single.isProgressive, firstHalf.isProgressive, secondHalf.isProgressive])
      .toEqual([true, true, true]);
    expect([single.chromaSubsampling, firstHalf.chromaSubsampling, secondHalf.chromaSubsampling])
      .toEqual(["4:4:4", "4:4:4", "4:4:4"]);
    const kcb = JSON.parse(kpf.readAsText("book.kcb")) as { book_state: { book_reading_option: number; book_virtual_panelmovement: number } };
    expect(kcb.book_state.book_reading_option).toBe(2);
    expect(kcb.book_state.book_virtual_panelmovement).toBe(1);

    const databasePath = join(directory, "book.kdf");
    await writeFile(databasePath, removeKdfFingerprints(kpf.getEntry("resources/book.kdf")!.getData()));
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const sections = database.prepare("SELECT count(*) AS count FROM fragment_properties WHERE key = 'element_type' AND value = 'section'").get() as { count: number };
    database.close();
    expect(sections.count).toBe(2);
  });

  it("uses filename metadata and an explicit direction when ComicInfo is absent", async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, "010 - No Metadata.cbz");
    await createCbz(input, undefined, [[1000, 1500]]);

    const plan = await planCbz(input, { direction: "rtl" });

    expect(plan.title).toBe("010 - No Metadata");
    expect(plan.direction).toBe("rtl");
    expect(plan.comicInfoFound).toBe(false);
  });

  it("can use the faster legacy JPEG encoder", async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, "Fast.cbz");
    const output = join(directory, "Fast.kpf");
    await createCbz(input, undefined, [[1000, 1500]]);

    await createKpfFromCbz(input, output, { jpegEncoder: "legacy" });

    const page = await sharp(new AdmZip(output).getEntry("book_1.jpg")?.getData()).metadata();
    expect(page.isProgressive).toBe(false);
    expect(page.chromaSubsampling).toBe("4:4:4");
  });

  it("reports a missing JPEGli executable", async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, "Jpegli.cbz");
    const output = join(directory, "Jpegli.kpf");
    await createCbz(input, undefined, [[100, 150]]);

    await expect(createKpfFromCbz(input, output, {
      jpegEncoder: "jpegli",
      cjpegliPath: join(directory, "missing-cjpegli"),
    })).rejects.toThrow("Could not start cjpegli");
  });

  it("combines multiple CBZ files in order and uses the bundle title as metadata", async () => {
    const directory = await temporaryDirectory();
    const first = join(directory, "001 First.cbz");
    const second = join(directory, "002 Second.cbz");
    const output = join(directory, "Collected Edition - 001.kpf");
    await createCbz(first, "<ComicInfo><Title>First</Title><Writer>Bundle Author</Writer></ComicInfo>", [[800, 1200]]);
    await createCbz(second, "<ComicInfo><Title>Second</Title></ComicInfo>", [[900, 1200], [1000, 1200]]);

    const plan = await createKpfFromCbzBundle(
      [first, second],
      output,
      "Collected Edition - 001",
      { jpegEncoder: "legacy", pageTaskRunner: createTaskRunner(3) },
    );

    expect(plan.title).toBe("Collected Edition - 001");
    expect(plan.metadata.title).toBe("Collected Edition - 001");
    expect(plan.metadata.creators).toEqual(["Bundle Author"]);
    expect(plan.books.map((book) => book.inputPath)).toEqual([first, second]);
    expect(plan.outputPageCount).toBe(3);
    const kpf = new AdmZip(output);
    expect(kpf.getEntries().filter((entry) => /^book_\d+\.jpg$/u.test(entry.entryName))).toHaveLength(3);
    const dimensions = await Promise.all([1, 2, 3].map(async (index) => {
      const metadata = await sharp(kpf.getEntry(`book_${index}.jpg`)?.getData()).metadata();
      return [metadata.width, metadata.height];
    }));
    expect(dimensions).toEqual([[1765, 2648], [1986, 2648], [1986, 2383]]);
    const kcb = JSON.parse(kpf.readAsText("book.kcb")) as { metadata: { title: string } };
    expect(kcb.metadata.title).toBe("Collected Edition - 001");
    const databasePath = join(directory, "bundle-book.kdf");
    await writeFile(databasePath, removeKdfFingerprints(kpf.getEntry("resources/book.kdf")!.getData()));
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const navigation = database.prepare("SELECT payload_value FROM fragments WHERE id = 'book_navigation'").get() as { payload_value: Buffer };
    database.close();
    const navigationData = Buffer.from(navigation.payload_value);
    expect(navigationData.length).toBeGreaterThan(4);
    expect(navigationData.includes(Buffer.from("First"))).toBe(true);
    expect(navigationData.includes(Buffer.from("Second"))).toBe(true);
  }, 20_000);

  it("writes PanelView sidecars as native publisher panels", async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, "Guided.cbz");
    const output = join(directory, "Guided.kpf");
    await createCbz(input, "<ComicInfo><Title>Guided</Title></ComicInfo>", [[600, 900]], [[
      { order: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.4, maskColor: "#123456", maskOpacity: 0.8 },
    ]]);

    const plan = await createKpfFromCbzBundle([input], output, "Guided Bundle", { jpegEncoder: "legacy" });

    expect(plan.authoredPanelCount).toBe(1);
    expect(plan.fallbackPageCount).toBe(0);
    const kpf = new AdmZip(output);
    const kcb = JSON.parse(kpf.readAsText("book.kcb")) as { book_state: { book_reading_option: number } };
    expect(kcb.book_state.book_reading_option).toBe(1);
    const databasePath = join(directory, "guided-book.kdf");
    await writeFile(databasePath, removeKdfFingerprints(kpf.getEntry("resources/book.kdf")!.getData()));
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const structures = database.prepare("SELECT count(*) AS count FROM fragment_properties WHERE key = 'element_type' AND value = 'structure'").get() as { count: number };
    const styles = database.prepare("SELECT count(*) AS count FROM fragment_properties WHERE key = 'element_type' AND value = 'style'").get() as { count: number };
    database.close();
    expect(structures.count).toBe(7);
    expect(styles.count).toBe(2);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "cbz2scribe-test-"));
  temporaryDirectories.push(path);
  return path;
}

async function createCbz(
  path: string,
  comicInfo: string | undefined,
  dimensions: Array<[number, number]>,
  panels?: unknown[][],
): Promise<void> {
  const zip = new AdmZip();
  for (const [zeroIndex, [width, height]] of dimensions.entries()) {
    zip.addFile(`${String(zeroIndex + 1).padStart(3, "0")}.png`, await sharp({ create: { width, height, channels: 3, background: "white" } }).png().toBuffer());
  }
  if (comicInfo) zip.addFile("ComicInfo.xml", Buffer.from(comicInfo));
  if (panels) zip.addFile("PanelView.json", Buffer.from(JSON.stringify({
    version: 1,
    pages: panels.map((pagePanels, index) => ({ image: `${String(index + 1).padStart(3, "0")}.png`, panels: pagePanels })),
  })));
  await new Promise<void>((resolvePromise, reject) => zip.writeZip(path, (error) => error ? reject(error) : resolvePromise()));
}

function removeKdfFingerprints(data: Buffer): Buffer {
  const parts: Buffer[] = [data.subarray(0, 1024)];
  for (let offset = 1024; offset < data.length;) {
    expect(data.subarray(offset, offset + 4)).toEqual(Buffer.from([0xfa, 0x50, 0x0a, 0x5f]));
    offset += 1024;
    const next = Math.min(offset + 1024 * 1024, data.length);
    parts.push(data.subarray(offset, next));
    offset = next;
  }
  return Buffer.concat(parts);
}
