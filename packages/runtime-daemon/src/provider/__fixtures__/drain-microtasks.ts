// Settling every queued continuation before a test asserts.

/**
 * Drains the microtask queue by yielding to the macrotask queue once. Counting
 * `await Promise.resolve()` hops instead would pin a test to the exact continuation sequencing
 * under test and turn a real assertion into a hang when that changes.
 */
export async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
