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
