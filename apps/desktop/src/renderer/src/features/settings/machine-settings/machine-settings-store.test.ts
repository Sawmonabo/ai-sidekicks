// What the service's answers leave on screen: the feed's reading over the defaults, a
// write's answer installed unless newer news arrived first, which rows are waiting, and a feed
// that ended or could not open taken up again, after a wait when it keeps ending at once.

import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
  MACHINE_SETTINGS_DEFAULTS,
  type MachineSettings,
  type MachineSettingsChange,
  type MachineSettingsReading,
} from "@ai-sidekicks/contracts/machine-settings";
import type { DaemonSubscriptionEnd } from "@shared/daemon-forwarding.js";
import { windowDiagnosticCapture } from "@renderer/lib/diagnostic-capture/diagnostic-capture.js";
import { REOPEN_WAITS_MS } from "@renderer/services/transport/reopening-subscription.js";
import { TransportReconnectSignal } from "@renderer/services/transport/transport-reconnect.js";
import { MachineSettingsStore, type MachineSettingsService } from "./machine-settings-store.js";
import { effectiveSettings } from "./machine-settings-snapshot.js";

/** One write the service has not answered yet. */
interface HeldWrite {
  readonly answer: (settings: MachineSettings) => void;
  readonly refuse: (error: Error) => void;
}

/**
 * The bridge's `machineSettings`, driven by hand: a case delivers on the feed and answers or
 * refuses each write in the order it chooses, because the subject is the order answers land in.
 */
class HandDrivenMachineSettings implements MachineSettingsService {
  public readonly writes: MachineSettingsChange[] = [];
  /** Whether the feed refuses to open, as it does while the service is away. */
  public isAway = false;
  #deliver: ((reading: MachineSettingsReading) => void) | undefined;
  #onEnded: ((end: DaemonSubscriptionEnd) => void) | undefined;
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

  public subscribe(
    handler: (reading: MachineSettingsReading) => void,
    onEnded?: (end: DaemonSubscriptionEnd) => void,
  ): () => void {
    if (this.isAway) {
      throw new Error("The background service is not connected.");
    }
    this.#deliver = handler;
    this.#onEnded = onEnded;
    this.#subscriptions += 1;
    return () => {
      this.#deliver = undefined;
      this.#subscriptions -= 1;
    };
  }

  public deliver(reading: MachineSettingsReading): void {
    this.#deliver?.(reading);
  }

  /** End the open feed as the link under it failing would. */
  public endFeed(): void {
    const onEnded = this.#onEnded;
    this.#deliver = undefined;
    this.#onEnded = undefined;
    this.#subscriptions -= 1;
    onEnded?.({ reason: "failed", message: "Transport closed" });
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

function startedStore(transportReconnect = new TransportReconnectSignal()): {
  readonly store: MachineSettingsStore;
  readonly service: HandDrivenMachineSettings;
} {
  const service = new HandDrivenMachineSettings();
  const store = new MachineSettingsStore(service, transportReconnect);
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

describe("machine settings — a feed that ends", () => {
  it("opens again at once after one that delivered, on the return after one it could not, and after a wait when it ends at once again", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    windowDiagnosticCapture.flush();
    const batches: string[] = [];
    const detachForwarder = windowDiagnosticCapture.installForwarder((jsonLines) => {
      batches.push(jsonLines);
    });
    batches.length = 0;
    const signal = new TransportReconnectSignal();
    const { store, service } = startedStore(signal);
    service.deliver({ settings: MACHINE_SETTINGS_DEFAULTS });

    service.isAway = true;
    service.endFeed();
    signal.observe("unreachable");
    expect(service.subscriptions).toBe(0);

    service.isAway = false;
    signal.observe("reachable");
    expect(service.subscriptions).toBe(1);
    service.deliver({ settings: settingsWith({ keepCrashReports: false }) });
    expect(effectiveSettings(store.snapshot()).keepCrashReports).toBe(false);

    service.endFeed();
    expect(service.subscriptions).toBe(0);
    vi.advanceTimersByTime(REOPEN_WAITS_MS.at(-1)!);
    expect(service.subscriptions).toBe(1);

    // Nothing is drawn for a feed that stopped, so the diagnostics are where each one is seen.
    windowDiagnosticCapture.flush();
    detachForwarder();
    const feedRecords = batches
      .flatMap((batch) => batch.split("\n"))
      .map((line) => JSON.parse(line) as { kind: string; detail: string })
      .filter((record) => record.detail.startsWith("daemon.machineSettingsSubscribe:"))
      .map((record) => record.kind);
    expect(feedRecords).toStrictEqual([
      "subscription-ended",
      "subscription-open-failed",
      "subscription-ended",
    ]);
  });
});

describe("machine settings — a feed that could not open", () => {
  it("starts without throwing while the service is away, and opens on its return", () => {
    const signal = new TransportReconnectSignal();
    const service = new HandDrivenMachineSettings();
    service.isAway = true;
    const store = new MachineSettingsStore(service, signal);

    store.start();
    expect(service.subscriptions).toBe(0);

    service.isAway = false;
    signal.observe("reachable");
    expect(service.subscriptions).toBe(1);
    service.deliver({ settings: settingsWith({ keepCrashReports: false }) });
    expect(effectiveSettings(store.snapshot()).keepCrashReports).toBe(false);
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

  it("negative control: a refused write keeps the value, ends pending and says why", async () => {
    const { store, service } = startedStore();
    service.deliver({ settings: MACHINE_SETTINGS_DEFAULTS });

    const chosen = store.choose("updatesAutomatic", false);
    service.refuse(0, new Error("read-only"));

    await chosen;
    expect(effectiveSettings(store.snapshot()).updatesAutomatic).toBe(true);
    expect(store.snapshot().pendingMembers.size).toBe(0);
    expect(store.snapshot().refusalByMember.get("updatesAutomatic")?.detail).toBe("read-only");
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
  it("clears only the settled member, holding a member until its last write settles", async () => {
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
