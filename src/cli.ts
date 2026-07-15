#!/usr/bin/env node
import { readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { Command, Option } from "commander";
import { createKpfFromCbz, planCbz, type ConversionPlan, type ReadingDirection } from "./cbz.js";
import { runWithConcurrency } from "./concurrency.js";
import { compileKfx, findKfxOutput } from "./kfx-output.js";

interface CliOptions {
  output: string;
  inPlace: boolean;
  recursive: boolean;
  dryRun: boolean;
  direction: ReadingDirection | "auto";
  wideRatio: string;
  calibreDebug?: string;
  jobs: string;
  keepKpf: boolean;
  mozjpeg: boolean;
}

const program = new Command()
  .name("cbz2scribe")
  .description("Convert CBZ comics to sideloadable KFX for Kindle Scribe Colorsoft")
  .argument("<input>", "a CBZ file or directory containing CBZ files")
  .option("-o, --output <directory>", "output directory", "kfx-output")
  .option("--in-place", "write KFX files beside the source CBZ files", false)
  .option("--recursive", "find CBZ files recursively below the input directory", false)
  .option("--dry-run", "analyze files without writing KPF or KFX output", false)
  .addOption(new Option("--direction <direction>", "reading direction; auto uses ComicInfo.xml").choices(["auto", "ltr", "rtl"]).default("auto"))
  .option("--wide-ratio <ratio>", "minimum width/height ratio treated as a double-page spread", "1.125")
  .option("--calibre-debug <path>", "explicit path to calibre-debug with the KFX Output plugin")
  .option("-j, --jobs <count>", "maximum files processed concurrently", "12")
  .option("--keep-kpf", "retain the generated KPF source package", false)
  .option("--no-mozjpeg", "use the faster legacy JPEG encoder with larger output")
  .showHelpAfterError()
  .parse();

const input = program.args[0];
const options = program.opts<CliOptions>();

try {
  if (!input) throw new Error("input is required");
  await run(resolve(input), options);
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function run(inputPath: string, options: CliOptions): Promise<void> {
  const wideRatio = positiveNumber(options.wideRatio, "wide-ratio");
  const jobs = positiveInteger(options.jobs, "jobs");
  const inputInfo = await stat(inputPath);
  const sources = await findCbzFiles(inputPath, inputInfo.isDirectory(), options.recursive);
  if (sources.length === 0) throw new Error("No CBZ files found");

  const calibreDebug = options.dryRun ? undefined : await findKfxOutput(options.calibreDebug);
  if (!options.dryRun && !calibreDebug) {
    throw new Error("Calibre's KFX Output plugin was not found. Install Calibre, Kindle Previewer 3, and KFX Output, or pass --calibre-debug <path>.");
  }
  if (calibreDebug) console.log(`Using KFX Output through: ${calibreDebug}`);

  const outputRoot = resolve(options.output);
  const failures: string[] = [];
  const concurrency = Math.min(jobs, sources.length);
  if (sources.length > 1) console.log(`Processing ${sources.length} files with up to ${concurrency} concurrent jobs`);

  await runWithConcurrency(sources, concurrency, async (source, index) => {
    const label = sources.length > 1 ? `[${index + 1}/${sources.length}] ${basename(source)}` : basename(source);
    const kfxPath = outputPathFor(source, inputPath, inputInfo.isDirectory(), outputRoot, options.inPlace, ".kfx");
    const kpfPath = outputPathFor(source, inputPath, inputInfo.isDirectory(), outputRoot, options.inPlace, ".kpf");
    try {
      const conversionOptions = { direction: options.direction, wideRatio, mozjpeg: options.mozjpeg };
      const plan = options.dryRun ? await planCbz(source, conversionOptions) : await createKpfFromCbz(source, kpfPath, conversionOptions);
      printPlan(label, plan, options.dryRun);
      if (!options.dryRun) {
        await compileKfx(kpfPath, kfxPath, calibreDebug as string, plan.metadata);
        console.log(`  Saved ${kfxPath}`);
        if (!options.keepKpf) await rm(kpfPath, { force: true });
        else console.log(`  Saved ${kpfPath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${basename(source)}: ${message}`);
      console.error(`${label}: failed: ${message}`);
    }
  });

  if (failures.length > 0) throw new Error(`${failures.length} file${failures.length === 1 ? "" : "s"} failed:\n- ${failures.join("\n- ")}`);
}

async function findCbzFiles(inputPath: string, inputIsDirectory: boolean, recursive: boolean): Promise<string[]> {
  if (!inputIsDirectory) {
    if (extname(inputPath).toLowerCase() !== ".cbz") throw new Error("Input file must have a .cbz extension");
    return [inputPath];
  }

  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isFile() && extname(entry.name).toLowerCase() === ".cbz" && !entry.name.startsWith("._")) found.push(path);
      else if (recursive && entry.isDirectory()) await visit(path);
    }
  };
  await visit(inputPath);
  return found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

function outputPathFor(
  source: string,
  inputPath: string,
  inputIsDirectory: boolean,
  outputRoot: string,
  inPlace: boolean,
  extension: string,
): string {
  const base = inPlace
    ? join(dirname(source), basename(source, extname(source)))
    : inputIsDirectory
      ? join(outputRoot, relative(inputPath, dirname(source)), basename(source, extname(source)))
      : join(outputRoot, basename(source, extname(source)));
  return `${base}${extension}`;
}

function printPlan(label: string, plan: ConversionPlan, dryRun: boolean): void {
  const spreads = plan.sourcePages.filter((page) => page.doublePage).length;
  const singles = plan.sourcePages.length - spreads;
  console.log(`${label}: ${plan.direction.toUpperCase()}, ${singles} single page${singles === 1 ? "" : "s"}, ${spreads} double spread${spreads === 1 ? "" : "s"}, ${plan.outputPageCount} Kindle pages`);
  console.log(`  Target: ${plan.targetWidth}x${plan.targetHeight}; Virtual Panels exclude aspect-ratio margins`);
  console.log(`  ComicInfo.xml: ${plan.comicInfoFound ? "metadata imported" : "not found; filename metadata used"}`);
  if (dryRun) {
    for (const page of plan.sourcePages) {
      console.log(`  ${String(page.index).padStart(4, " ")}: ${page.width}x${page.height} (${page.ratio.toFixed(3)}) -> ${page.doublePage ? "double spread" : "single page"} [${page.sourceName}]`);
    }
  }
}

function positiveNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`);
  return parsed;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}
