// What the service's answers leave on screen: the feed's reading over the defaults, a
// write's answer installed unless newer news arrived first, and which rows are waiting.

import { describe, expect, it } from "vitest";

import {
  MACHINE_SETTINGS_DEFAULTS,
  type MachineSettings,
  type MachineSettingsChange,
  type MachineSettingsReading,
} from "@ai-sidekicks/contracts";
import type { PreloadApi } from "@shared/preload-api.js";
import { MachineSettingsStore } from "./machine-settings-store.js";
import { effectiveSettings } from "./machine-settings-snapshot.js";

type MachineSettingsBridge = PreloadApi["machineSettings"];

/** One write the service has not answered yet. */
interface HeldWrite {
  readonly answer: (settings: MachineSettings) => void;
  readonly refuse: (error: Error) => void;
}

/**
 * The bridge's `machineSettings`, driven by hand: a case delivers on the feed and answers or
 * refuses each write in the order it chooses, because the subject is the order answers land in.
 */
class HandDrivenMachineSettings implements MachineSettingsBridge {
  public readonly writes: MachineSettingsChange[] = [];
  #deliver: ((reading: MachineSettingsReading) => void) | undefined;
  #subscriptions = 0;
  readonly #settlers: HeldWrite[] = [];

  public get subscriptions(): number {
    return this.#subscriptions;
  }

  public write(change: MachineSettingsChange): Promise<MachineSettings> {
    this.writes.push(change);
    return new Promise((resolve, reject) => {
      this.#settlers.push({ answer: resolve, refuse: reject });
    });
  }

  public subscribe(handler: (reading: MachineSettingsReading) => void): () => void {
    this.#deliver = handler;
    this.#subscriptions += 1;
    return () => {
      this.#deliver = undefined;
      this.#subscriptions -= 1;
    };
  }

  public deliver(reading: MachineSettingsReading): void {
    this.#deliver?.(reading);
  }

  /** Answer the write made `index`-th with `settings`. */
  public async answer(index: number, settings: MachineSettings): Promise<void> {
    this.#settlerAt(index).answer(settings);
    await Promise.resolve();
    await Promise.resolve();
  }

  public refuse(index: number, error: Error): void {
    this.#settlerAt(index).refuse(error);
  }

  #settlerAt(index: number): HeldWrite {
    const settler = this.#settlers[index];
    if (settler === undefined) {
      throw new Error(`no write number ${index} is in flight`);
    }
    return settler;
  }
}

function settingsWith(change: Partial<MachineSettings>): MachineSettings {
  return { ...MACHINE_SETTINGS_DEFAULTS, ...change };
}

function startedStore(): {
  readonly store: MachineSettingsStore;
  readonly service: HandDrivenMachineSettings;
} {
  const service = new HandDrivenMachineSettings();
  const store = new MachineSettingsStore(service);
  store.start();
  return { store, service };
}

describe("machine settings — the feed is the read", () => {
  it("shows the defaults until the feed delivers, then the file the service read", () => {
    const { store, service } = startedStore();
    expect(store.snapshot().reading).toBeUndefined();
    expect(effectiveSettings(store.snapshot()).keepCrashReports).toBe(true);

    service.deliver({ settings: settingsWith({ keepCrashReports: false }) });

    expect(effectiveSettings(store.snapshot()).keepCrashReports).toBe(false);
  });

  it("subscribes once however often it is started, and lets go when disposed", () => {
    const { store, service } = startedStore();
    store.start();
    expect(service.subscriptions).toBe(1);

    store.dispose();
    service.deliver({ settings: settingsWith({ keepCrashReports: false }) });

    expect(service.subscriptions).toBe(0);
    expect(store.snapshot().reading).toBeUndefined();
  });
});

describe("machine settings — a write", () => {
  it("sends one member and installs the file as written, clearing a repair", async () => {
    const { store, service } = startedStore();
    service.deliver({
      settings: MACHINE_SETTINGS_DEFAULTS,
      repair: { repairedAt: "2026-09-30T12:00:00.000Z", cause: "unparseable" },
    });

    const chosen = store.choose("updatesAutomatic", false);
    expect(service.writes).toStrictEqual([{ updatesAutomatic: false }]);
    await service.answer(0, settingsWith({ updatesAutomatic: false }));
    await chosen;

    expect(effectiveSettings(store.snapshot()).updatesAutomatic).toBe(false);
    expect(store.snapshot().reading?.repair).toBeUndefined();
  });

  it("negative control: a refused write leaves the stored value and stops pending", async () => {
    const { store, service } = startedStore();
    service.deliver({ settings: MACHINE_SETTINGS_DEFAULTS });

    const chosen = store.choose("updatesAutomatic", false);
    service.refuse(0, new Error("read-only"));

    await expect(chosen).rejects.toThrow("read-only");
    expect(effectiveSettings(store.snapshot()).updatesAutomatic).toBe(true);
    expect(store.snapshot().pendingMembers.size).toBe(0);
  });

  it("drops a write's answer that lands after a newer feed delivery", async () => {
    // Another window's change arrives while this write is out; installing the write's older
    // answer would take that change off this screen.
    const { store, service } = startedStore();
    service.deliver({ settings: MACHINE_SETTINGS_DEFAULTS });

    const chosen = store.choose("updatesAutomatic", false);
    service.deliver({
      settings: settingsWith({ updatesAutomatic: false, keepCrashReports: false }),
    });
    await service.answer(0, settingsWith({ updatesAutomatic: false }));
    await chosen;

    expect(effectiveSettings(store.snapshot()).keepCrashReports).toBe(false);
    expect(store.snapshot().pendingMembers.size).toBe(0);
  });

  it("drops an older write's answer that lands after a newer write's", async () => {
    const { store, service } = startedStore();
    const older = store.choose("updatesAutomatic", false);
    const newer = store.choose("updatesAutomatic", true);

    await service.answer(1, settingsWith({ updatesAutomatic: true }));
    await service.answer(0, settingsWith({ updatesAutomatic: false }));
    await Promise.all([older, newer]);

    expect(effectiveSettings(store.snapshot()).updatesAutomatic).toBe(true);
  });
});

describe("machine settings — which rows are waiting", () => {
  it("clears only the settled member, and holds a member until its last write settles", async () => {
    const { store, service } = startedStore();
    const first = store.choose("updatesAutomatic", false);
    const second = store.choose("keepCrashReports", false);
    const third = store.choose("updatesAutomatic", true);
    expect(store.snapshot().pendingMembers).toStrictEqual(
      new Set(["updatesAutomatic", "keepCrashReports"]),
    );

    await service.answer(0, settingsWith({ updatesAutomatic: false }));
    await first;
    // The second write for the same member is still out, so its row still waits.
    expect(store.snapshot().pendingMembers).toStrictEqual(
      new Set(["updatesAutomatic", "keepCrashReports"]),
    );

    await service.answer(1, settingsWith({ updatesAutomatic: false, keepCrashReports: false }));
    await second;
    expect(store.snapshot().pendingMembers).toStrictEqual(new Set(["updatesAutomatic"]));

    await service.answer(2, settingsWith({ updatesAutomatic: true, keepCrashReports: false }));
    await third;
    expect(store.snapshot().pendingMembers).toStrictEqual(new Set());
  });
});
