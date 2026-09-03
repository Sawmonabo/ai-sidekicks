// The store: an override wins over the shipped chord, a conflict is refused, a reset
// restores, and what one window wrote another window reads back.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../core/index.js";
import { CommandRegistry, KeyBindingTable, type KeyBinding } from "../palette/index.js";
import { MemoryPersistenceAdapter, UiStateStore } from "../persistence/index.js";
import { KEYBINDING_OVERRIDES_KEY, KeybindingOverrideStore } from "./keybinding-override-store.js";

/**
 * This file's shipped table, authored on `Alt` rather than on `$mod`.
 *
 * `$mod` is resolved by tinykeys against the HOST at import time, and a press this
 * file synthesises has to name the modifier that resolution picked. Rather than
 * re-deriving that rule here — a second platform reading, which is exactly what the
 * console keeps to one place — the dispatch cases use a modifier that means the same
 * thing everywhere. What is under test is which command a chord runs, not which key
 * `$mod` is.
 */
const DEFAULTS: readonly KeyBinding[] = [
  { chord: "Alt+Digit1", commandId: "frame.goToSessions" },
  { chord: "Alt+Digit2", commandId: "frame.goToWorkflows" },
];

function overrideStore(): KeybindingOverrideStore {
  return new KeybindingOverrideStore({ defaults: DEFAULTS, platform: "darwin" });
}

/** A store over its own memory adapter, on a frozen clock like every other one. */
function uiStateStore(adapter = new MemoryPersistenceAdapter()): UiStateStore {
  return new UiStateStore({ adapter, clock: new ManualClock(1_000) });
}

/** What one durable read answers, taken from the adapter rather than restated. */
type StoredRecordOrAbsent = Awaited<ReturnType<MemoryPersistenceAdapter["read"]>>;

/**
 * A memory adapter whose reads are held open until the case lets them answer.
 *
 * Two hydrations can only be in flight at once if the first read has not settled,
 * and nothing behind the real chokepoint is slow on purpose. Held from the moment
 * {@link holdReads} is called rather than from construction, so a case can seed the
 * record it wants read back through the ordinary write path first.
 */
class HeldReadAdapter extends MemoryPersistenceAdapter {
  #letReadAnswer: (() => void) | undefined;
  #holdsReads = false;

  public holdReads(): void {
    this.#holdsReads = true;
  }

  public override async read(partition: string, key: string): Promise<StoredRecordOrAbsent> {
    if (this.#holdsReads) {
      await new Promise<void>((resolve) => {
        this.#letReadAnswer = resolve;
      });
    }
    return await super.read(partition, key);
  }

  /**
   * Let the held read answer, and let the hydration it belongs to run to its end.
   *
   * The read is reached through the chokepoint's own adapter-ready await, so it is
   * not pending in the turn the caller started it in; this waits for it rather than
   * assuming it, and RAISES rather than returning quietly when none arrives — a
   * release that resolved nothing would leave every assertion after it reading the
   * state from before the read, which is the one thing these cases are about.
   */
  public async answer(): Promise<void> {
    for (let pass = 0; pass < 20 && this.#letReadAnswer === undefined; pass += 1) {
      await Promise.resolve();
    }
    if (this.#letReadAnswer === undefined) {
      throw new Error("no read was held open to answer");
    }
    this.#letReadAnswer();
    this.#letReadAnswer = undefined;
    for (let pass = 0; pass < 4; pass += 1) {
      await Promise.resolve();
    }
  }
}

/** One durable store holding one override, with the handle that lets its read answer. */
interface HeldStore {
  readonly store: UiStateStore;
  readonly adapter: HeldReadAdapter;
}

async function heldStoreHolding(commandId: string, chord: string): Promise<HeldStore> {
  const adapter = new HeldReadAdapter();
  const store = uiStateStore(adapter);
  await store.writeGlobal(KEYBINDING_OVERRIDES_KEY, "keybinding", { [commandId]: chord });
  adapter.holdReads();
  return { store, adapter };
}

/** A press of `Alt+1`, as the dispatch path receives it. */
function altOnePress(): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "1", code: "Digit1", altKey: true });
}

/** The two navigation commands, and a record of which one a press ran. */
function navigationRegistry(ran: string[]): CommandRegistry {
  const registry = new CommandRegistry();
  registry.registerAll([
    {
      id: "frame.goToSessions",
      title: "Sessions",
      group: "Navigate",
      run: () => {
        ran.push("sessions");
      },
    },
    {
      id: "frame.goToWorkflows",
      title: "Flows",
      group: "Navigate",
      run: () => {
        ran.push("workflows");
      },
    },
  ]);
  return registry;
}

describe("an override reaches the keyboard, not just the page", () => {
  it("dispatches the override's chord and not the shipped one", async () => {
    const overrides = overrideStore();
    // The shipped `Alt+1` runs Sessions. Moved onto Workflows — after Sessions has
    // let go of it — the SAME press has to reach the other command.
    await overrides.unbind("frame.goToSessions");
    await overrides.bind("frame.goToWorkflows", "Alt+Digit1");

    const ran: string[] = [];
    const table = new KeyBindingTable({
      registry: navigationRegistry(ran),
      readContext: () => ({}),
    });
    table.setBindings(overrides.surface.bindings);

    expect(table.handleKeyDown(altOnePress())).toBe(true);
    expect(ran).toStrictEqual(["workflows"]);
  });

  it("negative control: the shipped table runs the other command on the same press", () => {
    // Without this the case above would pass against a table that had always run the
    // workflows command on this press, and would prove nothing about the override.
    const ran: string[] = [];
    const table = new KeyBindingTable({
      registry: navigationRegistry(ran),
      readContext: () => ({}),
    });
    table.setBindings(DEFAULTS);

    expect(table.handleKeyDown(altOnePress())).toBe(true);
    expect(ran).toStrictEqual(["sessions"]);
  });
});

describe("what the store refuses and what it restores", () => {
  it("refuses a chord another command answers to, naming that command", async () => {
    const overrides = overrideStore();
    const result = await overrides.bind("frame.goToSessions", "Alt+Digit2");
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("chord-taken");
      expect(result.refusal.detail).toContain("frame.goToWorkflows");
    }
    // Refused before anything moved: the shipped chord is untouched.
    expect(overrides.surface.bindings).toStrictEqual(DEFAULTS);
  });

  it("restores the shipped chord on a reset, and forgets the override", async () => {
    const overrides = overrideStore();
    await overrides.bind("frame.goToSessions", "$mod+9");
    expect(overrides.surface.bindings[0]?.chord).toBe("$mod+9");

    await overrides.reset("frame.goToSessions");
    expect(overrides.surface.bindings).toStrictEqual(DEFAULTS);
    expect(overrides.overrides).toStrictEqual({});
  });

  it("drops every override at once, and keeps an explicit unbinding until it does", async () => {
    const overrides = overrideStore();
    await overrides.unbind("frame.goToSessions");
    expect(overrides.surface.bindings.map((binding) => binding.commandId)).toStrictEqual([
      "frame.goToWorkflows",
    ]);

    await overrides.resetAll();
    expect(overrides.surface.bindings).toStrictEqual(DEFAULTS);
  });

  it("publishes a fresh snapshot on every act and holds one identity between them", () => {
    const overrides = overrideStore();
    const first = overrides.surface;
    expect(overrides.surface).toBe(first);
    overrides.beginRecording();
    expect(overrides.surface).not.toBe(first);
    expect(overrides.surface.recording).toBe(true);
    overrides.endRecording();
    expect(overrides.surface.recording).toBe(false);
  });

  it("tells its subscribers once per act and stops telling an unsubscribed one", async () => {
    const overrides = overrideStore();
    let changes = 0;
    const unsubscribe = overrides.subscribe(() => {
      changes += 1;
    });
    await overrides.bind("frame.goToSessions", "$mod+9");
    expect(changes).toBe(1);
    unsubscribe();
    await overrides.bind("frame.goToSessions", "$mod+8");
    expect(changes).toBe(1);
  });
});

describe("what one window wrote, the next one reads", () => {
  it("carries an override through the store and back", async () => {
    const adapter = new MemoryPersistenceAdapter();
    const writer = overrideStore();
    await writer.hydrateFrom(uiStateStore(adapter));
    const written = await writer.bind("frame.goToSessions", "$mod+9");
    expect(written.outcome).toBe("bound");
    if (written.outcome === "bound") {
      expect(written.unsaved).toBeUndefined();
    }

    const reader = overrideStore();
    await reader.hydrateFrom(uiStateStore(adapter));
    expect(reader.surface.bindings[0]?.chord).toBe("$mod+9");
    expect(reader.hydrationRefusals).toHaveLength(0);
  });

  it("negative control: a store that read nothing installs the shipped chords", async () => {
    // Without this the round trip above would pass against a reader that had simply
    // kept the writer's in-memory map, which no second window ever sees.
    const reader = overrideStore();
    await reader.hydrateFrom(uiStateStore());
    expect(reader.surface.bindings).toStrictEqual(DEFAULTS);
  });

  it("declines a stored chord that no longer installs rather than raising on it", async () => {
    const adapter = new MemoryPersistenceAdapter();
    const store = uiStateStore(adapter);
    // Written directly, as a stale profile from an earlier release would be: this
    // chord now collides with a shipped one.
    await store.writeGlobal(KEYBINDING_OVERRIDES_KEY, "keybinding", {
      "frame.goToSessions": "Alt+Digit2",
    });

    const reader = overrideStore();
    await reader.hydrateFrom(uiStateStore(adapter));
    expect(reader.surface.bindings).toStrictEqual(DEFAULTS);
    expect(reader.hydrationRefusals.map((declined) => declined.refusal.code)).toStrictEqual([
      "chord-taken",
    ]);
  });

  it("keeps the newer hydration's overrides when the older one answers last", async () => {
    // The frame replaces this window's durable store on a bridge or scenario change,
    // and the read the first store had open does not stop. Answering last, it used to
    // install the map it read over the map the current store had just supplied — and
    // the next rebinding then persisted that stale profile into the new store.
    const replaced = await heldStoreHolding("frame.goToSessions", "Alt+Digit3");
    const current = await heldStoreHolding("frame.goToWorkflows", "Alt+Digit4");
    const overrides = overrideStore();

    const first = overrides.hydrateFrom(replaced.store);
    const second = overrides.hydrateFrom(current.store);
    await current.adapter.answer();
    await second;
    await replaced.adapter.answer();
    await first;

    expect(overrides.overrides).toStrictEqual({ "frame.goToWorkflows": "Alt+Digit4" });
  });

  it("negative control: the newer hydration's overrides do land when it answers last", async () => {
    // Without this the case above would pass over a store that ignored every
    // hydration but the first, which is the same defect pointing the other way.
    const replaced = await heldStoreHolding("frame.goToSessions", "Alt+Digit3");
    const current = await heldStoreHolding("frame.goToWorkflows", "Alt+Digit4");
    const overrides = overrideStore();

    const first = overrides.hydrateFrom(replaced.store);
    const second = overrides.hydrateFrom(current.store);
    await replaced.adapter.answer();
    await first;
    await current.adapter.answer();
    await second;

    expect(overrides.overrides).toStrictEqual({ "frame.goToWorkflows": "Alt+Digit4" });
  });

  it("discloses a refused write rather than reporting a preference that was kept", async () => {
    // A ceiling one byte under the record: the chord IS bound for this window, and
    // the store says it will not come back.
    const overrides = overrideStore();
    await overrides.hydrateFrom(uiStateStore(new MemoryPersistenceAdapter({ capacityBytes: 1 })));
    const result = await overrides.bind("frame.goToSessions", "$mod+9");
    expect(result.outcome).toBe("bound");
    if (result.outcome === "bound") {
      expect(result.unsaved?.origin).toBe("persistence");
    }
    expect(overrides.surface.bindings[0]?.chord).toBe("$mod+9");
  });
});
