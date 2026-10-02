// An override wins over the shipped chord, a conflict is refused, and what one window wrote the
// next reads back from the keyboard map.

import { describe, expect, it } from "vitest";

import type { KeyboardMap, KeyboardMapReading } from "@shared/preload-api.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { CommandRegistry } from "../commands/command-registry.js";
import { type Keybinding } from "../commands/command-types.js";
import { KeybindingTable } from "./keybinding-table.js";
import { KeybindingOverrideStore } from "./keybinding-override-store.js";

/**
 * The shipped table on `Alt`, not `$mod`, which tinykeys resolves per host; the cases test which
 * command runs.
 */
const DEFAULTS: readonly Keybinding[] = [
  { chord: "Alt+Digit1", commandId: "frame.goToSessions" },
  { chord: "Alt+Digit2", commandId: "frame.goToWorkflows" },
];

/** The acts this window has, by title: the two the shipped table binds. */
const COMMAND_TITLES: ReadonlyMap<string, string> = new Map([
  ["frame.goToSessions", "Sessions"],
  ["frame.goToWorkflows", "Workflows"],
]);

function overrideStore(): KeybindingOverrideStore {
  return new KeybindingOverrideStore({
    defaults: () => DEFAULTS,
    commandTitle: (commandId) => COMMAND_TITLES.get(commandId),
    platform: "darwin",
  });
}

type KeyboardMapBridge = PlatformBridge["keyboardMap"];

/**
 * Main's keyboard map held in memory; {@link holdReads} keeps reads open so two hydrations overlap.
 */
class MemoryKeyboardMap implements KeyboardMapBridge {
  public stored: KeyboardMap;
  public failWrites = false;
  public failReads = false;
  #letReadAnswer: (() => void) | undefined;
  #holdsReads = false;

  public constructor(stored: KeyboardMap = {}) {
    this.stored = stored;
  }

  public holdReads(): void {
    this.#holdsReads = true;
  }

  public async read(): Promise<KeyboardMapReading> {
    if (this.#holdsReads) {
      await new Promise<void>((resolve) => {
        this.#letReadAnswer = resolve;
      });
    }
    if (this.failReads) {
      throw new Error("Error invoking remote method 'keyboardMap.read': EACCES");
    }
    return { map: this.stored };
  }

  public async write(map: KeyboardMap): Promise<KeyboardMap> {
    if (this.failWrites) {
      throw new Error("Error invoking remote method 'keyboardMap.write': ENOSPC");
    }
    this.stored = map;
    return map;
  }

  /** Lets the held read answer and its hydration finish; throws if no read is held. */
  public async answer(): Promise<void> {
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

function heldMapHolding(commandId: string, chord: string): MemoryKeyboardMap {
  const keyboardMap = new MemoryKeyboardMap({ [commandId]: chord });
  keyboardMap.holdReads();
  return keyboardMap;
}

/** A press of `Alt+1`. */
function altOnePress(): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "1", code: "Digit1", altKey: true });
}

/** The two navigation commands, recording which one a press ran. */
function navigationRegistry(ran: string[]): CommandRegistry {
  const registry = new CommandRegistry();
  registry.registerAll([
    {
      id: "frame.goToSessions",
      title: "Sessions",
      group: "App",
      run: () => {
        ran.push("sessions");
      },
    },
    {
      id: "frame.goToWorkflows",
      title: "Flows",
      group: "App",
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
    // The shipped `Alt+1` runs Sessions; once moved to Workflows, the same press must reach it.
    await overrides.unbind("frame.goToSessions");
    await overrides.bind("frame.goToWorkflows", "Alt+Digit1");

    const ran: string[] = [];
    const table = new KeybindingTable({
      registry: navigationRegistry(ran),
      readContext: () => ({}),
    });
    table.setBindings(overrides.snapshot.bindings);

    expect(table.handleKeyDown(altOnePress())).toBe(true);
    expect(ran).toStrictEqual(["workflows"]);
  });
});

describe("what the store refuses", () => {
  it("refuses a chord another act answers to, naming that act", async () => {
    const overrides = overrideStore();
    const result = await overrides.bind("frame.goToSessions", "Alt+Digit2");
    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("chord-taken");
      expect(result.refusal.detail).toBe("⌥2 already opens Workflows.");
    }
    // Refused before anything moved.
    expect(overrides.snapshot.bindings).toStrictEqual(DEFAULTS);
  });
});

describe("what one window wrote, the next one reads", () => {
  it("carries an override through the keyboard map and back", async () => {
    const keyboardMap = new MemoryKeyboardMap();
    const writer = overrideStore();
    await writer.hydrateFrom(keyboardMap);
    const written = await writer.bind("frame.goToSessions", "$mod+9");
    expect(written.outcome).toBe("bound");
    if (written.outcome === "bound") {
      expect(written.unsaved).toBeUndefined();
    }
    expect(keyboardMap.stored).toStrictEqual({ "frame.goToSessions": "$mod+9" });

    const reader = overrideStore();
    await reader.hydrateFrom(keyboardMap);
    expect(reader.snapshot.bindings[0]?.chord).toBe("$mod+9");
    expect(reader.hydrationRefusals).toHaveLength(0);
  });

  it("declines a stored chord that no longer installs rather than raising on it", async () => {
    // This stored chord now collides with a shipped one.
    const reader = overrideStore();
    await reader.hydrateFrom(new MemoryKeyboardMap({ "frame.goToSessions": "Alt+Digit2" }));
    expect(reader.snapshot.bindings).toStrictEqual(DEFAULTS);
    expect(reader.hydrationRefusals.map((declined) => declined.refusal.code)).toStrictEqual([
      "chord-taken",
    ]);
  });

  it("skips an override for an act that no longer exists, and leaves it out of the next write", async () => {
    // Two stored entries name acts this window lacks: one rebound, one left unbound.
    const keyboardMap = new MemoryKeyboardMap({
      "frame.goToSessions": "$mod+9",
      "retired.openTranscript": "$mod+8",
      "retired.closeTranscript": null,
    });

    const reader = overrideStore();
    await reader.hydrateFrom(keyboardMap);
    expect(reader.overrides).toStrictEqual({ "frame.goToSessions": "$mod+9" });
    expect(reader.snapshot.bindings.map((binding) => binding.commandId)).toStrictEqual([
      "frame.goToSessions",
      "frame.goToWorkflows",
    ]);
    expect(reader.hydrationRefusals).toHaveLength(0);

    await reader.bind("frame.goToWorkflows", "$mod+7");
    expect(keyboardMap.stored).toStrictEqual({
      "frame.goToSessions": "$mod+9",
      "frame.goToWorkflows": "$mod+7",
    });
  });

  it("keeps the newer hydration's overrides when the older one answers last", async () => {
    // A replaced bridge's read keeps running; answering last it must not install its stale map.
    const replaced = heldMapHolding("frame.goToSessions", "Alt+Digit3");
    const current = heldMapHolding("frame.goToWorkflows", "Alt+Digit4");
    const overrides = overrideStore();

    const first = overrides.hydrateFrom(replaced);
    const second = overrides.hydrateFrom(current);
    await current.answer();
    await second;
    await replaced.answer();
    await first;

    expect(overrides.overrides).toStrictEqual({ "frame.goToWorkflows": "Alt+Digit4" });
  });

  it("discloses a refused write rather than reporting a preference that was kept", async () => {
    // The chord is bound for this window, and the store says it will not come back.
    const keyboardMap = new MemoryKeyboardMap();
    keyboardMap.failWrites = true;
    const overrides = overrideStore();
    await overrides.hydrateFrom(keyboardMap);
    const result = await overrides.bind("frame.goToSessions", "$mod+9");
    expect(result.outcome).toBe("bound");
    if (result.outcome === "bound") {
      expect(result.unsaved?.code).toBe("keyboard-map-unsaved");
    }
    expect(overrides.snapshot.bindings[0]?.chord).toBe("$mod+9");
  });

  it("runs on the shipped chords and says why when the map cannot be read", async () => {
    const keyboardMap = new MemoryKeyboardMap({ "frame.goToSessions": "$mod+9" });
    keyboardMap.failReads = true;
    const overrides = overrideStore();
    await overrides.hydrateFrom(keyboardMap);
    expect(overrides.snapshot.bindings).toStrictEqual(DEFAULTS);
    expect(overrides.readRefusal?.code).toBe("keyboard-map-unread");
    // Main's message can name a path, so the detail must not carry it.
    expect(overrides.readRefusal?.detail).not.toContain("EACCES");
  });
});

describe("the shipped table is read, not captured", () => {
  /** A base a case can grow, with the signal that says it did. */
  function growableBase(): {
    readonly options: {
      readonly defaults: () => readonly Keybinding[];
      readonly subscribeToDefaults: (onDefaultsChange: () => void) => () => void;
      readonly commandTitle: (commandId: string) => string | undefined;
      readonly platform: "darwin";
    };
    readonly contribute: (binding: Keybinding) => void;
  } {
    let base: readonly Keybinding[] = DEFAULTS;
    const listeners = new Set<() => void>();
    return {
      options: {
        defaults: () => base,
        subscribeToDefaults: (onDefaultsChange) => {
          listeners.add(onDefaultsChange);
          return () => listeners.delete(onDefaultsChange);
        },
        commandTitle: (commandId) =>
          base.some((binding) => binding.commandId === commandId) ? commandId : undefined,
        platform: "darwin",
      },
      contribute: (binding) => {
        base = [...base, binding];
        for (const listener of listeners) {
          listener();
        }
      },
    };
  }

  it("composes over a table that grew after the store was built", () => {
    // Features contribute from effects, so the table is incomplete at construction.
    const growable = growableBase();
    const overrides = new KeybindingOverrideStore(growable.options);
    expect(overrides.snapshot.shippedBindings).toHaveLength(DEFAULTS.length);

    growable.contribute({ chord: "Alt+Digit3", commandId: "transcript.open" });

    expect(overrides.snapshot.shippedBindings).toHaveLength(DEFAULTS.length + 1);
    expect(overrides.snapshot.bindings.map((binding) => binding.commandId)).toContain(
      "transcript.open",
    );
  });
});
