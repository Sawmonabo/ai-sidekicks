// What one Codex service is handed and what it reports: the home it runs on, the dependencies it
// starts, connects and reports through, and the events it tells the driver about its
// conversations.

import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { SpawnEnvNameMatch, SpawnEnvPair } from "../../../spawn-env.js";
import type { ProviderCommandResolver } from "../../../spawned-version.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import type { CodexServerRequestResponder } from "../server-requests.js";
import type { CodexForgottenRequest } from "../transport/connection.js";
import type { CodexDiagnosticSink, CodexScheduleTimeout } from "../transport/diagnostics.js";
import type { CodexServiceSocketConnector } from "../transport/socket.js";
import type { CodexDaemonHooks } from "./command-line.js";
import type { CodexCommandRunner, CodexServiceLauncher } from "./process.js";
import type { CodexService } from "./supervisor.js";

/** The Codex home one service runs on. */
export interface CodexServiceHome {
  /** Absolute. */
  readonly codexHome: string;
  /** The account the home belongs to, or `undefined` for the person's own Codex folder. */
  readonly providerAccountId: string | undefined;
  /**
   * Whether the daemon starts and owns the service. The person's own folder is never started,
   * stopped or configured here: the daemon only connects to the service already on it.
   */
  readonly isManaged: boolean;
}

/** Why a service's conversations need resuming without anyone asking. */
export type CodexServiceRecoveryCause = "crash" | "reconnect";

/** What the service tells the driver about its conversations. */
export interface CodexServiceEvents {
  /** One frame for one session, a frame no thread names reaching every session. */
  onSessionFrame(
    service: CodexService,
    sessionId: SessionId,
    method: string,
    params: unknown,
  ): void;
  /** The process ended on its own; every running turn on it ended with it. */
  onProcessExited(service: CodexService, exit: ProcessExit): void;
  /** The service runs again, or its connection does; every conversation it held needs resuming. */
  onRecovered(service: CodexService, cause: CodexServiceRecoveryCause): void;
  /** The person's own service can no longer be reached; nothing here can start it again. */
  onServiceLost(service: CodexService, detail: string): void;
  /** The crash window filled, so the service stays down until the person restarts it. */
  onCrashLoop(service: CodexService, exit: ProcessExit): void;
  /** A connection that closed let go of asks it held for a session; their cards are withdrawn. */
  onHeldRequestsDropped(sessionId: SessionId, dropped: readonly CodexForgottenRequest[]): void;
  /** The responder for one session's asks, or `undefined` when none is bound. */
  responderFor(sessionId: SessionId): CodexServerRequestResponder | undefined;
}

/** What one service needs to start, connect and report. */
export interface CodexServiceDependencies {
  readonly home: CodexServiceHome;
  /** `unix://` for the home's own socket, or `unix://<path>` for a second service beside it. */
  readonly listenAddress: string;
  /** The socket the listen address makes. */
  readonly socketPath: string;
  /** Resolves the configured Codex command again at every start. */
  readonly providerCommand: ProviderCommandResolver;
  readonly providerBaseEnvironment: readonly SpawnEnvPair[];
  /** How this system compares environment variable names. */
  readonly environmentNameMatch: SpawnEnvNameMatch;
  readonly launchProcess: CodexServiceLauncher;
  readonly runCommand: CodexCommandRunner;
  readonly connectSocket: CodexServiceSocketConnector;
  /** The daemon's hooks, which only a service on a home the app manages runs. */
  readonly hooks: CodexDaemonHooks | undefined;
  readonly additionalConfigOverrides: readonly string[];
  readonly reportDiagnostic: CodexDiagnosticSink;
  readonly diagnostics: DriverDiagnosticsEmitter;
  readonly scheduleTimeout?: CodexScheduleTimeout | undefined;
  readonly now?: (() => number) | undefined;
  readonly startupTimeoutMs?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly events: CodexServiceEvents;
}
