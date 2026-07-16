export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Concurrency limit must be a positive integer");
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
}

export type TaskRunner = <T>(task: () => Promise<T>) => Promise<T>;

export function createTaskRunner(limit: number): TaskRunner {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Concurrency limit must be a positive integer");
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = (): Promise<void> => new Promise((resolve) => {
    if (active < limit) {
      active += 1;
      resolve();
    } else {
      waiting.push(resolve);
    }
  });

  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}
