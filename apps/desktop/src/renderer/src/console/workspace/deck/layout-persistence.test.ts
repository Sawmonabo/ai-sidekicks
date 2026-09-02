// The one claim this writer makes: a drag does not become a write per frame.
//
// The coalesce is the whole reason the class exists, so the first case counts
// writes rather than asserting the last one landed — and its negative control
// proves the counter can reach three, because a writer that performed exactly one
// write ever would pass a coalesce assertion for the wrong reason.

import { describe, expect, it } from "vitest";

import { DeckLayoutWriter } from "./layout-persistence.js";
import type { DeckSnapshotRecord } from "./deck-snapshot.js";

function snapshotAt(position: number): DeckSnapshotRecord {
  return { $deck: { version: 1, density: "standard" }, "pane-1": { position, kind: "timeline" } };
}

/** A write whose settlement the test decides. */
function heldWrite(): {
  readonly write: (snapshot: DeckSnapshotRecord) => Promise<void>;
  readonly seen: DeckSnapshotRecord[];
  settle: () => void;
} {
  const seen: DeckSnapshotRecord[] = [];
  let release: (() => void) | undefined;
  return {
    seen,
    write: (snapshot) => {
      seen.push(snapshot);
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

describe("DeckLayoutWriter — coalescing", () => {
  it("holds one write in flight and sends only the NEWEST of what arrived meanwhile", async () => {
    const held = heldWrite();
    const writer = new DeckLayoutWriter({
      write: held.write,
      onFailed: () => {
        throw new Error("no write should have failed");
      },
    });

    writer.request(snapshotAt(1));
    writer.request(snapshotAt(2));
    writer.request(snapshotAt(3));
    expect(writer.writeCount).toBe(1);

    held.settle();
    await Promise.resolve();
    await Promise.resolve();

    expect(writer.writeCount).toBe(2);
    // The second write carries position 3 and never 2: an arrangement the person
    // has already moved past must not reach the disk and then be corrected.
    expect(held.seen[1]?.["pane-1"]?.["position"]).toBe(3);
  });

  it("negative control: three requests that each settle are three writes", async () => {
    // Without this, the case above would pass over a writer that performed one
    // write and then stopped forever.
    const seen: DeckSnapshotRecord[] = [];
    const writer = new DeckLayoutWriter({
      write: async (snapshot) => {
        seen.push(snapshot);
      },
      onFailed: () => {
        throw new Error("no write should have failed");
      },
    });

    for (const position of [1, 2, 3]) {
      writer.request(snapshotAt(position));
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(writer.writeCount).toBe(3);
    expect(seen.map((snapshot) => snapshot["pane-1"]?.["position"])).toStrictEqual([1, 2, 3]);
  });

  it("reports a rejected write rather than letting it reject unhandled", async () => {
    const failures: unknown[] = [];
    const writer = new DeckLayoutWriter({
      write: async () => {
        throw new Error("the database is gone");
      },
      onFailed: (error) => {
        failures.push(error);
      },
    });

    writer.request(snapshotAt(1));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(failures).toHaveLength(1);
  });

  it("keeps writing after a failure, because the next arrangement is still worth saving", async () => {
    let attempt = 0;
    const writer = new DeckLayoutWriter({
      write: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("the database is gone");
        }
      },
      onFailed: () => undefined,
    });

    writer.request(snapshotAt(1));
    await settle();
    writer.request(snapshotAt(2));
    await settle();

    expect(writer.writeCount).toBe(2);
    expect(writer.isIdle).toBe(true);
  });
});

/** Let the microtask queue drain the pump's `catch`/`finally` chain. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await Promise.resolve();
  }
}
