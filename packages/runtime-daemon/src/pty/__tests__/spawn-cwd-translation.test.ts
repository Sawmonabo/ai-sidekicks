// Integration of `translateSpawnCwd` with `RustSidecarPtyHost`: the framed `SpawnRequest` written
// to the sidecar's stdin must carry the stable parent directory as `cwd`, with the worktree path
// moved into the wrapping shell script (`args[1]` of `sh -c` on POSIX, `args[4]` of
// `cmd.exe /d /s /v:off /c` on Windows). A worktree `cwd` reaching the OS spawn call would let
// Windows lock the directory and fail `git worktree remove` with `ERROR_SHARING_VIOLATION`
// (microsoft/node-pty#647).
//
// The translator's own transform is unit-tested in
// `session/__tests__/spawn-cwd-translator.test.ts` and its `.windows` sibling. This file
// checks the bytes on the wire.

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  RustSidecarPtyHost,
  type SidecarChildProcess,
  type SidecarSpawnFn,
} from "../rust-sidecar-pty-host.js";
import { translateSpawnCwd } from "../../session/spawn-cwd-translator.js";

import type { Envelope, SpawnRequest } from "@ai-sidekicks/contracts";

// ----------------------------------------------------------------------------
// Fake child and helpers. They repeat the ones in `rust-sidecar-pty-host.test.ts`, which keeps its
// helpers next to its suite.
// ----------------------------------------------------------------------------

interface FakeChild {
  readonly child: SidecarChildProcess;
  readStdin(): Buffer;
  writeStdout(bytes: Buffer | string): void;
}

function makeFakeChild(): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const ee = new EventEmitter();

  const stdinChunks: Buffer[] = [];
  stdin.on("data", (chunk: Buffer) => {
    stdinChunks.push(chunk);
  });

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
    ee.on(event, listener as (...args: unknown[]) => void);
    return child;
  }

  const child: SidecarChildProcess = {
    pid: 12345,
    stdin: stdin,
    stdout: stdout,
    stderr: stderr,
    on,
    kill: vi.fn(() => true),
  };

  return {
    child,
    readStdin: () => Buffer.concat(stdinChunks),
    writeStdout: (bytes) => {
      stdout.write(bytes);
    },
  };
}

function spawnReturning(fake: FakeChild): SidecarSpawnFn {
  return vi
    .fn<SidecarSpawnFn>()
    .mockImplementation(() => fake.child as unknown as ReturnType<SidecarSpawnFn>);
}

function frameEnvelope(envelope: Envelope): Buffer {
  const payload: Buffer = Buffer.from(JSON.stringify(envelope), "utf8");
  const header: Buffer = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, payload]);
}

/** Parses the stdin bytes (Content-Length frames) into envelopes. */
function parseFramesFromStdin(stdinBuf: Buffer): Envelope[] {
  const envelopes: Envelope[] = [];
  let cursor = 0;
  while (cursor < stdinBuf.length) {
    const headerEnd: number = stdinBuf.indexOf("\r\n\r\n", cursor);
    if (headerEnd === -1) {
      break;
    }
    const headerBytes: Buffer = stdinBuf.subarray(cursor, headerEnd);
    const headerText: string = headerBytes.toString("utf8");
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

interface PathFixture {
  readonly worktree: string;
  readonly stableParent: string;
}

const POSIX_PATHS: PathFixture = {
  worktree: "/Users/dev/worktrees/feature-x",
  stableParent: "/Users/dev",
};

const WINDOWS_PATHS: PathFixture = {
  worktree: "C:\\Users\\dev\\worktrees\\feature-x",
  stableParent: "C:\\Users\\dev",
};

function makeLogicalSpec(cwd: string): SpawnRequest {
  return {
    kind: "spawn_request",
    command: "bash",
    args: ["-l"],
    env: [
      ["PATH", "/usr/local/bin:/usr/bin:/bin"],
      ["HOME", "/Users/dev"],
    ],
    cwd,
    rows: 24,
    cols: 80,
  };
}

// ----------------------------------------------------------------------------
// POSIX cd-prefix wire shape
// ----------------------------------------------------------------------------

describe("translateSpawnCwd × RustSidecarPtyHost (Test W2 /) — POSIX cd-prefix", () => {
  it("the wire-frame written to the sidecar carries the stable parent in cwd; worktree path is recoverable from args[1] of the sh -c wrapping script", async () => {
    // A logical request whose cwd is the worktree path.
    const logical: SpawnRequest = makeLogicalSpec(POSIX_PATHS.worktree);

    // `wrappingShell: "posix"` is forced so the result does not depend on the host platform.
    const translated: SpawnRequest = translateSpawnCwd({
      spec: logical,
      strategy: "cd-prefix",
      stableParent: POSIX_PATHS.stableParent,
      wrappingShell: "posix",
    });

    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    // Yield once so stdin buffers the request, then ack it so `spawn` resolves.
    const spawnPromise = host.spawn(translated);
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnPromise;

    // The cwd on the wire must be the stable parent, the directory the OS could lock.
    const envelopes: Envelope[] = parseFramesFromStdin(fake.readStdin());
    expect(envelopes).toHaveLength(1);
    const wireFrame: Envelope | undefined = envelopes[0];
    expect(wireFrame).toBeDefined();
    expect(wireFrame?.kind).toBe("spawn_request");

    if (wireFrame?.kind !== "spawn_request") {
      throw new Error(
        `wire frame should be spawn_request after narrowing; got ${wireFrame?.kind ?? "undefined"}`,
      );
    }
    expect(wireFrame.cwd).toBe(POSIX_PATHS.stableParent);

    // The worktree survives in the `sh -c` script: `cd` lands in it before `exec` replaces the
    // shell with the target command.
    expect(wireFrame.command).toBe("/bin/sh");
    expect(wireFrame.args[0]).toBe("-c");
    const script: string | undefined = wireFrame.args[1];
    expect(script).toBeDefined();
    expect(script).toContain(`cd '${POSIX_PATHS.worktree}' && exec`);
    expect(script).toContain("'bash' '-l'");
  });

  it("passes the original env tuples through unchanged (cd-prefix does not touch env)", async () => {
    const logical: SpawnRequest = makeLogicalSpec(POSIX_PATHS.worktree);
    const translated: SpawnRequest = translateSpawnCwd({
      spec: logical,
      strategy: "cd-prefix",
      stableParent: POSIX_PATHS.stableParent,
      wrappingShell: "posix",
    });

    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const spawnP = host.spawn(translated);
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnP;

    const envelopes: Envelope[] = parseFramesFromStdin(fake.readStdin());
    const wire: Envelope | undefined = envelopes[0];
    if (wire?.kind !== "spawn_request") {
      throw new Error(`expected spawn_request on wire; got ${wire?.kind ?? "undefined"}`);
    }
    // cd-prefix moves the worktree path into the command, not env.
    expect(wire.env).toEqual(logical.env);
  });
});

// ----------------------------------------------------------------------------
// Windows cmd.exe cd-prefix wire shape
// ----------------------------------------------------------------------------
//
// Runs on every platform: the `windows-cmd` branch is a pure transform and `wrappingShell` is set
// explicitly.

describe("translateSpawnCwd × RustSidecarPtyHost (Test W2 /) — Windows cmd.exe cd-prefix", () => {
  it("the wire-frame carries the stable parent in cwd; worktree path is recoverable from args[4] of the cmd.exe /d /s /v:off /c wrapping script", async () => {
    const logical: SpawnRequest = makeLogicalSpec(WINDOWS_PATHS.worktree);

    const translated: SpawnRequest = translateSpawnCwd({
      spec: logical,
      strategy: "cd-prefix",
      stableParent: WINDOWS_PATHS.stableParent,
      wrappingShell: "windows-cmd",
    });

    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const spawnPromise = host.spawn(translated);
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnPromise;

    const envelopes: Envelope[] = parseFramesFromStdin(fake.readStdin());
    expect(envelopes).toHaveLength(1);
    const wireFrame: Envelope | undefined = envelopes[0];
    if (wireFrame?.kind !== "spawn_request") {
      throw new Error(
        `wire frame should be spawn_request after narrowing; got ${wireFrame?.kind ?? "undefined"}`,
      );
    }

    // As on POSIX, the wire cwd is the stable parent.
    expect(wireFrame.cwd).toBe(WINDOWS_PATHS.stableParent);

    expect(wireFrame.command).toBe("cmd.exe");
    expect(wireFrame.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
    const script: string | undefined = wireFrame.args[4];
    expect(script).toBeDefined();
    // The worktree survives in the `cd /d` prefix of the cmd.exe script.
    expect(script).toContain(`cd /d "${WINDOWS_PATHS.worktree}"`);
    expect(script).toContain('"bash" "-l"');
  });
});
