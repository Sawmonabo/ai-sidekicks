// The fixture bridge: a real platform bridge backed by a scripted scenario. The daemon half is
// `services/daemon/scenario/wire.fixture.ts`; this assembles it with the host's other answers.
//
// Native calls refuse rather than pretend, so a view cannot ship a code path nobody ran against
// the real dialog. The `app` meta is fixed so a rendered view does not shift with the machine. The
// keyboard map is held in memory: the first read is empty and a write is read back, which is the
// Keyboard page's whole contract with main. The appearance record is held the same way: the default
// appearance at first, and a chosen one reaches every subscriber, as main carries it to every
// window.

import type { AppFacts } from "#shared/app-facts.js";
import { ClipboardPieces } from "#shared/clipboard-pieces.js";
import { DEFAULT_APPEARANCE_RECORD, type AppearanceRecord } from "#shared/appearance.js";
import { consoleWindowId } from "#shared/window/frame-name.js";
import type {
  KeyboardMap,
  KeyboardMapReading,
  Unsubscribe,
  UpdateState,
} from "#shared/preload-api.js";
import type { PlatformBridge } from "./bridge.js";
import { ClockLocale } from "./clock-locale.js";
import { PendingClipboardCopies } from "./clipboard/pending-copies.js";
import {
  FixtureBridgeError,
  refuseAbsentCapability,
} from "#renderer/services/daemon/refusal.fixture.js";
import { TransportReconnectSignal } from "#renderer/services/transport/reconnect.js";
import { ScenarioEngine } from "#renderer/services/daemon/engine.fixture.js";
import { createFixtureDaemon } from "#renderer/services/daemon/scenario/wire.fixture.js";
import type { Scenario } from "#fixtures/scenario.js";

/** Fixed `app` meta, so a rendered view does not move with the machine. */
export const FIXTURE_APP_META: AppFacts = {
  version: "0.0.0-fixture",
  platform: "darwin",
  hasPrimarySelection: false,
  arch: "arm64",
  locale: "en-US",
  // 16 GiB, the machine the screen's memory budgets were measured on.
  physicalMemoryBytes: 17_179_869_184,
  // A Mac set to the United States at its own 12-hour clock.
  regionLocale: "en-US",
  hourCycle: "h12",
};

/** The window a fixture console opens first, fixed as the `app` meta is. */
export const FIXTURE_WINDOW_ID: string = consoleWindowId("fixture");

/** Options for `createFixtureBridge`. */
export interface FixtureBridgeOptions {
  readonly scenario: Scenario;
}

/**
 * The fixture bridge and the engine playing its scenario. The engine is the fixture seam's,
 * not the bridge's: its frozen clock is the one the window runs on, and it is what a driver
 * advances.
 */
export interface FixtureBridge {
  readonly bridge: PlatformBridge;
  readonly scenarioEngine: ScenarioEngine;
  /**
   * The pieces of the late copies the bridge holds, one for each clipboard, as main holds them,
   * which a suite answering a late write itself reads the copy's content from.
   */
  readonly clipboardPieces: ClipboardPieces;
}

/** Builds the fixture bridge for one scenario, with the engine that plays it. */
export function createFixtureBridge(options: FixtureBridgeOptions): FixtureBridge {
  const scenarioEngine = new ScenarioEngine({ scenario: options.scenario });
  const updaterState: UpdateState = options.scenario.updaterState ?? { status: "idle" };
  let keyboardMap: KeyboardMap = {};
  let appearanceRecord: AppearanceRecord = DEFAULT_APPEARANCE_RECORD;
  const appearanceHandlers = new Set<(record: AppearanceRecord) => void>();
  const clipboardPieces = new ClipboardPieces();
  // The late copy whose text the system clipboard holds, the one fact of a clipboard a fixture
  // keeps.
  let heldLateCopyId: string | undefined;
  // A fixture runs no main, so the machine's region and clock never change under it.
  const app: PlatformBridge["app"] = {
    ...FIXTURE_APP_META,
    subscribeMachineClock: (): Unsubscribe => () => undefined,
    // A fixture run has no service log, so its windows' diagnostics end here.
    reportWindowDiagnostics: () => Promise.resolve(),
    // A fixture's pictures fill the same caches, but only the preload can empty them.
    freeUnusedMemory: () => undefined,
  };
  const bridge: PlatformBridge = {
    daemon: createFixtureDaemon(scenarioEngine),
    native: {
      showOpenDialog: () => refuseAbsentCapability("native.showOpenDialog"),
      getDroppedFileRef: () => refuseAbsentCapability("native.getDroppedFileRef"),
      savePastedImage: () => refuseAbsentCapability("native.savePastedImage"),
      openExternal: async () => {
        // A fixture window opens no browser; answering lets an `Open …` press settle as it does
        // live, where the page keeps the address beside the control either way.
      },
      openInEditor: () => refuseAbsentCapability("native.openInEditor"),
      listEditors: () => refuseAbsentCapability("native.listEditors"),
      getNotificationPermission: () => refuseAbsentCapability("native.getNotificationPermission"),
      copyToClipboard: async (_content, clipboard) => {
        // Nothing reads the result back, and a refusal would make every "copy id" affordance
        // untestable; a write takes the system clipboard from any late copy that held it.
        if (clipboard === undefined) {
          heldLateCopyId = undefined;
        }
      },
      // The fixture keeps no clipboard's content: a snapshot reads it empty, so a later write
      // lands while its pieces are held, as the same write a copy at once makes, read at the call
      // so a spy on it sees the write.
      takeClipboardSnapshot: async (clipboard) =>
        clipboard === undefined ? { digest: "" } : { clipboard, digest: "" },
      sendClipboardPiece: async (piece) => {
        clipboardPieces.take(piece);
      },
      dropClipboardPieces: async (copyId) => {
        clipboardPieces.drop(copyId);
      },
      // A picture lands nowhere, the fixture keeping no clipboard; its pieces stay for a test.
      copyToClipboardUnlessChanged: async (copyId, since) => {
        if (!clipboardPieces.isHeld(copyId)) {
          return false;
        }
        const content = clipboardPieces.contentOf(copyId);
        if (!("png" in content)) {
          await (since.clipboard === undefined
            ? bridge.native.copyToClipboard(content)
            : bridge.native.copyToClipboard(content, since.clipboard));
        }
        if (since.clipboard === undefined) {
          heldLateCopyId = copyId;
        }
        return true;
      },
      // Beside the copy's text while no other write took the system clipboard; the copy is let go.
      addClipboardFormatting: async (copyId) => {
        if (!clipboardPieces.isHeld(copyId)) {
          return false;
        }
        const content = clipboardPieces.contentOf(copyId);
        clipboardPieces.drop(copyId);
        if (!("html" in content) || content.html === undefined) {
          throw new Error(
            "A clipboard copy's formatting was asked for before its pieces were sent.",
          );
        }
        if (heldLateCopyId !== copyId) {
          return false;
        }
        await bridge.native.copyToClipboard(content);
        return true;
      },
      revealInFileExplorer: () => refuseAbsentCapability("native.revealInFileExplorer"),
    },
    update: {
      // The scenario's declaration, or a bare `idle`. The default omits the optional
      // `lastCheckedAt` so the never-checked arm stays reachable.
      getState: async (): Promise<UpdateState> => updaterState,
      subscribe: (handler): Unsubscribe => {
        handler(updaterState);
        return () => undefined;
      },
      requestCheck: () => refuseAbsentCapability("update.requestCheck"),
      requestDownload: () => refuseAbsentCapability("update.requestDownload"),
      requestRestart: () => refuseAbsentCapability("update.requestRestart"),
    },
    machineSettings: {
      read: () => refuseAbsentCapability("machineSettings.read"),
      write: () => refuseAbsentCapability("machineSettings.write"),
      subscribe: () => refuseAbsentSubscription("machineSettings.subscribe"),
    },
    keyboardMap: {
      read: async (): Promise<KeyboardMapReading> => ({ map: keyboardMap }),
      write: async (map): Promise<KeyboardMap> => {
        keyboardMap = map;
        return map;
      },
    },
    window: {
      lastUsedWindowId: FIXTURE_WINDOW_ID,
      setAppearance: async (choice, grounds): Promise<void> => {
        const record: AppearanceRecord = { ...choice, grounds };
        appearanceRecord = record;
        for (const handler of appearanceHandlers) {
          handler(record);
        }
      },
      subscribeAppearance: (handler): Unsubscribe => {
        // A wrapper per subscription, so the same function subscribed twice is two subscriptions.
        const subscription = (record: AppearanceRecord): void => {
          handler(record);
        };
        appearanceHandlers.add(subscription);
        subscription(appearanceRecord);
        return () => {
          appearanceHandlers.delete(subscription);
        };
      },
      setMinimumSize: async () => {
        // Nothing reads the floor back, and the harness sizes the fixture window itself.
      },
      bringForward: async () => {
        // A fixture runs no main to bring a window forward; the harness lays out every one itself.
      },
      // A fixture runs no main, so no window's Edit menu can paste for it.
      paste: () => refuseAbsentCapability("window.paste"),
      setDefaultSizes: async () => {
        // Nothing reads the sizes back, and the harness sizes the fixture window itself.
      },
      endSafeStart: async () => {
        // A fixture runs no main, so no window place is kept for it to resume.
      },
      // A fixture runs no main to ask for a window; the harness opens every one itself.
      subscribeToReopenRequest: (): Unsubscribe => () => undefined,
      // A fixture runs no main and no View menu, so no pick goes unkept.
      subscribeToUnkeptScheme: (): Unsubscribe => () => undefined,
      // A fixture launch is given no link and runs no main to hand one over.
      subscribeToNavigationRequest: (): Unsubscribe => () => undefined,
    },
    app,
    transportReconnect: new TransportReconnectSignal(),
    clockLocale: new ClockLocale(app),
    pendingClipboardCopies: new PendingClipboardCopies(),
    source: "fixture",
  };
  return { bridge, scenarioEngine, clipboardPieces };
}

/**
 * Refuses, by throwing, a member main answers synchronously and the fixture cannot stand in for (a
 * subscription main pushes, or a publication main receives). It throws because the signature
 * returns before anything could settle.
 */
function refuseAbsentSubscription(call: string): never {
  throw new FixtureBridgeError(
    call,
    "capability-absent",
    "this capability needs the real main process and has no fixture stand-in",
  );
}
