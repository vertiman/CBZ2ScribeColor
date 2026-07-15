import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

const JPEGLI_ARGUMENTS = [
  "-",
  "-",
  "--distance=0.8",
  "--chroma_subsampling=444",
  "--progressive_level=2",
  "--quiet",
] as const;

export async function findCjpegli(explicitPath?: string): Promise<string | undefined> {
  const configured = [explicitPath, process.env.CJPEGLI_PATH]
    .filter((value): value is string => Boolean(value));
  for (const candidate of configured) {
    const absolute = resolve(candidate);
    try {
      await access(absolute, constants.X_OK);
      if (await isCjpegli(absolute)) return absolute;
    } catch {
      // Try the next configured path.
    }
  }

  return commandExists("cjpegli") && await isCjpegli("cjpegli") ? "cjpegli" : undefined;
}

export async function encodeJpegli(
  pixels: Buffer,
  width: number,
  height: number,
  executable: string,
): Promise<Buffer> {
  if (pixels.length !== width * height * 3) {
    throw new Error(`JPEGli expected ${width}x${height} RGB pixels, received ${pixels.length} bytes`);
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...JPEGLI_ARGUMENTS], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const output: Buffer[] = [];
    let errors = "";
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    child.stdin.on("error", () => {
      // A failed process can close stdin before Node finishes writing the page.
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Could not start cjpegli at ${executable}: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      const jpeg = Buffer.concat(output);
      if (code !== 0) {
        reject(new Error(`cjpegli exited with ${code ?? -1}.\n${errors.slice(-4000)}`));
      } else if (jpeg.length === 0) {
        reject(new Error("cjpegli produced no JPEG data"));
      } else {
        resolvePromise(jpeg);
      }
    });
    child.stdin.write(`P6\n${width} ${height}\n255\n`);
    child.stdin.end(pixels);
  });
}

async function isCjpegli(executable: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn(executable, ["--help"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let settled = false;
    const finish = (found: boolean): void => {
      if (settled) return;
      settled = true;
      resolvePromise(found);
    };
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0 && /cjpegli|compressed JPEG/iu.test(output)));
  });
}

function commandExists(command: string): boolean {
  const names = process.platform === "win32" ? [`${command}.exe`, command] : [command];
  return (process.env.PATH ?? "").split(delimiter).some((directory) => names.some((name) => {
    try {
      accessSync(join(directory, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}
