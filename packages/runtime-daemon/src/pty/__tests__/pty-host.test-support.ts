// Shared fakes for the PTY host tests: a `node-pty` child for `NodePtyHost`, and a sidecar child
// process with Content-Length frame helpers for `RustSidecarPtyHost`.

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { vi } from "vitest";

import type { NodePtyChild } from "../node-pty-host.js";
import type { SidecarChildProcess, SidecarSpawnFn } from "../sidecar/sidecar-child-supervisor.js";
import type { Envelope, SpawnRequest } from "../host/protocol.js";
import type { RustSidecarPtyHost } from "../rust-sidecar-pty-host.js";

// Matches `NodePtyChild.onExit`'s event type. Under `exactOptionalPropertyTypes` the
// `| undefined` on `signal` also permits an explicit `{ signal: undefined }`.
type NodePtyExitEvent = { exitCode: number; signal?: number | undefined };

/**
 * Build a fake `NodePtyChild` that captures its `onExit` listener so a test can trigger an exit
 * with `triggerExit`, which throws if no listener is attached yet. `pid` defaults to 12345;
 * suites pass their own so the pid is distinctive in assertion failures.
 */
export function makeFakeChild(pid: number = 12345): {
  child: NodePtyChild;
  triggerExit: (exitCode: number, signal?: number) => void;
} {
  let exitListener: ((event: NodePtyExitEvent) => void) | null = null;
  const child: NodePtyChild = {
    pid,
    onData: () => ({ dispose: () => undefined }),
    onExit: (listener) => {
      exitListener = listener;
      return { dispose: () => undefined };
    },
    kill: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
  };
  return {
    child,
    triggerExit: (exitCode: number, signal?: number) => {
      if (exitListener === null) {
        throw new Error(
          "makeFakeChild.triggerExit: onExit listener not yet attached " +
            "(was the child spawned via NodePtyHost.spawn?)",
        );
      }
      const event: NodePtyExitEvent = signal === undefined ? { exitCode } : { exitCode, signal };
      exitListener(event);
    },
  };
}

/** A fake sidecar child: tests read its stdin, feed its stdout, and fire `exit` and `error`. */
export interface FakeSidecarChild {
  readonly child: SidecarChildProcess;
  /** Everything the host wrote to the sidecar's stdin. */
  readStdin(): Buffer;
  /** Whether the host has closed the sidecar's stdin. */
  stdinEnded(): boolean;
  /** Bytes from the "sidecar" to the host. */
  writeStdout(bytes: Buffer | string): void;
  triggerExit(code: number | null, signal: string | null): void;
  triggerError(err: Error): void;
}

/** Builds a fake sidecar child whose stdio streams are `PassThrough`s; `pid` defaults to 12345. */
export function makeFakeSidecarChild(pid: number = 12345): FakeSidecarChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events = new EventEmitter();

  const stdinChunks: Buffer[] = [];
  stdin.on("data", (chunk: Buffer) => {
    stdinChunks.push(chunk);
  });

  let stdinEndedFlag = false;
  // Wrapped so the host's `child.stdin.end()` call is observable.
  const originalEnd = stdin.end.bind(stdin);
  stdin.end = ((...args: unknown[]) => {
    stdinEndedFlag = true;
    return originalEnd(...(args as Parameters<typeof originalEnd>));
  }) as typeof stdin.end;

  // Two overloads, as on `SidecarChildProcess.on`: a union-signature object literal does not
  // typecheck under `exactOptionalPropertyTypes`.
  function on(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void,
  ): SidecarChildProcess;
  function on(event: "error", listener: (err: Error) => void): SidecarChildProcess;
  function on(
    event: "exit" | "error",
    listener: ((code: number | null, signal: string | null) => void) | ((err: Error) => void),
  ): SidecarChildProcess {
    events.on(event, listener as (...args: unknown[]) => void);
    return child;
  }

  const child: SidecarChildProcess = {
    pid,
    stdin,
    stdout,
    stderr,
    on,
    kill: vi.fn(() => true),
  };

  return {
    child,
    readStdin: () => Buffer.concat(stdinChunks),
    stdinEnded: () => stdinEndedFlag,
    writeStdout: (bytes) => {
      stdout.write(bytes);
    },
    triggerExit: (code, signal) => {
      events.emit("exit", code, signal);
    },
    triggerError: (err) => {
      events.emit("error", err);
    },
  };
}

/** A `SidecarSpawnFn` that always returns `fake`, typed as the subset the host uses. */
export function spawnReturning(fake: FakeSidecarChild): SidecarSpawnFn {
  return vi
    .fn<SidecarSpawnFn>()
    .mockImplementation(() => fake.child as unknown as ReturnType<SidecarSpawnFn>);
}

/** Encodes an envelope as a Content-Length frame, as the sidecar writes it to stdout. */
export function frameEnvelope(envelope: Envelope): Buffer {
  const payload: Buffer = Buffer.from(JSON.stringify(envelope), "utf8");
  const header: Buffer = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, payload]);
}

/** Decodes the Content-Length frames the host wrote to the sidecar's stdin. */
export function parseFramesFromStdin(stdinBuf: Buffer): Envelope[] {
  const envelopes: Envelope[] = [];
  let cursor = 0;
  while (cursor < stdinBuf.length) {
    const headerEnd: number = stdinBuf.indexOf("\r\n\r\n", cursor);
    if (headerEnd === -1) {
      break;
    }
    const headerText: string = stdinBuf.subarray(cursor, headerEnd).toString("utf8");
    const match: RegExpMatchArray | null = headerText.match(/Content-Length:\s*(\d+)/i);
    if (match === null) {
      break;
    }
    const length: number = Number.parseInt(match[1] ?? "0", 10);
    const bodyStart: number = headerEnd + 4;
    const body: Buffer = stdinBuf.subarray(bodyStart, bodyStart + length);
    envelopes.push(JSON.parse(body.toString("utf8")) as Envelope);
    cursor = bodyStart + length;
  }
  return envelopes;
}

/** Yields twice so `PassThrough` data dispatch and the promise chain settle. */
export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** A shell spawn request; the fake sidecar never runs it, so its fields matter only as a frame. */
export const SHELL_SPAWN_REQUEST: SpawnRequest = {
  kind: "spawn_request",
  command: "/bin/sh",
  args: [],
  env: [],
  cwd: "/",
  rows: 24,
  cols: 80,
};

/**
 * Spawns one session and answers its `SpawnResponse` with `sessionId` through the fake sidecar.
 * `child` is read after the spawn starts, since the host launches the sidecar on its first spawn.
 */
export async function spawnAnsweredSession(
  host: RustSidecarPtyHost,
  child: () => FakeSidecarChild,
  sessionId: string,
): Promise<void> {
  const spawning = host.spawn(SHELL_SPAWN_REQUEST);
  await flushMicrotasks();
  child().writeStdout(frameEnvelope({ kind: "spawn_response", session_id: sessionId }));
  await spawning;
}
