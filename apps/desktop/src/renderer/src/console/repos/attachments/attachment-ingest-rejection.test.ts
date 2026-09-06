// A leg that REJECTS rather than answering, at every place one can.
//
// The sibling files drive refusals — answers whose status says the daemon declined.
// This one drives the other failure: a call that never produced an answer at all,
// which is what an IPC disconnect looks like from inside the ingest client and what a
// vanished file looks like to the payload read. The two arrive through different doors
// and used to end in different places: a refusal reached the ledger, and a rejection
// reached nobody — the page reported an unhandled rejection and the entry sat at
// `declared` or `ingesting` with no refusal to read and no retry to press.
//
// The client is driven directly against the scripted growth port beside it, which can
// now be told to REJECT a leg as well as to refuse one.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { drainMicrotasks } from "../../core/microtask-drain.test-support.js";
import { ATTACHMENT_CHUNK_BYTE_CAP } from "../../core/index.js";
import { consoleTripwires } from "../../core/tripwires.js";
import {
  SMALL_SOURCE,
  ScriptedGrowthPort,
  clientOver,
  sourceOver,
  unreadableSourceOver,
} from "./attachment-ingest-scripted-port.test-support.js";
import { INGEST_STREAM_SITE } from "./attachment-ingest-stream.js";
import { INGEST_CAPACITY_EXHAUSTED_CODE } from "./attachment-policy.js";

/** The console-side code a rejection carrying nothing machine-readable becomes. */
const CALL_REJECTED_CODE = "call-rejected";

beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

afterEach(() => {
  consoleTripwires.reset();
  consoleTripwires.setThrowOnReport(import.meta.env.DEV);
});

describe("ingest client — a rejected leg is a refusal on the entry", () => {
  it("refuses the entry when the open rejects, and offers the retry", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.rejectBeginWith(new Error("the bridge namespace is gone"));
    client.attach(SMALL_SOURCE);
    await drainMicrotasks();

    // `declared` was the old resting state: the rejection escaped, so nothing was ever
    // written back and the card charted zero bytes of a stream nobody was sending.
    const [entry] = client.snapshot;
    expect(entry?.state).toBe("refused");
    expect(entry?.refusal?.code).toBe(CALL_REJECTED_CODE);
    expect(entry?.refusal?.detail).toContain("The ingest open was rejected");
    // The contract's own default for a code the console does not recognise, which is
    // what makes the retry a replay rather than a re-upload.
    expect(entry?.disposition).toBe("retry-in-place");
  });

  it("keeps the daemon's own code where the rejection carried one", async () => {
    // An SDK-style rejection carries `code` and `message`, and the console may not
    // paraphrase either. Relabelling this as the console's own `call-rejected` would
    // also lose the disposition — a capacity refusal means wait, not send again now.
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.rejectBeginWith({
      code: INGEST_CAPACITY_EXHAUSTED_CODE,
      message: "no spool capacity is available",
    });
    client.attach(SMALL_SOURCE);
    await drainMicrotasks();

    const [entry] = client.snapshot;
    expect(entry?.refusal?.code).toBe(INGEST_CAPACITY_EXHAUSTED_CODE);
    expect(entry?.refusal?.detail).toBe("no spool capacity is available");
    expect(entry?.disposition).toBe("wait-and-retry");
  });

  it("refuses rather than leaving the entry ingesting when a chunk rejects", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.rejectChunksWith(new Error("the chunk never reached a daemon"));
    client.attach(SMALL_SOURCE);
    await drainMicrotasks();

    // The stream opened, so the old failure left this one at `ingesting` forever: a
    // progress bar that could not move and a stop control beside no explanation.
    const [entry] = client.snapshot;
    expect(entry?.state).toBe("refused");
    expect(entry?.refusal?.detail).toContain("The chunk send was rejected");
    expect(entry?.ingestId).toBe("ingest-1");
  });

  it("refuses when the completion rejects, with the whole payload already sent", async () => {
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    port.rejectCompletionWith(new Error("the completion never reached a daemon"));
    client.attach(SMALL_SOURCE);
    await drainMicrotasks();

    const [entry] = client.snapshot;
    expect(entry?.state).toBe("refused");
    expect(entry?.refusal?.detail).toContain("The ingest completion was rejected");
    expect(entry?.derived).toBeUndefined();
    expect(port.chunkCalls).toHaveLength(1);
  });

  it("refuses when the participant's own file stops being readable", async () => {
    // Not a wire failure at all: the `Blob` is a handle on a file the host owns, and a
    // participant who moved it mid-upload gets a rejecting read. It reaches the entry
    // through the same door, because it means the same thing — this leg did not happen.
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.attach(
      unreadableSourceOver(
        "attachment-moved",
        "capture.bin",
        ATTACHMENT_CHUNK_BYTE_CAP * 2,
        new Error("the file behind this blob is gone"),
      ),
    );
    await drainMicrotasks();

    const [entry] = client.snapshot;
    expect(entry?.state).toBe("refused");
    expect(entry?.refusal?.detail).toContain("The payload read was rejected");
    // The read failed before the request was composed, so nothing was sent describing
    // bytes this client could not produce.
    expect(port.chunkCalls).toStrictEqual([]);
  });

  it("negative control: a port that answers every leg completes and refuses nothing", async () => {
    // Without this, every case above would pass over a client that refused whatever
    // happened — which would report a healthy upload as a failure.
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.attach(sourceOver("attachment-two", "capture.bin", ATTACHMENT_CHUNK_BYTE_CAP * 2));
    await drainMicrotasks();

    const [entry] = client.snapshot;
    expect(entry?.state).toBe("complete");
    expect(entry?.refusal).toBeUndefined();
  });
});

describe("ingest client — the drive promise settles rather than escaping", () => {
  /**
   * The two host methods that report a rejection nothing handled.
   *
   * Read off the runner rather than by pulling `@types/node` into the renderer
   * program, which deliberately excludes it. `store/hooks.caller-membership-role.test.tsx`
   * makes the same witness for the same reason, and the two cannot become one module:
   * the renderer program's `rootDir` is `apps/desktop/src`, so a co-located console test
   * importing a helper from `test/console/` is TS6059 — the shared home
   * `apps/desktop/AGENTS.md` names for a cross-test role is unreachable from here.
   */
  const runnerHost = globalThis as unknown as {
    readonly process: {
      on: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
      off: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
    };
  };

  it("leaves no unhandled rejection behind when every leg rejects at once", async () => {
    // `attach` discards this promise, so a rejection that reached it reached the page.
    // The listener is added and removed around the body rather than for the file, so a
    // rejection another case raised cannot be counted here.
    const escaped: string[] = [];
    const record = (reason: unknown): void => {
      escaped.push(String(reason));
    };
    runnerHost.process.on("unhandledRejection", record);
    try {
      const port = new ScriptedGrowthPort();
      const client = clientOver(port);
      port.rejectBeginWith(new Error("the bridge namespace is gone"));
      client.attach(SMALL_SOURCE);
      await drainMicrotasks();
      // Reported a macrotask after the microtask queue drains, so a body that awaited
      // only microtasks would report clean whether or not one escaped.
      await drainMicrotasks();
    } finally {
      runnerHost.process.off("unhandledRejection", record);
    }

    expect(escaped).toStrictEqual([]);
  });

  it("leaves none behind when the spool reclaim rejects either", async () => {
    // The fifth call, and the only one whose answer no entry is left to render: the
    // reclaim is fired and not awaited by a caller that is terminal for its entry, so
    // a rejection here had no `catch` anywhere above it. What it recorded instead is
    // `attachment-ingest-abandon.test.ts`'s claim; this is the promise's half.
    const escaped: string[] = [];
    const record = (reason: unknown): void => {
      escaped.push(String(reason));
    };
    runnerHost.process.on("unhandledRejection", record);
    try {
      const port = new ScriptedGrowthPort();
      const client = clientOver(port);
      port.refuseChunksWith("wire-unregistered");
      port.rejectAbortsWith(new Error("the bridge namespace is gone"));
      client.attach(SMALL_SOURCE);
      await drainMicrotasks();
      client.abandon("attachment-1");
      await drainMicrotasks();
      await drainMicrotasks();
    } finally {
      runnerHost.process.off("unhandledRejection", record);
    }

    expect(escaped).toStrictEqual([]);
  });

  it("reports a publication that threw on the diagnostic band, not on the promise", async () => {
    // The one failure left after the four legs are normalized: `Emitter` re-raises a
    // sink that threw, and by then the ledger's write has landed. So the record is
    // ahead of every surface reading it — which is a defect in this console rather
    // than an answer from anywhere, and it goes where defects go.
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    let publishCount = 0;
    client.subscribe(() => {
      publishCount += 1;
      if (publishCount > 1) {
        throw new Error("a subscriber failed while receiving the carrier");
      }
    });
    client.attach(SMALL_SOURCE);
    await drainMicrotasks();

    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
    const [report] = consoleTripwires.reports();
    expect(report?.site).toBe(INGEST_STREAM_SITE);
    expect(report?.detail).toContain("attachment-1");
    // The write landed before the fan-out failed, which is why this reports rather
    // than writing again: the entry moved and the subscriber did not hear it.
    expect(client.snapshot[0]?.state).toBe("ingesting");
  });

  it("negative control: a subscriber that does not throw records nothing", async () => {
    // Without this the case above would pass over a client that fired on every drive,
    // which would put a defect on the diagnostic band for every healthy upload.
    const port = new ScriptedGrowthPort();
    const client = clientOver(port);
    client.subscribe(() => undefined);
    client.attach(SMALL_SOURCE);
    await drainMicrotasks();

    expect(consoleTripwires.totalFiringCount).toBe(0);
    expect(client.snapshot[0]?.state).toBe("complete");
  });
});
