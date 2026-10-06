// The one claim this writer makes: a drag does not become a write per frame. The first case
// counts writes rather than asserting the last landed, and its negative control proves the
// counter can reach three.

import { describe, expect, it } from "vitest";

import { CoalescingLayoutWriter } from "./coalescing-writer.js";
import type { PaneLayoutSnapshotRecord } from "./snapshot.js";

const SESSION_A = "session-a";
const SESSION_B = "session-b";

function snapshotAt(position: number): PaneLayoutSnapshotRecord {
  return {
    $paneLayout: { version: 1, density: "standard" },
    "pane-1": { position, kind: "transcript" },
  };
}

/** One write as the writer performed it: the partition it named, and what it held. */
interface PerformedWrite {
  readonly partition: string;
  readonly snapshot: PaneLayoutSnapshotRecord;
}

/** A write whose settlement the test decides. */
function heldWrite(): {
  readonly write: (partition: string, snapshot: PaneLayoutSnapshotRecord) => Promise<void>;
  readonly seen: PerformedWrite[];
  settle: () => void;
} {
  const seen: PerformedWrite[] = [];
  let release: (() => void) | undefined;
  return {
    seen,
    write: (partition, snapshot) => {
      seen.push({ partition, snapshot });
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    settle: () => {
      release?.();
      release = undefined;
    },
  };
}

describe("CoalescingLayoutWriter — coalescing", () => {
  it("holds one write in flight and sends only the NEWEST of what arrived meanwhile", async () => {
    const held = heldWrite();
    const writer = new CoalescingLayoutWriter<PaneLayoutSnapshotRecord>({
      write: held.write,
      onFailed: () => {
        throw new Error("no write should have failed");
      },
    });

    writer.request(SESSION_A, snapshotAt(1));
    writer.request(SESSION_A, snapshotAt(2));
    writer.request(SESSION_A, snapshotAt(3));
    expect(writer.writeCount).toBe(1);

    held.settle();
    await Promise.resolve();
    await Promise.resolve();

    expect(writer.writeCount).toBe(2);
    // Position 3 and never 2: a superseded arrangement must not reach the disk.
    expect(held.seen[1]?.snapshot["pane-1"]?.["position"]).toBe(3);
  });

  it("negative control: three requests that each settle are three writes", async () => {
    // Without this, the case above would pass over a writer that stopped after one write.
    const seen: PerformedWrite[] = [];
    const writer = new CoalescingLayoutWriter<PaneLayoutSnapshotRecord>({
      write: async (partition, snapshot) => {
        seen.push({ partition, snapshot });
      },
      onFailed: () => {
        throw new Error("no write should have failed");
      },
    });

    for (const position of [1, 2, 3]) {
      writer.request(SESSION_A, snapshotAt(position));
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(writer.writeCount).toBe(3);
    expect(seen.map((write) => write.snapshot["pane-1"]?.["position"])).toStrictEqual([1, 2, 3]);
  });

  it("reports a rejected write rather than letting it reject unhandled", async () => {
    const failures: unknown[] = [];
    const writer = new CoalescingLayoutWriter<PaneLayoutSnapshotRecord>({
      write: async () => {
        throw new Error("the database is gone");
      },
      onFailed: (error) => {
        failures.push(error);
      },
    });

    writer.request(SESSION_A, snapshotAt(1));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(failures).toHaveLength(1);
  });

  it("keeps writing after a failure, as the next arrangement is still worth saving", async () => {
    let attempt = 0;
    const writer = new CoalescingLayoutWriter<PaneLayoutSnapshotRecord>({
      write: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("the database is gone");
        }
      },
      onFailed: () => undefined,
    });

    writer.request(SESSION_A, snapshotAt(1));
    await settle();
    writer.request(SESSION_A, snapshotAt(2));
    await settle();

    expect(writer.writeCount).toBe(2);
    expect(writer.isIdle).toBe(true);
  });
});

describe("CoalescingLayoutWriter — which session an arrangement is filed under", () => {
  it("writes a later request naming another session under that one", async () => {
    // A writer that hard-coded the first partition it saw would file both under it.
    const held = heldWrite();
    const writer = new CoalescingLayoutWriter<PaneLayoutSnapshotRecord>({
      write: held.write,
      onFailed: () => {
        throw new Error("no write should have failed");
      },
    });

    writer.request(SESSION_A, snapshotAt(1));
    held.settle();
    await settle();
    writer.request(SESSION_B, snapshotAt(2));
    held.settle();
    await settle();

    expect(held.seen.map((write) => write.partition)).toStrictEqual([SESSION_A, SESSION_B]);
  });
});

/** Let the microtask queue drain the pump's `catch`/`finally` chain. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await Promise.resolve();
  }
}

describe("CoalescingLayoutWriter — the terminal a replaced store retires it through", () => {
  it("flushes what was waiting rather than dropping it", async () => {
    // A retirement that canceled would throw away the arrangement the person made last.
    const held = heldWrite();
    const writer = new CoalescingLayoutWriter<PaneLayoutSnapshotRecord>({
      write: held.write,
      onFailed: () => {
        throw new Error("no write should have failed");
      },
    });

    writer.request(SESSION_A, snapshotAt(1));
    // In the writer's pending request, behind the write held open above.
    writer.request(SESSION_A, snapshotAt(2));
    writer.flushAndClose();
    held.settle();
    await settle();
    held.settle();
    await settle();

    expect(held.seen.map((write) => write.snapshot["pane-1"]?.["position"])).toStrictEqual([1, 2]);
  });

  it("takes no request once it has been retired", async () => {
    const held = heldWrite();
    const writer = new CoalescingLayoutWriter<PaneLayoutSnapshotRecord>({
      write: held.write,
      onFailed: () => {
        throw new Error("no write should have failed");
      },
    });

    writer.flushAndClose();
    writer.request(SESSION_A, snapshotAt(1));
    await settle();

    expect(writer.writeCount).toBe(0);
  });
});
