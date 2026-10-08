// Waiting on work for a bounded time, so a stop never hangs on work that does not end.

/**
 * Resolves `true` once `work` has settled, fulfilled or rejected, or `false` when `boundMs` passes
 * first. Never rejects; the timer is cleared either way.
 */
export async function waitWithin(work: Promise<unknown>, boundMs: number): Promise<boolean> {
  let boundTimer: ReturnType<typeof setTimeout> | undefined;
  const boundReached = new Promise<false>((resolve) => {
    boundTimer = setTimeout(() => {
      resolve(false);
    }, boundMs);
  });
  const settled = work.then(
    () => true,
    () => true,
  );
  try {
    return await Promise.race([settled, boundReached]);
  } finally {
    clearTimeout(boundTimer);
  }
}
