// What the shell table tests build on: a table over a terminal host whose children are fakes,
// a connection's pane output subscription, the write frames a pane sends, and the refusals a
// request throws.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { onTestFinished, vi } from "vitest";

import {
  SubscriptionIdSchema,
  type SubscriptionId,
} from "@ai-sidekicks/contracts/jsonrpc/streaming";
import {
  PTY_NOT_FOUND_CODE,
  PTY_OUTPUT_SUBSCRIPTION_NOT_FOUND_CODE,
  PtyControlChangedPayloadSchema,
  PtyOutputFrameSchema,
  type PtyControlChangedPayload,
  type PtyOutputFrame,
  type PtyWriteRequest,
  type TerminalId,
} from "@ai-sidekicks/contracts/pty";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionShape } from "@ai-sidekicks/contracts/session/methods";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { makeFakeChild, makeOrphanGuardDouble } from "../../__fixtures__/child-doubles.js";
import { MACHINE, SESSION_ID } from "../../__tests__/control-lease.test-support.js";
import type { ShellConnection, ShellLeaseCaller } from "../../control-lease.js";
import type { PtyHost } from "../../host/contract.js";
import { NodePtyHost } from "../../host/node-pty.js";
import { PtySessionEvents } from "../../host/session-events.js";
import type { ShellOutputOutlet } from "../output/stream.js";
import { ShellTable } from "../table.js";
import { DARWIN_TERMINAL_OPERATING_SYSTEM } from "../../operating-system/darwin.js";
import { selectTerminalOperatingSystem } from "../../operating-system/selector.js";

/** A second project session, whose shells another session's requests must never reach. */
/** What every table under test names its terminals' version. */
export const TERMINAL_VERSION = "sidekicks test";

export const OTHER_SESSION_ID: SessionId = SessionIdSchema.parse(
  "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d1f",
);
/** A chat session, which has no shell. */
export const CHAT_SESSION_ID: SessionId = SessionIdSchema.parse(
  "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d2a",
);

const SESSION_SHAPES: ReadonlyMap<SessionId, SessionShape> = new Map([
  [SESSION_ID, "project"],
  [OTHER_SESSION_ID, "project"],
  [CHAT_SESSION_ID, "chat"],
]);

/** What a case may set on the table it opens. */
interface TableOptions {
  /** The account's login shell; `/bin/sh` when unset. */
  readonly loginShell?: string;
  /** The terminal host; one whose children are fakes when unset. */
  readonly host?: PtyHost;
  /** The environment every shell starts from. */
  readonly baseEnvironment?: readonly (readonly [string, string])[];
  /** Every project session's working folder, read at each open; the system's temporary folder. */
  readonly readWorkingFolder?: () => string | null;
}

/** A fake PTY child the table's host started. */
type FakeChild = ReturnType<typeof makeFakeChild>;

/** A table under test and what a case reads and drives around it. */
interface TableUnderTest {
  readonly table: ShellTable;
  readonly host: PtyHost;
  /** Every lease change appended, parsed against the wire schema. */
  readonly changes: PtyControlChangedPayload[];
  readonly serviceLog: string[];
  /** Opens a shell in the session and answers it with the fake child behind it. */
  readonly openShell: (
    sessionId?: SessionId,
  ) => Promise<{ terminalId: TerminalId; child: FakeChild }>;
  /** The program each fake child was started for, behind the parent check. */
  readonly startedPrograms: string[];
  readonly spawnCount: () => number;
  /** Holds the next lease change's append back; the call it returns lets it land. */
  readonly holdNextControlChange: () => () => void;
  /** Makes a connection's outbound queue read full. */
  readonly fillQueue: (transportId: number) => void;
  /** Makes a connection's outbound queue read empty and calls whoever waited on its drain. */
  readonly drainQueue: (transportId: number) => void;
}

/**
 * The table over a terminal host whose children are fakes, unless a case brings its own host, with
 * every child and program it started, every lease change it appended, the connections whose
 * outbound queue a case has filled, and what it wrote to the service log. A case can hold the next
 * lease change's append back until it lets it land.
 */
// A run folder of the test's own, removed when the test ends.
function scratchRunFolder(): string {
  const folder = mkdtempSync(path.join(tmpdir(), "shell-run-folder-"));
  onTestFinished(() => {
    rmSync(folder, { recursive: true, force: true });
  });
  return folder;
}

export function openTable(options: TableOptions = {}): TableUnderTest {
  const children: FakeChild[] = [];
  const startedPrograms: string[] = [];
  const host =
    options.host ??
    new NodePtyHost(makeOrphanGuardDouble(), DARWIN_TERMINAL_OPERATING_SYSTEM, {
      platform: "darwin",
      ptySpawn: (_command, args) => {
        // Every program starts behind the parent check, `/bin/sh -c <check> <program> …`.
        const program = args[2];
        if (program === undefined) {
          throw new Error("the parent check names no program");
        }
        const fake = makeFakeChild();
        // A shell ends on its terminal's hangup, which is how a close ends it.
        vi.mocked(fake.child.kill).mockImplementation((signal) => {
          if (signal === "SIGHUP") {
            fake.triggerExit(0, 1);
          }
        });
        children.push(fake);
        startedPrograms.push(program);
        return fake.child;
      },
    });
  const changes: PtyControlChangedPayload[] = [];
  let heldAppend: Promise<void> | undefined;
  const fullTransports = new Set<number>();
  const drainListeners = new Map<number, Set<() => void>>();
  const serviceLog: string[] = [];
  const hostSessionEvents = new PtySessionEvents(host);
  const table = new ShellTable({
    host,
    followPtySession: (hostSessionId, listeners) =>
      hostSessionEvents.follow(hostSessionId, listeners),
    machineDeviceId: MACHINE,
    readWorkingFolder: (sessionId) => {
      const shape = SESSION_SHAPES.get(sessionId);
      if (shape === undefined) {
        throw new Error(`no session ${sessionId}`);
      }
      const workingFolder =
        options.readWorkingFolder === undefined ? tmpdir() : options.readWorkingFolder();
      return { shape, workingFolder };
    },
    appendControlChange: async (change) => {
      const held = heldAppend;
      heldAppend = undefined;
      await held;
      changes.push(PtyControlChangedPayloadSchema.parse(change));
    },
    readShellSettings: async () => ({
      isScreenReaderModeOn: false,
      environmentRows: { everyProject: [], project: [] },
    }),
    readLoginShell: () => options.loginShell ?? "/bin/sh",
    terminalVersion: TERMINAL_VERSION,
    baseEnvironment: options.baseEnvironment ?? [],
    environmentNameMatch: "case-sensitive",
    runFolderPath: scratchRunFolder(),
    operatingSystem: selectTerminalOperatingSystem(process.platform, process.env),
    outboundQueue: {
      isFull: (transportId) => fullTransports.has(transportId),
      onceDrained: (transportId, listener) => {
        const listeners = drainListeners.get(transportId) ?? new Set();
        listeners.add(listener);
        drainListeners.set(transportId, listeners);
        return () => listeners.delete(listener);
      },
    },
    writeServiceLog: (line) => {
      serviceLog.push(line);
    },
  });
  const openShell = async (
    sessionId: SessionId = SESSION_ID,
  ): Promise<{ terminalId: TerminalId; child: FakeChild }> => {
    const { terminalId } = await table.open({ sessionId, clientIdempotencyKey: randomUUID() });
    const child = children.at(-1);
    if (child === undefined) {
      throw new Error("the shell started no child");
    }
    return { terminalId, child };
  };
  return {
    table,
    host,
    changes,
    serviceLog,
    openShell,
    startedPrograms,
    spawnCount: () => children.length,
    holdNextControlChange: (): (() => void) => {
      const held = Promise.withResolvers<void>();
      heldAppend = held.promise;
      return () => {
        held.resolve();
      };
    },
    fillQueue: (transportId: number) => {
      fullTransports.add(transportId);
    },
    drainQueue: (transportId: number) => {
      fullTransports.delete(transportId);
      const listeners = [...(drainListeners.get(transportId) ?? [])];
      drainListeners.delete(transportId);
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

/** One pane's output subscription on one connection, and every frame it was sent. */
interface PaneOutlet {
  /** The pane as a take or a write names its caller. */
  readonly caller: ShellLeaseCaller;
  /** The pane's connection, as a resize names its caller. */
  readonly connection: ShellConnection;
  readonly outlet: ShellOutputOutlet;
  readonly frames: PtyOutputFrame[];
  readonly isCompleted: () => boolean;
}

/** Opens one pane's output subscription on one connection, recording every frame it is sent. */
export function paneOutlet(deviceId: DeviceId, transportId: number): PaneOutlet {
  const frames: PtyOutputFrame[] = [];
  const subscriptionId: SubscriptionId = SubscriptionIdSchema.parse(randomUUID());
  let isCompleted = false;
  return {
    caller: { deviceId, transportId, outputSubscriptionId: subscriptionId },
    connection: { deviceId, transportId },
    outlet: {
      subscriptionId,
      transportId,
      send: (frame: PtyOutputFrame) => {
        frames.push(PtyOutputFrameSchema.parse(frame));
      },
      complete: () => {
        isCompleted = true;
      },
    },
    frames,
    isCompleted: () => isCompleted,
  };
}

/** The refusal an act threw; fails when it was not refused. */
export async function refusalOf(act: () => unknown): Promise<unknown> {
  try {
    await act();
  } catch (error) {
    return error;
  }
  throw new Error("the act was not refused");
}

/** Typed `data` through a pane's output subscription. */
export function writeThrough(
  shell: { sessionId: SessionId; terminalId: TerminalId },
  outputSubscriptionId: SubscriptionId,
  data: string,
): PtyWriteRequest {
  return { ...shell, outputSubscriptionId, data, kind: "keys" };
}

/** One part of the paste `pasteId` through a pane's output subscription. */
export function pasteThrough(
  shell: { sessionId: SessionId; terminalId: TerminalId },
  outputSubscriptionId: SubscriptionId,
  part: { pasteId: string; data: string; isLastPart: boolean },
): PtyWriteRequest {
  return { ...shell, outputSubscriptionId, kind: "paste", ...part };
}

/** Every piece of text the frames carried, in order. */
export function textOf(frames: readonly PtyOutputFrame[]): string {
  return frames
    .flatMap((frame) => frame.changes)
    .map((change) => ("data" in change ? change.data : ""))
    .join("");
}

// One host call a case finishes when it chooses.
interface HeldHostCall<Request> {
  readonly request: Request;
  readonly finish: () => void;
}

/** The host's writes and resizes a case holds, in the order they came. */
interface HeldHostCalls {
  readonly writes: HeldHostCall<Buffer>[];
  readonly resizes: HeldHostCall<string>[];
  /** Lets every later write finish as it is made. */
  readonly letWritesThrough: () => void;
}

/**
 * Holds each of the host's writes and resizes until the case finishes it, in the order they came;
 * once `letWritesThrough` is called, a later write finishes as it is made.
 */
export function holdHostCalls(host: PtyHost): HeldHostCalls {
  const writes: HeldHostCall<Buffer>[] = [];
  const resizes: HeldHostCall<string>[] = [];
  let isWriteHeld = true;
  vi.spyOn(host, "write").mockImplementation((_hostSessionId, bytes) => {
    const written = Promise.withResolvers<void>();
    writes.push({ request: Buffer.from(bytes), finish: () => written.resolve() });
    if (!isWriteHeld) {
      written.resolve();
    }
    return written.promise;
  });
  vi.spyOn(host, "resize").mockImplementation((_hostSessionId, rows, columns) => {
    const resized = Promise.withResolvers<void>();
    resizes.push({
      request: `${String(columns)}x${String(rows)}`,
      finish: () => resized.resolve(),
    });
    return resized.promise;
  });
  return {
    writes,
    resizes,
    letWritesThrough: () => {
      isWriteHeld = false;
    },
  };
}

/** The `pty.not_found` refusal of a request naming `terminalId`. */
export function notFound(terminalId: TerminalId): object {
  return { code: PTY_NOT_FOUND_CODE, detail: { terminalId } };
}

/** The `pty.output_subscription_not_found` refusal of a take or write through that pane. */
export function subscriptionNotFound(
  terminalId: TerminalId,
  outputSubscriptionId: SubscriptionId,
): object {
  return {
    code: PTY_OUTPUT_SUBSCRIPTION_NOT_FOUND_CODE,
    detail: { terminalId, outputSubscriptionId },
  };
}
