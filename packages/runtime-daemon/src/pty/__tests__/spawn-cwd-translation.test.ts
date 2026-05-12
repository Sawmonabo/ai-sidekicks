// Test W2 — Plan-024 Phase 3 (T-024-3-4) — verifies invariant I-024-5.
//
// What this asserts
// -----------------
//
// The Plan-001 CP-001-2 daemon-layer cwd translator
// (`packages/runtime-daemon/src/session/spawn-cwd-translator.ts`) routes
// a logical worktree-path `SpawnRequest.cwd` through the
// (stable parent dir, prefixed command) tuple BEFORE the request
// reaches `RustSidecarPtyHost.spawn`. The wire-shape `SpawnRequest`
// frame the supervisor writes to the sidecar's stdin therefore carries:
//
//   1. `cwd === <stable parent>` — the path the OS spawn-call sees and
//      could potentially hold a Windows directory lock on. The
//      stable-parent guarantee is what prevents the
//      `ERROR_SHARING_VIOLATION` failure mode (`microsoft/node-pty#647`)
//      when `git worktree remove <worktree-path>` runs concurrently
//      with the live PTY session.
//   2. The original worktree path migrated INTO the wrapping shell
//      script (`args[1]` for POSIX `sh -c "..."`; `args[4]` for
//      Windows `cmd.exe /d /s /v:off /c "..."`), so the user's
//      logical cwd is preserved at the application layer.
//
// This is the INTEGRATION assertion at the seam translator → host →
// wire envelope; it complements the pure-transform tests in
// `packages/runtime-daemon/src/session/__tests__/spawn-cwd-translator.test.ts`
// (and the `.windows.test.ts` sibling) which exercise the translator
// against an in-memory recording host. By driving through
// `RustSidecarPtyHost` and parsing the actual Content-Length-framed
// JSON written to the sidecar's stdin, we prove the wire-side payload
// honours I-024-5 — the property the sidecar (and the OS spawn syscall
// it ultimately makes) actually observes.
//
// Why this file lives next to `rust-sidecar-pty-host.test.ts`
// ----------------------------------------------------------
//
// Tests in this directory exercise the host's wire-side surface; the
// translator is the upstream daemon-layer component whose OUTPUT
// becomes the host's INPUT. T-024-3-4 verifies the integration of the
// two — appropriate scope for `pty/__tests__`.
//
// Refs: Plan-024 §Invariants I-024-5; Plan-024 §Implementation Phase
// Sequence Phase 3 (T-024-3-4); Plan-001 §Cross-Plan Obligations
// CP-001-2; ADR-019 §Decision item 1.

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
// Fake child + helpers — minimal duplicates of the patterns in
// `rust-sidecar-pty-host.test.ts`. We intentionally do NOT extract a
// shared helper module here: that test file has 345 in-line uses and
// the helpers are deliberately co-located with the suite they support
// (per the existing _fakes.ts pattern, shared helpers are named for
// the production type they fake — e.g. `NodePtyChild`. The helpers
// below are tied to the SidecarChildProcess shape and a future shared
// extraction is best done at that scope by a future test-only refactor).
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

  // Two-overload `on` mirrors the production `SidecarChildProcess.on`
  // surface — see `rust-sidecar-pty-host.test.ts` for the rationale on
  // why the union-signature object literal cannot be expressed without
  // overloads under `exactOptionalPropertyTypes`.
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

/**
 * Parse the stdin contents (a sequence of Content-Length frames) into
 * an array of envelopes. Mirrors the helper in `rust-sidecar-pty-host.
 * test.ts` — the wire format is the same surface we're asserting on.
 */
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
// W2 — POSIX cd-prefix wire-shape integration
// ----------------------------------------------------------------------------

describe("translateSpawnCwd × RustSidecarPtyHost (Test W2 / I-024-5) — POSIX cd-prefix", () => {
  it("the wire-frame written to the sidecar carries the stable parent in cwd; worktree path is recoverable from args[1] of the sh -c wrapping script", async () => {
    // Logical request — its cwd points at a worktree path that, if
    // forwarded to the spawn syscall directly, would let Windows hold
    // an OS-level lock on the worktree directory.
    const logical: SpawnRequest = makeLogicalSpec(POSIX_PATHS.worktree);

    // CP-001-2 daemon-layer translation. Consumer picks `cd-prefix` for
    // shell-session spawns per the dispatch table in
    // `spawn-cwd-translator.ts` module header. We force `wrappingShell:
    // "posix"` so this assertion is platform-stable (the suite runs on
    // every platform; the Windows-shell flavor is exercised in the
    // sibling `describe` block below).
    const translated: SpawnRequest = translateSpawnCwd({
      spec: logical,
      strategy: "cd-prefix",
      stableParent: POSIX_PATHS.stableParent,
      wrappingShell: "posix",
    });

    // Stand up a host whose `child_process.spawn` is a fake whose stdin
    // we can inspect after the supervisor has framed and written the
    // SpawnRequest envelope.
    const fake = makeFakeChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    // Drive the supervisor through one spawn cycle. The host writes
    // the framed SpawnRequest to stdin synchronously inside
    // `host.spawn`'s microtask chain; we yield once to let the
    // PassThrough `data` listener buffer the bytes, then ack the
    // SpawnResponse so the awaiting Promise resolves and the test
    // can assert on what landed on the wire.
    const spawnPromise = host.spawn(translated);
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnPromise;

    // Wire-shape assertion: parse the framed SpawnRequest the
    // supervisor wrote to the sidecar's stdin. The cwd carried on the
    // wire MUST be the stable parent — this is the property that
    // prevents `ERROR_SHARING_VIOLATION` because the OS spawn-call
    // cwd is the directory the OS could potentially lock.
    const envelopes: Envelope[] = parseFramesFromStdin(fake.readStdin());
    expect(envelopes).toHaveLength(1);
    const wireFrame: Envelope | undefined = envelopes[0];
    expect(wireFrame).toBeDefined();
    expect(wireFrame?.kind).toBe("spawn_request");

    // Narrow to SpawnRequest for the field assertions.
    if (wireFrame?.kind !== "spawn_request") {
      throw new Error(
        `wire frame should be spawn_request after narrowing; got ${wireFrame?.kind ?? "undefined"}`,
      );
    }
    expect(wireFrame.cwd).toBe(POSIX_PATHS.stableParent);

    // The wrapping script is `/bin/sh -c "<script>"`. The script lives
    // in args[1] and contains the worktree path — i.e., the user's
    // logical cwd is preserved at the application layer (the `cd`
    // ahead of `exec` lands the inner shell IN the worktree before
    // it replaces itself with the target command).
    expect(wireFrame.command).toBe("/bin/sh");
    expect(wireFrame.args[0]).toBe("-c");
    const script: string | undefined = wireFrame.args[1];
    expect(script).toBeDefined();
    // The cd-prefix shape per the translator's POSIX branch:
    //   `cd '<worktree>' && exec '<cmd>' '<arg>' '<arg>' ...`
    expect(script).toContain(`cd '${POSIX_PATHS.worktree}' && exec`);
    // The original command + args survive into the wrapping script.
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
    // Env tuples cross the wire byte-for-byte (cd-prefix routes the
    // worktree path through the command string, not env).
    expect(wire.env).toEqual(logical.env);
  });
});

// ----------------------------------------------------------------------------
// W2 — Windows-cmd cd-prefix wire-shape integration
// ----------------------------------------------------------------------------
//
// Runs on every platform (the translator's `windows-cmd` branch is a
// pure transform; we override `wrappingShell` explicitly). This block
// proves the wire-shape contract holds for the cmd.exe flavor that
// `RustSidecarPtyHost` will see in production on Windows once the
// `PtyHostSelector` default flips at Plan-024 Phase 5.

describe("translateSpawnCwd × RustSidecarPtyHost (Test W2 / I-024-5) — Windows cmd.exe cd-prefix", () => {
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

    // Same load-bearing property as the POSIX case — the cwd on the
    // wire is the stable parent, not the worktree.
    expect(wireFrame.cwd).toBe(WINDOWS_PATHS.stableParent);

    // cmd.exe wrapping shape:
    //   command = "cmd.exe"
    //   args    = ["/d", "/s", "/v:off", "/c", `cd /d "<worktree>" && "<cmd>" <args>`]
    expect(wireFrame.command).toBe("cmd.exe");
    expect(wireFrame.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
    const script: string | undefined = wireFrame.args[4];
    expect(script).toBeDefined();
    // Worktree path is preserved at the application layer via the
    // `cd /d "<path>"` prefix that the wrapping cmd.exe runs before
    // invoking the target command.
    expect(script).toContain(`cd /d "${WINDOWS_PATHS.worktree}"`);
    expect(script).toContain('"bash" "-l"');
  });
});
