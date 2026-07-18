import { convertCbzBundleToKfx, type ConvertBundleOptions } from "./index.js";

interface Payload {
  inputPaths: string[];
  outputPath: string;
  title: string;
  options: ConvertBundleOptions;
}

try {
  const payload = JSON.parse(process.argv[2] ?? "") as Payload;
  const result = await convertCbzBundleToKfx(
    payload.inputPaths,
    payload.outputPath,
    payload.title,
    payload.options,
  );
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
