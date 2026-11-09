// The presence heartbeat: this device tells the machine, over main's link to the background
// service, whether an app window is in front. The service reads it to decide whether a moment
// raises a banner on this device. A window counts as in front while one of the app's windows holds
// focus and the screen is neither locked nor asleep. The heartbeat goes out when the link comes up,
// at once whenever that fact changes, and otherwise every 15 seconds, so the service never holds a
// stale answer for long; nothing is sent while no link is up.

import {
  PRESENCE_METHOD_DESCRIPTORS,
  type PresenceHeartbeatSendRequest,
} from "@ai-sidekicks/contracts/presence";
import type { App, PowerMonitor } from "electron";

import { describeFailure } from "#shared/failure-message.js";
import type { MainDaemonClient } from "./daemon/client/process.js";
import type { DaemonLink } from "./daemon/link/status.js";

/** What the heartbeat reads off Electron and the link it sends on. */
export interface PresenceHeartbeatDependencies {
  /** Tells when any app window gains or loses focus. */
  readonly app: Pick<App, "on">;
  /** Tells when the screen locks or unlocks and when the machine sleeps or wakes. */
  readonly powerMonitor: Pick<PowerMonitor, "on" | "getSystemIdleState">;
  /** Whether one of the app's windows holds focus now. */
  readonly isAnyWindowFocused: () => boolean;
  /** Main's link to the background service. */
  readonly daemonLink: Pick<DaemonLink, "client" | "subscribe">;
  /** Records a heartbeat the service did not take; the next one is sent regardless. */
  readonly logWarning: (message: string) => void;
}

/**
 * Sends this device's presence on main's link for the app's lifetime. Created once, after the app
 * is ready, since Electron's power monitor is unavailable before that.
 */
export class PresenceHeartbeat {
  readonly #dependencies: PresenceHeartbeatDependencies;
  #isScreenLocked: boolean;
  #isAsleep = false;
  #lastSentAppVisible: boolean | undefined;
  #linkClient: MainDaemonClient | undefined;
  #nextBeat: ReturnType<typeof setTimeout> | undefined;

  public constructor(dependencies: PresenceHeartbeatDependencies) {
    this.#dependencies = dependencies;
    // A lock taken before the app started sends no event, so the idle state seeds it.
    this.#isScreenLocked = dependencies.powerMonitor.getSystemIdleState(0) === "locked";
    const onChange = (): void => {
      this.#sendIfChanged();
    };
    dependencies.app.on("browser-window-focus", onChange);
    dependencies.app.on("browser-window-blur", onChange);
    dependencies.powerMonitor.on("lock-screen", () => {
      this.#isScreenLocked = true;
      this.#sendIfChanged();
    });
    dependencies.powerMonitor.on("unlock-screen", () => {
      this.#isScreenLocked = false;
      this.#sendIfChanged();
    });
    dependencies.powerMonitor.on("suspend", () => {
      this.#isAsleep = true;
      this.#sendIfChanged();
    });
    dependencies.powerMonitor.on("resume", () => {
      this.#isAsleep = false;
      this.#sendIfChanged();
    });
    dependencies.daemonLink.subscribe(() => {
      this.#followLink();
    });
  }

  /** A new link is sent the fact at once; a link gone stops the beat until the next one. */
  #followLink(): void {
    const client = this.#dependencies.daemonLink.client;
    if (client === this.#linkClient) {
      return;
    }
    this.#linkClient = client;
    if (client === undefined) {
      clearTimeout(this.#nextBeat);
      this.#nextBeat = undefined;
      this.#lastSentAppVisible = undefined;
      return;
    }
    this.#send();
  }

  #sendIfChanged(): void {
    if (this.#isAppVisible() !== this.#lastSentAppVisible) {
      this.#send();
    }
  }

  /** Sends the fact now, when a link is up, and sets the next beat 15 seconds on. */
  #send(): void {
    const client = this.#dependencies.daemonLink.client;
    if (client === undefined) {
      return;
    }
    clearTimeout(this.#nextBeat);
    this.#nextBeat = setTimeout(() => {
      this.#send();
    }, PRESENCE_HEARTBEAT_INTERVAL_MS);
    const request: PresenceHeartbeatSendRequest = {
      deviceType: DESKTOP_DEVICE_TYPE,
      appVisible: this.#isAppVisible(),
    };
    this.#lastSentAppVisible = request.appVisible;
    client
      .call(PRESENCE_METHOD_DESCRIPTORS["presence.heartbeat.send"], request)
      .catch((error: unknown) => {
        this.#dependencies.logWarning(
          `The background service did not take this device's presence: ${describeFailure(error)}`,
        );
      });
  }

  #isAppVisible(): boolean {
    return !this.#isScreenLocked && !this.#isAsleep && this.#dependencies.isAnyWindowFocused();
  }
}

/** How long the service may go without hearing this device's presence, in ms. */
const PRESENCE_HEARTBEAT_INTERVAL_MS = 15_000;

/** The category this device reports itself under. */
const DESKTOP_DEVICE_TYPE = "desktop";
