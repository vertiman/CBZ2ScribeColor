import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { access, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BookMetadata } from "./cbz.js";

export async function findKfxOutput(explicitPath?: string): Promise<string | undefined> {
  const candidates = [
    explicitPath,
    process.env.CALIBRE_DEBUG_PATH,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Calibre2", "calibre-debug.exe") : undefined,
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "Calibre2", "calibre-debug.exe") : undefined,
    "/Applications/calibre.app/Contents/MacOS/calibre-debug",
  ].filter((value): value is string => Boolean(value));

  let calibreDebug: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(resolve(candidate), constants.X_OK);
      calibreDebug = resolve(candidate);
      break;
    } catch {
      // Try the next known installation path.
    }
  }
  if (!calibreDebug && commandExists("calibre-debug")) calibreDebug = "calibre-debug";
  if (!calibreDebug) return undefined;

  const result = await run(calibreDebug, ["-r", "KFX Output", "--", "--help"]);
  return result.code === 0 && /Convert e-book to KFX format/iu.test(result.output) ? calibreDebug : undefined;
}

export async function compileKfx(
  kpfPath: string,
  outputPath: string,
  calibreDebugPath: string,
  metadata: BookMetadata,
): Promise<void> {
  await rm(outputPath, { force: true });
  const result = await run(calibreDebugPath, ["-r", "KFX Output", "--", kpfPath, outputPath]);
  if (!await exists(outputPath)) {
    throw new Error(`KFX Output did not create a KFX file (exit ${result.code}).\n${result.output.slice(-4000)}`);
  }
  if (result.code !== 0) throw new Error(`KFX Output exited with ${result.code}.\n${result.output.slice(-4000)}`);
  await writeKfxMetadata(outputPath, calibreDebugPath, metadata);
}

async function writeKfxMetadata(outputPath: string, calibreDebugPath: string, metadata: BookMetadata): Promise<void> {
  const localExecutable = join(dirname(calibreDebugPath), process.platform === "win32" ? "ebook-meta.exe" : "ebook-meta");
  const executable = await exists(localExecutable) ? localExecutable : commandExists("ebook-meta") ? "ebook-meta" : undefined;
  if (!executable) throw new Error(`ebook-meta was not found beside ${calibreDebugPath} or on PATH`);
  const args = [outputPath, "--title", metadata.title, "--title-sort", metadata.title];
  if (metadata.creators.length > 0) args.push("--authors", metadata.creators.join(" & "));
  if (metadata.publisher) args.push("--publisher", metadata.publisher);
  if (metadata.description) args.push("--comments", metadata.description);
  if (metadata.language) args.push("--language", metadata.language);
  if (metadata.date) args.push("--date", metadata.date);
  if (metadata.subjects.length > 0) args.push("--tags", metadata.subjects.join(", "));
  if (metadata.series) args.push("--series", metadata.series);
  if (metadata.number) args.push("--index", metadata.number);
  const result = await run(executable, args);
  if (result.code !== 0) throw new Error(`ebook-meta exited with ${result.code}.\n${result.output.slice(-4000)}`);
}

async function run(command: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, output }));
  });
}

function commandExists(command: string): boolean {
  const directories = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const names = process.platform === "win32" ? [`${command}.exe`, command] : [command];
  return directories.some((directory) => names.some((name) => {
    try {
      accessSync(join(directory, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
