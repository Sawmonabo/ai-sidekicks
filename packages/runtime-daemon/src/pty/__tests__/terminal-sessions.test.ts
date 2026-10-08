// A session's shells over the in-process terminal host driving a fake PTY child: a shell drawn
// again gets its scrollback at its last size and never a byte twice, a watcher that fell behind
// catches up from the scrollback, the scrollback window keeps its newest whole lines, input
// reaches the shell in order and whole, a paste sent in parts marked once around them all, a
// request never reaches another session's shell or binds another connection's pane, and a login
// shell that cannot start gives way to the platform's default with a line that says so. Over a
// real zsh, the shell's nonce and its marks reach neither the scrollback nor any output frame.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import {
  SubscriptionIdSchema,
  type SubscriptionId,
} from "@ai-sidekicks/contracts/jsonrpc/streaming";
import { SHELL_MARK_NONCE_ENVIRONMENT_NAME } from "@ai-sidekicks/contracts/machine-settings";
import {
  PTY_CHAT_UNSUPPORTED_CODE,
  PTY_NOT_FOUND_CODE,
  PTY_OUTPUT_SUBSCRIPTION_NOT_FOUND_CODE,
  PtyControlChangedPayloadSchema,
  PtyOutputFrameSchema,
  TerminalIdSchema,
  type PtyControlChangedPayload,
  type PtyOutputChange,
  type PtyOutputFrame,
  type PtyWriteRequest,
  type TerminalControlHolder,
  type TerminalId,
} from "@ai-sidekicks/contracts/pty";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionShape } from "@ai-sidekicks/contracts/session/methods";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { makeFakeChild, makeOrphanGuardDouble } from "../__fixtures__/child-doubles.js";
import { findInstalledShell } from "../__fixtures__/installed-shell.js";
import type { PtyHost } from "../host/contract.js";
import { NodePtyHost } from "../host/node-pty.js";
import { PtySessionEvents } from "../host/session-events.js";
import { SCROLLBACK_WINDOW_BYTES } from "../shell/scrollback.js";
import { SHELL_WRITE_BOUND_BYTES } from "../shell/write-queue.js";
import { TerminalSessions } from "../terminal-sessions.js";
import { LAPTOP, MACHINE, PHONE, SESSION_ID } from "./control-lease.test-support.js";

const OTHER_SESSION_ID: SessionId = SessionIdSchema.parse("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d1f");
const CHAT_SESSION_ID: SessionId = SessionIdSchema.parse("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d2a");
const UNKNOWN_TERMINAL_ID: TerminalId = TerminalIdSchema.parse("no-such-terminal");

// Where this machine's zsh is, for the case that starts a real one.
const ZSH_PATH = findInstalledShell("zsh");
const REAL_SHELL_TIMEOUT_MS = 15_000;

const SESSION_SHAPES: ReadonlyMap<SessionId, SessionShape> = new Map([
  [SESSION_ID, "project"],
  [OTHER_SESSION_ID, "project"],
  [CHAT_SESSION_ID, "chat"],
]);

// One host call a case finishes when it chooses.
interface HeldHostCall<Request> {
  readonly request: Request;
  readonly finish: () => void;
}

// The table over a terminal host whose children are fakes, unless a case brings its own host,
// with every program it started, every lease change it appended, the connections whose outbound
// queue a case has filled, and what it wrote to the service log. The account's login shell is
// `loginShell`, and every shell starts from `baseEnvironment`.
function openTable(
  options: {
    loginShell?: string;
    host?: PtyHost;
    baseEnvironment?: readonly (readonly [string, string])[];
  } = {},
) {
  const children: ReturnType<typeof makeFakeChild>[] = [];
  const startedPrograms: string[] = [];
  const host =
    options.host ??
    new NodePtyHost(makeOrphanGuardDouble(), {
      platform: "darwin",
      ptySpawn: (_command, args) => {
        // Every program starts behind the parent check, `/bin/sh -c <check> <program> …`.
        const program = args[2];
        if (program === undefined) {
          throw new Error("the parent check names no program");
        }
        const fake = makeFakeChild();
        children.push(fake);
        startedPrograms.push(program);
        return fake.child;
      },
    });
  const changes: PtyControlChangedPayload[] = [];
  const fullTransports = new Set<number>();
  const drainListeners = new Map<number, Set<() => void>>();
  const serviceLog: string[] = [];
  const hostSessionEvents = new PtySessionEvents(host);
  const table = new TerminalSessions({
    host,
    followHostSession: (hostSessionId, listeners) =>
      hostSessionEvents.follow(hostSessionId, listeners),
    machineDeviceId: MACHINE,
    readWorkingFolder: (sessionId) => {
      const shape = SESSION_SHAPES.get(sessionId);
      if (shape === undefined) {
        throw new Error(`no session ${sessionId}`);
      }
      return { shape, workingFolder: tmpdir() };
    },
    appendControlChange: async (change) => {
      changes.push(PtyControlChangedPayloadSchema.parse(change));
    },
    readScreenReaderMode: async () => false,
    readLoginShell: () => options.loginShell ?? "/bin/sh",
    baseEnvironment: options.baseEnvironment ?? [],
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
  const openShell = async (sessionId: SessionId = SESSION_ID) => {
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

// One pane's output subscription on one connection, and every frame it was sent.
function paneOutlet(deviceId: DeviceId, transportId: number) {
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

// The refusal an act threw, or a failure when it was not refused.
async function refusalOf(act: () => unknown): Promise<unknown> {
  try {
    await act();
  } catch (error) {
    return error;
  }
  throw new Error("the act was not refused");
}

// Typed `data` through a pane's output subscription.
function writeThrough(
  shell: { sessionId: SessionId; terminalId: TerminalId },
  outputSubscriptionId: SubscriptionId,
  data: string,
): PtyWriteRequest {
  return { ...shell, outputSubscriptionId, data, kind: "keys" };
}

// One part of the paste `pasteId` through a pane's output subscription.
function pasteThrough(
  shell: { sessionId: SessionId; terminalId: TerminalId },
  outputSubscriptionId: SubscriptionId,
  part: { pasteId: string; data: string; isLastPart: boolean },
): PtyWriteRequest {
  return { ...shell, outputSubscriptionId, kind: "paste", ...part };
}

// Every piece of text the frames carried, in order.
function textOf(frames: readonly PtyOutputFrame[]): string {
  return frames
    .flatMap((frame) => frame.changes)
    .map((change) => ("data" in change ? change.data : ""))
    .join("");
}

function notFound(terminalId: TerminalId): object {
  return { code: PTY_NOT_FOUND_CODE, detail: { terminalId } };
}

function subscriptionNotFound(terminalId: TerminalId, outputSubscriptionId: SubscriptionId) {
  return {
    code: PTY_OUTPUT_SUBSCRIPTION_NOT_FOUND_CODE,
    detail: { terminalId, outputSubscriptionId },
  };
}

describe("TerminalSessions", () => {
  it("draws a shell again at its last size from its scrollback, sending no byte twice", async () => {
    const { table, openShell, fillQueue, drainQueue, serviceLog } = openTable();
    const { terminalId, child } = await openShell();
    const shell = { sessionId: SESSION_ID, terminalId };
    let written = "";
    const emit = (text: string): void => {
      written += text;
      child.emitData(text);
    };
    const scrollback = (
      holder: TerminalControlHolder | null,
      leaseVersion: number,
    ): PtyOutputChange => ({
      ...shell,
      kind: "scrollback",
      data: written,
      columns: 120,
      rows: 40,
      holder,
      leaseVersion,
      cursor: Buffer.byteLength(written),
    });
    const output = (text: string): PtyOutputChange => ({
      ...shell,
      kind: "output",
      data: text,
      cursor: Buffer.byteLength(written),
    });

    const laptop = paneOutlet(LAPTOP, 1);
    await table.subscribeOutput(shell, laptop.outlet);
    await table
      .leaseForOutputSubscription(SESSION_ID, terminalId, laptop.caller)
      .take(laptop.caller, false);
    await table.resize({ ...shell, columns: 120, rows: 40 }, laptop.connection);
    emit("one\r\n");

    const phone = paneOutlet(PHONE, 2);
    await table.subscribeOutput(shell, phone.outlet);
    const expected: PtyOutputFrame[] = [{ changes: [scrollback({ holderDeviceId: LAPTOP }, 1)] }];
    emit("two\r\n");
    expected.push({ changes: [output("two\r\n")] });

    // A full outbound queue: the phone stops receiving and catches up from the scrollback.
    fillQueue(2);
    emit("three\r\n");
    emit("four\r\n");
    expect(phone.frames).toEqual(expected);
    drainQueue(2);
    await nextTurn();
    expected.push({
      changes: [scrollback({ holderDeviceId: LAPTOP }, 1)],
      dropped: true,
    });
    emit("five\r\n");
    expected.push({ changes: [output("five\r\n")] });

    // A declared fall behind: the same catch up once the phone declares itself caught up.
    await table.declareFlowControl({ ...shell, paused: true }, 2);
    emit("six\r\n");
    await table.declareFlowControl({ ...shell, paused: false }, 2);
    await nextTurn();
    expected.push({
      changes: [scrollback({ holderDeviceId: LAPTOP }, 1)],
      dropped: true,
    });
    emit("seven\r\n");
    expected.push({ changes: [output("seven\r\n")] });
    expect(phone.frames).toEqual(expected);

    // The laptop, never behind, got every byte once, in order.
    expect(textOf(laptop.frames)).toBe(written);
    expect(laptop.frames.some((frame) => frame.dropped === true)).toBe(false);
    expect(serviceLog).toEqual([]);
  });

  it("keeps the newest whole lines of a mebibyte of scrollback, and a larger burst's tail", async () => {
    const { table, openShell } = openTable();
    const { terminalId, child } = await openShell();
    const shell = { sessionId: SESSION_ID, terminalId };
    const readScrollback = async (): Promise<string> => {
      const pane = paneOutlet(LAPTOP, 1);
      await table.subscribeOutput(shell, pane.outlet);
      const first = pane.frames[0]?.changes[0];
      if (first?.kind !== "scrollback") {
        throw new Error("the stream did not open with the scrollback");
      }
      return first.data;
    };

    // Twelve-byte lines, sent a thousand at a time, past the window's bound.
    const lines = Array.from({ length: 100_000 }, (_, index) => {
      return `line-${String(index).padStart(6, "0")}\n`;
    });
    for (let start = 0; start < lines.length; start += 1000) {
      child.emitData(lines.slice(start, start + 1000).join(""));
    }
    expect(await readScrollback()).toBe(
      lines.slice(-Math.floor(SCROLLBACK_WINDOW_BYTES / 12)).join(""),
    );

    // One burst larger than the window, of seventeen-byte lines.
    const burst = Array.from({ length: 100_000 }, (_, index) => {
      return `burst-line-${String(index).padStart(5, "0")}\n`;
    });
    child.emitData(burst.join(""));
    expect(await readScrollback()).toBe(
      burst.slice(-Math.floor(SCROLLBACK_WINDOW_BYTES / 17)).join(""),
    );
  });

  it("writes input in order with one write in flight, sizes to the newest, and pastes in parts whole", async () => {
    const { table, host, openShell } = openTable();
    const { terminalId, child } = await openShell();
    const shell = { sessionId: SESSION_ID, terminalId };
    const writes: HeldHostCall<Buffer>[] = [];
    let isWriteHeld = true;
    vi.spyOn(host, "write").mockImplementation((_hostSessionId, bytes) => {
      const written = Promise.withResolvers<void>();
      writes.push({ request: Buffer.from(bytes), finish: () => written.resolve() });
      if (!isWriteHeld) {
        written.resolve();
      }
      return written.promise;
    });
    const resizes: HeldHostCall<string>[] = [];
    vi.spyOn(host, "resize").mockImplementation((_hostSessionId, rows, columns) => {
      const resized = Promise.withResolvers<void>();
      resizes.push({
        request: `${String(columns)}x${String(rows)}`,
        finish: () => resized.resolve(),
      });
      return resized.promise;
    });
    const laptop = paneOutlet(LAPTOP, 1);
    await table.subscribeOutput(shell, laptop.outlet);
    const typeKeys = (data: string): Promise<void> =>
      table.write(writeThrough(shell, laptop.caller.outputSubscriptionId, data), laptop.caller);

    const typed = [typeKeys("a"), typeKeys("b"), typeKeys("c")];
    await vi.waitFor(() => {
      expect(writes.map((write) => write.request.toString())).toEqual(["a"]);
    });
    await nextTurn();
    expect(writes).toHaveLength(1);
    writes[0]?.finish();
    await vi.waitFor(() => {
      expect(writes.map((write) => write.request.toString())).toEqual(["a", "bc"]);
    });
    writes[1]?.finish();
    await Promise.all(typed);

    const sized = [
      table.resize({ ...shell, columns: 100, rows: 30 }, laptop.connection),
      table.resize({ ...shell, columns: 110, rows: 31 }, laptop.connection),
      table.resize({ ...shell, columns: 120, rows: 32 }, laptop.connection),
    ];
    await vi.waitFor(() => {
      expect(resizes.map((resize) => resize.request)).toEqual(["100x30"]);
    });
    resizes[0]?.finish();
    await vi.waitFor(() => {
      expect(resizes.map((resize) => resize.request)).toEqual(["100x30", "120x32"]);
    });
    resizes[1]?.finish();
    await Promise.all(sized);

    // The program asks for bracketed paste. A paste sent in parts is marked once around them all,
    // an end mark split across two parts and one that removing another would form are taken
    // out, and the queue splits what the parts add up to at the write bound.
    child.emitData("\x1b[?2004h");
    const pasteId = randomUUID();
    const paste = (data: string, isLastPart: boolean): Promise<void> =>
      table.write(
        pasteThrough(shell, laptop.caller.outputSubscriptionId, { pasteId, data, isLastPart }),
        laptop.caller,
      );
    const partText = "x".repeat(Math.floor(SHELL_WRITE_BOUND_BYTES / 2));
    const pasted = [
      paste("a", false),
      paste(partText, false),
      paste(`${partText}\x1b[20`, false),
      paste("\x1b[201~1~y", true),
    ];
    await vi.waitFor(() => {
      expect(writes.map((write) => write.request.toString())).toEqual(["a", "bc", "\x1b[200~a"]);
    });
    await nextTurn();
    isWriteHeld = false;
    writes[2]?.finish();
    await Promise.all(pasted);
    const whole = `\x1b[200~a${partText}${partText}y\x1b[201~`;
    const pieces = writes.slice(2).map((write) => write.request);
    expect(pieces.map((piece) => piece.byteLength)).toEqual([
      "\x1b[200~a".length,
      SHELL_WRITE_BOUND_BYTES,
      whole.length - "\x1b[200~a".length - SHELL_WRITE_BOUND_BYTES,
    ]);
    expect(Buffer.concat(pieces).toString()).toBe(whole);

    // A paste its pane leaves unfinished is closed with its end mark, after what it still held.
    const unfinished = randomUUID();
    await table.write(
      pasteThrough(shell, laptop.caller.outputSubscriptionId, {
        pasteId: unfinished,
        data: "z\x1b[2",
        isLastPart: false,
      }),
      laptop.caller,
    );
    table.endOutputSubscription(laptop.outlet.subscriptionId);
    await vi.waitFor(() => {
      expect(writes.slice(-2).map((write) => write.request.toString())).toEqual([
        "\x1b[200~z",
        "\x1b[2\x1b[201~",
      ]);
    });
  });

  it("never reaches another session's shell or binds another connection's pane", async () => {
    const { table, host, changes, openShell, spawnCount } = openTable();
    const { terminalId } = await openShell(SESSION_ID);
    const { terminalId: otherSessionShell, child: otherChild } = await openShell(OTHER_SESSION_ID);
    const { terminalId: secondShell } = await openShell(SESSION_ID);
    const pause = vi.spyOn(host, "pause");
    const close = vi.spyOn(host, "close");
    const laptop = paneOutlet(LAPTOP, 1);
    await table.subscribeOutput({ sessionId: SESSION_ID, terminalId }, laptop.outlet);
    // The laptop's connection is the other session's shell's only watcher.
    const otherWatcher = paneOutlet(LAPTOP, 1);
    await table.subscribeOutput(
      { sessionId: OTHER_SESSION_ID, terminalId: otherSessionShell },
      otherWatcher.outlet,
    );

    for (const named of [otherSessionShell, UNKNOWN_TERMINAL_ID]) {
      const shell = { sessionId: SESSION_ID, terminalId: named };
      const refusals = [
        await refusalOf(() => table.subscribeOutput(shell, paneOutlet(LAPTOP, 1).outlet)),
        await refusalOf(() =>
          table.write(
            writeThrough(shell, laptop.caller.outputSubscriptionId, "ls\r"),
            laptop.caller,
          ),
        ),
        await refusalOf(() => table.resize({ ...shell, columns: 90, rows: 20 }, laptop.connection)),
        await refusalOf(() => table.close({ ...shell, force: true }, LAPTOP)),
        await refusalOf(() => {
          table.reorder({ sessionId: SESSION_ID, terminalIds: [named] });
        }),
        await refusalOf(() =>
          table
            .leaseForOutputSubscription(SESSION_ID, named, laptop.caller)
            .take(laptop.caller, true),
        ),
      ];
      for (const refusal of refusals) {
        expect(refusal).toMatchObject(notFound(named));
      }
      // The flow-control signal naming it changes nothing and is not refused.
      await table.declareFlowControl({ ...shell, paused: true }, 1);
    }
    expect(pause).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(otherChild.child.write).not.toHaveBeenCalled();

    // A take or write through another connection's pane, or a pane on another shell.
    const phone = paneOutlet(PHONE, 2);
    await table.subscribeOutput({ sessionId: SESSION_ID, terminalId }, phone.outlet);
    const laptopOnSecondShell = paneOutlet(LAPTOP, 1);
    await table.subscribeOutput(
      { sessionId: SESSION_ID, terminalId: secondShell },
      laptopOnSecondShell.outlet,
    );
    for (const pane of [phone.outlet.subscriptionId, laptopOnSecondShell.outlet.subscriptionId]) {
      const caller = { ...laptop.caller, outputSubscriptionId: pane };
      const shell = { sessionId: SESSION_ID, terminalId };
      expect(
        await refusalOf(() => table.leaseForOutputSubscription(SESSION_ID, terminalId, caller)),
      ).toMatchObject(subscriptionNotFound(terminalId, pane));
      expect(
        await refusalOf(() => table.write(writeThrough(shell, pane, "x"), caller)),
      ).toMatchObject(subscriptionNotFound(terminalId, pane));
    }
    expect(
      await table.leaseForOutputSubscription(SESSION_ID, terminalId, laptop.caller).readHolder(),
    ).toEqual({ holder: null, leaseVersion: 0 });
    expect(changes).toEqual([]);

    // A chat session has no shell.
    const spawnsBefore = spawnCount();
    expect(
      await refusalOf(() =>
        table.open({ sessionId: CHAT_SESSION_ID, clientIdempotencyKey: randomUUID() }),
      ),
    ).toMatchObject({ code: PTY_CHAT_UNSUPPORTED_CODE, detail: { sessionId: CHAT_SESSION_ID } });
    expect(spawnCount()).toBe(spawnsBefore);
  });

  it.skipIf(process.platform === "win32")(
    "starts the platform's default shell, saying so first, where the login shell is missing",
    async () => {
      const missingShell = path.join(tmpdir(), `no-such-shell-${randomUUID()}`);
      const platformDefaultShell = process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
      const { table, openShell, startedPrograms } = openTable({ loginShell: missingShell });
      const { terminalId, child } = await openShell();
      const shell = { sessionId: SESSION_ID, terminalId };

      const laptop = paneOutlet(LAPTOP, 1);
      await table.subscribeOutput(shell, laptop.outlet);
      child.emitData("$ ");

      expect(startedPrograms).toEqual([platformDefaultShell]);
      const notice =
        `Could not start ${missingShell} (no such file), ` +
        `so this tab runs ${platformDefaultShell}.\r\n`;
      expect(laptop.frames.flatMap((frame) => frame.changes)).toEqual([
        expect.objectContaining({ kind: "scrollback", data: notice }),
        expect.objectContaining({ kind: "output", data: "$ " }),
      ]);
    },
  );

  it.skipIf(process.platform === "win32" || ZSH_PATH === undefined)(
    "keeps a real zsh's nonce and marks out of its scrollback and every output frame",
    async () => {
      if (ZSH_PATH === undefined) {
        throw new Error("this case runs only where zsh is installed");
      }
      const home = mkdtempSync(path.join(tmpdir(), "shell-table-"));
      writeFileSync(path.join(home, ".zshrc"), "PS1='$ '\n");
      const host = new NodePtyHost(makeOrphanGuardDouble());
      const spawnEnvironments: (readonly (readonly [string, string])[])[] = [];
      const spawn = host.spawn.bind(host);
      vi.spyOn(host, "spawn").mockImplementation((request) => {
        spawnEnvironments.push(request.env);
        return spawn(request);
      });
      try {
        const { table } = openTable({
          loginShell: ZSH_PATH,
          host,
          baseEnvironment: [
            ["HOME", home],
            ["PATH", process.env["PATH"] ?? "/usr/bin:/bin"],
            ["TERM", "xterm-256color"],
          ],
        });
        const { terminalId } = await table.open({
          sessionId: SESSION_ID,
          clientIdempotencyKey: randomUUID(),
        });
        const shell = { sessionId: SESSION_ID, terminalId };
        const nonce = spawnEnvironments[0]?.find(
          ([name]) => name === SHELL_MARK_NONCE_ENVIRONMENT_NAME,
        )?.[1];
        if (nonce === undefined) {
          throw new Error("zsh was started with no nonce");
        }
        const laptop = paneOutlet(LAPTOP, 1);
        await table.subscribeOutput(shell, laptop.outlet);
        await vi.waitFor(
          () => {
            expect(table.isReportingMarks(SESSION_ID, terminalId)).toBe(true);
          },
          { timeout: REAL_SHELL_TIMEOUT_MS, interval: 20 },
        );

        // A command's start and end marks and the next prompt's come and go while a pane
        // watches, and a pane opened after them reads them in no scrollback.
        await table.write(
          writeThrough(shell, laptop.outlet.subscriptionId, "echo $((6 * 7))\r"),
          laptop.caller,
        );
        await vi.waitFor(
          () => {
            expect(textOf(laptop.frames)).toMatch(/\r\n42\r\n/);
          },
          { timeout: REAL_SHELL_TIMEOUT_MS, interval: 20 },
        );
        const phone = paneOutlet(PHONE, 2);
        await table.subscribeOutput(shell, phone.outlet);

        expect(phone.frames[0]?.changes[0]).toMatchObject({ kind: "scrollback" });
        expect(textOf(phone.frames)).toMatch(/\r\n42\r\n/);
        for (const frames of [laptop.frames, phone.frames]) {
          expect(textOf(frames)).not.toContain(nonce);
          expect(textOf(frames)).not.toContain("\u001b]133;");
        }
      } finally {
        await host.shutdown({ perSessionTimeoutMs: 2_000, hostTimeoutMs: 2_000 });
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
