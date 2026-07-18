import { rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { extname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createKpfFromCbzBundle } from "./cbz.js";
import { createTaskRunner } from "./concurrency.js";
import { hasPanelView, type GuidedBundleOptions, type GuidedBundlePlan } from "./guided-epub.js";
import { compileKfx, findKfxOutput } from "./kfx-output.js";

export interface ConvertBundleOptions extends GuidedBundleOptions {
  calibreDebug?: string;
  keepSource?: boolean;
  pageConcurrency?: number;
}

export async function convertCbzBundleToKfx(
  inputPaths: string[],
  outputPath: string,
  title: string,
  options: ConvertBundleOptions = {},
): Promise<GuidedBundlePlan> {
  if (!inputPaths.every(hasPanelView)) throw new Error("Every CBZ in an authored bundle must contain PanelView.json");
  const pageConcurrency = options.pageConcurrency ?? Math.min(16, availableParallelism());
  if (!Number.isSafeInteger(pageConcurrency) || pageConcurrency < 1) {
    throw new Error("pageConcurrency must be a positive integer");
  }
  const nativePool = Number.parseInt(process.env.UV_THREADPOOL_SIZE ?? "0", 10);
  if (process.env.CBZ2SCRIBE_BUNDLE_WORKER !== "1" && (!Number.isSafeInteger(nativePool) || nativePool < pageConcurrency)) {
    return convertInSizedWorker(inputPaths, outputPath, title, { ...options, pageConcurrency });
  }
  const calibre = await findKfxOutput(options.calibreDebug);
  if (!calibre) throw new Error("Calibre's KFX Output plugin was not found");
  const sourcePath = `${outputPath.slice(0, -extname(outputPath).length)}.guided.kpf`;
  const nativePlan = await createKpfFromCbzBundle(inputPaths, sourcePath, title, {
    ...options,
    pageTaskRunner: createTaskRunner(pageConcurrency),
    includeAuthoringSources: false,
  });
  const metadata = nativePlan.metadata;
  const plan: GuidedBundlePlan = {
    title: nativePlan.title,
    sourceCount: nativePlan.inputPaths.length,
    pageCount: nativePlan.pageCount,
    authoredPanelCount: nativePlan.authoredPanelCount,
    fallbackPageCount: nativePlan.fallbackPageCount,
    creators: metadata.creators,
    publisher: metadata.publisher,
    description: metadata.description,
    language: metadata.language,
    date: metadata.date,
    subjects: metadata.subjects,
    direction: nativePlan.direction,
  };
  try {
    await compileKfx(sourcePath, outputPath, calibre, {
      title: plan.title,
      creators: plan.creators,
      publisher: plan.publisher,
      description: plan.description,
      language: plan.language,
      date: plan.date,
      subjects: plan.subjects,
      series: "",
      number: "",
      direction: plan.direction,
    });
  } finally {
    if (!options.keepSource) await rm(sourcePath, { force: true });
  }
  return plan;
}

async function convertInSizedWorker(
  inputPaths: string[],
  outputPath: string,
  title: string,
  options: ConvertBundleOptions & { pageConcurrency: number },
): Promise<GuidedBundlePlan> {
  const worker = new URL("./bundle-worker.js", import.meta.url);
  const payload = JSON.stringify({ inputPaths, outputPath, title, options });
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(worker), payload], {
      env: {
        ...process.env,
        UV_THREADPOOL_SIZE: String(options.pageConcurrency),
        CBZ2SCRIBE_BUNDLE_WORKER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Parallel bundle worker exited with ${code ?? -1}.\n${stderr.slice(-4000)}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as GuidedBundlePlan);
      } catch (error) {
        reject(new Error(`Parallel bundle worker returned invalid output: ${error instanceof Error ? error.message : String(error)}\n${stderr.slice(-2000)}`));
      }
    });
  });
}

export { createGuidedEpubBundle, hasPanelView } from "./guided-epub.js";
export type { GuidedBundleOptions, GuidedBundlePlan } from "./guided-epub.js";
