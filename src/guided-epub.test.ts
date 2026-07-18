import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createGuidedEpubBundle } from "./guided-epub.js";

describe("authored Guided View EPUB", () => {
  it("uses sidecar panels and adds one TOC chapter per CBZ", async () => {
    const root = await mkdtemp(join(tmpdir(), "guided-epub-test-"));
    const first = join(root, "001.cbz");
    const second = join(root, "002.cbz");
    await createCbz(first, "First", [{ order: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.4, maskColor: "#123456", maskOpacity: 1 }]);
    await createCbz(second, "Second", []);
    const output = join(root, "bundle.epub");
    const plan = await createGuidedEpubBundle([first, second], output, "Bundle");
    expect(plan.sourceCount).toBe(2);
    expect(plan.authoredPanelCount).toBe(1);
    expect(plan.fallbackPageCount).toBe(1);
    const epub = new AdmZip(output);
    expect(epub.readAsText("OEBPS/pages/page-1.xhtml")).toContain('background:#123456');
    expect(epub.readAsText("OEBPS/pages/page-1.xhtml").match(/class="app-amzn-magnify"/gu)).toHaveLength(1);
    expect(epub.readAsText("OEBPS/pages/page-2.xhtml").match(/class="app-amzn-magnify"/gu)).toHaveLength(4);
    expect(epub.readAsText("OEBPS/nav.xhtml")).toContain("First");
    expect(epub.readAsText("OEBPS/nav.xhtml")).toContain("Second");
  });
});

async function createCbz(path: string, title: string, panels: unknown[]): Promise<void> {
  const zip = new AdmZip();
  zip.addFile("001.jpg", await sharp({ create: { width: 600, height: 900, channels: 3, background: "white" } }).jpeg().toBuffer());
  zip.addFile("ComicInfo.xml", Buffer.from(`<ComicInfo><Title>${title}</Title><Publisher>Marvel</Publisher><LanguageISO>en</LanguageISO></ComicInfo>`));
  zip.addFile("PanelView.json", Buffer.from(JSON.stringify({ version: 1, pages: [{ image: "001.jpg", panels }] })));
  zip.writeZip(path);
}
