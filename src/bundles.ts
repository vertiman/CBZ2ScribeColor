export interface SourceBundle {
  index: number;
  title: string;
  sources: string[];
}

export function groupIntoBundles(sources: string[], size: number, name: string): SourceBundle[] {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("bundle-size must be a positive integer");
  const bundleName = name.trim();
  if (!bundleName) throw new Error("bundle-naming must not be empty");
  const bundles: SourceBundle[] = [];
  for (let offset = 0; offset < sources.length; offset += size) {
    const index = bundles.length + 1;
    bundles.push({
      index,
      title: `${bundleName} - ${String(index).padStart(3, "0")}`,
      sources: sources.slice(offset, offset + size),
    });
  }
  return bundles;
}
