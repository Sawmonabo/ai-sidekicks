// A Chromium trace of one window, recorded through the DevTools protocol and read back whole.
//
// The trace is the page target's own: the window's renderer and the GPU process, never the
// browser process. Every record a reading uses is read from it in its JSON form.

import type { CDPSession } from "playwright";

/** One trace record, with only the members the endurance readings use. */
export interface TraceEvent {
  readonly name: string;
  readonly ph: string;
  readonly pid: number;
  readonly tid?: number;
  readonly ts: number;
  /** A complete record's length, in microseconds. */
  readonly dur?: number;
  readonly id?: string;
  readonly id2?: { readonly local?: string };
  readonly args?: Record<string, unknown>;
}

/**
 * Members holding 64-bit trace ids, which lose their low digits as a JavaScript number; they are
 * read as their source text so two frames' ids never compare equal.
 */
const TRACE_ID_MEMBERS: ReadonlySet<string> = new Set(["display_trace_id", "result_id"]);

/** Starts recording the window's trace in `categories`, kept until it is ended. */
export async function startTraceRecording(
  cdpSession: CDPSession,
  categories: readonly string[],
): Promise<void> {
  await cdpSession.send("Tracing.start", {
    traceConfig: { recordMode: "recordAsMuchAsPossible", includedCategories: [...categories] },
    transferMode: "ReturnAsStream",
  });
}

/** Ends the recording and returns its records, every 64-bit id kept as its source text. */
export async function endTraceRecording(cdpSession: CDPSession): Promise<readonly TraceEvent[]> {
  const completed = new Promise<string | undefined>((resolve) => {
    cdpSession.once("Tracing.tracingComplete", (event) => {
      resolve(event.stream);
    });
  });
  await cdpSession.send("Tracing.end");
  const stream = await completed;
  if (stream === undefined) {
    throw new Error("the trace ended without a stream to read it from");
  }
  let text = "";
  for (;;) {
    const chunk = await cdpSession.send("IO.read", { handle: stream });
    text += chunk.data;
    if (chunk.eof) {
      break;
    }
  }
  await cdpSession.send("IO.close", { handle: stream });
  const trace = JSON.parse(text, (member: string, value: unknown, context?: { source?: string }) =>
    TRACE_ID_MEMBERS.has(member) ? context?.source : value,
  ) as { readonly traceEvents: readonly TraceEvent[] };
  return trace.traceEvents;
}
