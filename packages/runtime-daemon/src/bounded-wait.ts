// Waiting on work for a bounded time, so a stop never hangs on work that does not end.

/**
 * Resolves `true` once `work` has settled, fulfilled or rejected, or `false` when `boundMs` passes
 * or `signal` aborts first. Never rejects; the work itself is never canceled, and the timer is
 * cleared either way. A caller that wants the work's value awaits `work` after a `true`.
 */
export async function waitWithin(
  work: Promise<unknown>,
  boundMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const settled = work.then(
    () => true,
    () => true,
  );
  if (signal?.aborted === true) {
    return false;
  }
  let boundTimer: ReturnType<typeof setTimeout> | undefined;
  let endEarly: (() => void) | undefined;
  const waitEnded = new Promise<false>((resolve) => {
    endEarly = () => {
      resolve(false);
    };
    boundTimer = setTimeout(endEarly, boundMs);
    // The bound alone never keeps the process running.
    boundTimer.unref();
    signal?.addEventListener("abort", endEarly, { once: true });
  });
  try {
    return await Promise.race([settled, waitEnded]);
  } finally {
    clearTimeout(boundTimer);
    if (endEarly !== undefined) {
      signal?.removeEventListener("abort", endEarly);
    }
  }
}
