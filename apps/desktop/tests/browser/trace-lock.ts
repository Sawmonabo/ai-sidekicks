// A trace of the test browser taken one page at a time. Tracing is the browser's own, so a second
// page starting a trace while one runs is refused, and the runner runs test files in pages of their
// own at once. The pages share an origin, so a Web Lock held across the trace orders them.

/** Runs `trace` while no other page of the test browser holds a trace, and answers what it did. */
export async function traceAlone<Result>(trace: () => Promise<Result>): Promise<Result> {
  return navigator.locks.request("browser-trace", trace);
}
