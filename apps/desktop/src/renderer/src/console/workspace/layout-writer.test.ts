// The one claim this writer makes: a drag does not become a write per frame.
//
// The coalesce is the whole reason the class exists, so the first case counts
// writes rather than asserting the last one landed — and its negative control
// proves the counter can reach three, because a writer that performed exactly one
// write ever would pass a coalesce assertion for the wrong reason.

import { describe, expect, it } from "vitest";

import { CoalescingLayoutWriter } from "./layout-writer.js";
import type { DeckSnapshotRecord } from "./deck/deck-snapshot.js";

const SESSION_A = "session-a";
const SESSION_B = "session-b";

function snapshotAt(position: number): DeckSnapshotRecord {
  return { $deck: { version: 1, density: "standard" }, "pane-1": { position, kind: "timeline" } };
}

/** One write as the writer performed it: the partition it named, and what it held. */
interface PerformedWrite {
  readonly partition: string;
  readonly snapshot: DeckSnapshotRecord;
}

/** A write whose settlement the test decides. */
function heldWrite(): {
  readonly write: (partition: string, snapshot: DeckSnapshotRecord) => Promise<void>;
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
    const writer = new CoalescingLayoutWriter<DeckSnapshotRecord>({
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
    // The second write carries position 3 and never 2: an arrangement the person
    // has already moved past must not reach the disk and then be corrected.
    expect(held.seen[1]?.snapshot["pane-1"]?.["position"]).toBe(3);
  });

  it("negative control: three requests that each settle are three writes", async () => {
    // Without this, the case above would pass over a writer that performed one
    // write and then stopped forever.
    const seen: PerformedWrite[] = [];
    const writer = new CoalescingLayoutWriter<DeckSnapshotRecord>({
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
    const writer = new CoalescingLayoutWriter<DeckSnapshotRecord>({
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

  it("keeps writing after a failure, because the next arrangement is still worth saving", async () => {
    let attempt = 0;
    const writer = new CoalescingLayoutWriter<DeckSnapshotRecord>({
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
  it("writes a queued arrangement under the session that requested it, not the newest one", async () => {
    // The defect this binding exists for: the writer coalesces, so a request settles
    // later than the act that made it. A writer that read the caller's current session
    // at write time filed session A's arrangement under session B's partition the
    // moment a person navigated between two sessions the shell already had open.
    const held = heldWrite();
    const writer = new CoalescingLayoutWriter<DeckSnapshotRecord>({
      write: held.write,
      onFailed: () => {
        throw new Error("no write should have failed");
      },
    });

    writer.request(SESSION_A, snapshotAt(1));
    // Queued behind the in-flight write, exactly as a drag's later frames are.
    writer.request(SESSION_A, snapshotAt(2));
    held.settle();
    await settle();

    expect(held.seen.map((write) => write.partition)).toStrictEqual([SESSION_A, SESSION_A]);
  });

  it("negative control: a later request naming another session is written under that one", async () => {
    // Without this, the case above would pass over a writer that hard-coded the
    // first partition it ever saw, which files every later session under the first.
    const held = heldWrite();
    const writer = new CoalescingLayoutWriter<DeckSnapshotRecord>({
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

describe("CoalescingLayoutWriter — one writer, two records", () => {
  it("carries a record that is not the deck's, under its own key", async () => {
    // The generalisation this class was moved out of `deck/` for. Without it the
    // sidebar would need a second coalescing writer, which is the one thing this
    // module exists to be — and a second one is how two write paths start
    // disagreeing about what "the newest arrangement" means.
    const seen: { readonly partition: string; readonly snapshot: SidebarRecord }[] = [];
    const writer = new CoalescingLayoutWriter<SidebarRecord>({
      write: async (partition, snapshot) => {
        seen.push({ partition, snapshot });
      },
      onFailed: () => {
        throw new Error("no write should have failed");
      },
    });

    writer.request(SESSION_A, { $sidebar: { version: 1, widthPercent: 24, isCollapsed: false } });
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.snapshot["$sidebar"]?.["widthPercent"]).toBe(24);
  });

  it("negative control: two records in flight coalesce independently of each other", async () => {
    // Without this the case above would pass over a writer holding one static slot
    // for every caller — which would make a sidebar drag drop the deck's queued
    // arrangement, and the deck's drag drop the sidebar's.
    const deckWrites: DeckSnapshotRecord[] = [];
    const sidebarWrites: SidebarRecord[] = [];
    const deckWriter = new CoalescingLayoutWriter<DeckSnapshotRecord>({
      write: async (_partition, snapshot) => {
        deckWrites.push(snapshot);
      },
      onFailed: () => undefined,
    });
    const sidebarWriter = new CoalescingLayoutWriter<SidebarRecord>({
      write: async (_partition, snapshot) => {
        sidebarWrites.push(snapshot);
      },
      onFailed: () => undefined,
    });

    deckWriter.request(SESSION_A, snapshotAt(1));
    sidebarWriter.request(SESSION_A, { $sidebar: { version: 1, widthPercent: 30 } });
    await settle();

    expect(deckWrites).toHaveLength(1);
    expect(sidebarWrites).toHaveLength(1);
  });
});

/** The second record the writer now carries, in the shape the sidebar keeps it. */
type SidebarRecord = Record<string, Record<string, number | boolean | string>>;

describe("CoalescingLayoutWriter — the terminal a replaced store retires it through", () => {
  it("drains what was waiting rather than dropping it", async () => {
    // A retirement that cancelled would throw away the newest arrangement — the one
    // act the person performed last, and the one they expect to find on the way back.
    const held = heldWrite();
    const writer = new CoalescingLayoutWriter<DeckSnapshotRecord>({
      write: held.write,
      onFailed: () => {
        throw new Error("no write should have failed");
      },
    });

    writer.request(SESSION_A, snapshotAt(1));
    // In the writer's pending slot, behind the write held open above.
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
    const writer = new CoalescingLayoutWriter<DeckSnapshotRecord>({
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

  it("negative control: the same request before retirement is written", async () => {
    // Without this, the case above would pass over a writer that never wrote at all,
    // and "retired" would be indistinguishable from "broken".
    const held = heldWrite();
    const writer = new CoalescingLayoutWriter<DeckSnapshotRecord>({
      write: held.write,
      onFailed: () => {
        throw new Error("no write should have failed");
      },
    });

    writer.request(SESSION_A, snapshotAt(1));
    await settle();

    expect(writer.writeCount).toBe(1);
  });
});
