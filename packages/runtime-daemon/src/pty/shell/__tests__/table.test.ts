// A session's shells' output and input over the in-process terminal host driving a fake PTY
// child: a shell drawn again gets its scrollback at its last size and never a byte twice, a
// watcher that fell behind catches up from the scrollback, the scrollback window keeps its newest
// whole lines, a window too large for one message goes on in continuation frames, a character
// split across reads arrives whole with every cursor counting only the bytes sent, input reaches
// the shell in order and whole, a paste sent in parts marked once around them all and closed at a
// change of holder, and a request never reaches another session's shell or binds another
// connection's pane. Over a real zsh, the shell's nonce and its marks reach neither the
// scrollback nor any output frame.

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import { jsonUtf8ByteLength } from "@ai-sidekicks/contracts/jsonrpc/byte-length";
import { JSONRPC_VERSION, MAX_MESSAGE_BYTES } from "@ai-sidekicks/contracts/jsonrpc/message";
import { SUBSCRIPTION_NOTIFY_METHOD } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import { SHELL_MARK_NONCE_FILE_ENVIRONMENT_NAME } from "@ai-sidekicks/contracts/machine-settings";
import {
  PTY_CHAT_UNSUPPORTED_CODE,
  TerminalIdSchema,
  type PtyOutputChange,
  type PtyOutputFrame,
  type TerminalControlHolder,
  type TerminalId,
} from "@ai-sidekicks/contracts/pty";

import { findInstalledShell } from "../../__fixtures__/installed-shell.js";
import { makeOrphanGuardDouble } from "../../__fixtures__/child-doubles.js";
import { LAPTOP, PHONE, SESSION_ID } from "../../__tests__/control-lease.test-support.js";
import { NodePtyHost } from "../../host/node-pty.js";
import { SHELL_WRITE_BOUND_BYTES } from "../queue/write.js";
import { SCROLLBACK_WINDOW_BYTES } from "../scrollback.js";
import {
  CHAT_SESSION_ID,
  OTHER_SESSION_ID,
  notFound,
  openTable,
  paneOutlet,
  pasteThrough,
  holdHostCalls,
  refusalOf,
  subscriptionNotFound,
  textOf,
  writeThrough,
} from "./table.test-support.js";
import { selectTerminalOperatingSystem } from "../../operating-system/selector.js";

const UNKNOWN_TERMINAL_ID: TerminalId = TerminalIdSchema.parse("no-such-terminal");

// Where this machine's zsh is, for the case that starts a real one.
const ZSH_PATH = findInstalledShell("zsh");
const REAL_SHELL_TIMEOUT_MS = 15_000;

describe("ShellTable", () => {
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

  it("continues a window too large for one message, and sends a split character whole", async () => {
    const { table, openShell } = openTable();
    const { terminalId, child } = await openShell();
    const shell = { sessionId: SESSION_ID, terminalId };
    const messageByteLength = (subscriptionId: string, frame: PtyOutputFrame): number =>
      jsonUtf8ByteLength({
        jsonrpc: JSONRPC_VERSION,
        method: SUBSCRIPTION_NOTIFY_METHOD,
        params: { subscriptionId, value: frame },
      });

    // Control bytes take six bytes each once escaped, so this window passes the message cap; it
    // ends inside "é", whose first byte waits for the read that completes it.
    const line = `${"\x01".repeat(60)}é\n`;
    const window = Buffer.concat([
      Buffer.from(line.repeat(15_000)),
      Buffer.from("a"),
      Buffer.from("é").subarray(0, 1),
    ]);
    child.emitData(window);
    const laptop = paneOutlet(LAPTOP, 1);
    await table.subscribeOutput(shell, laptop.outlet);
    const accented = Buffer.from("é");
    child.emitData(Buffer.concat([accented.subarray(1), Buffer.from("b")]));
    // And a character split across two reads of live output.
    child.emitData(Buffer.concat([Buffer.from("c"), accented.subarray(0, 1)]));
    child.emitData(accented.subarray(1));

    const changes = laptop.frames.flatMap((frame) => frame.changes);
    expect(changes.map((change) => change.kind)).toEqual([
      "scrollback",
      ...Array.from({ length: changes.length - 4 }, () => "scrollback_continuation"),
      "output",
      "output",
      "output",
    ]);
    expect(changes.length).toBeGreaterThan(4);
    for (const frame of laptop.frames) {
      expect(frame.changes).toHaveLength(1);
      expect(messageByteLength(laptop.outlet.subscriptionId, frame)).toBeLessThanOrEqual(
        MAX_MESSAGE_BYTES,
      );
    }
    // Each piece is cut between characters, and each cursor counts the bytes sent up to it.
    let sent = 0;
    for (const change of changes) {
      if (!("data" in change)) {
        throw new Error("a frame carried no text");
      }
      expect(change.data).not.toContain("\uFFFD");
      sent += Buffer.byteLength(change.data);
      expect(change.cursor).toBe(sent);
    }
    expect(textOf(laptop.frames)).toBe(`${line.repeat(15_000)}aébcé`);
    expect(changes.slice(-3).map((change) => ("data" in change ? change.data : ""))).toEqual([
      "éb",
      "c",
      "é",
    ]);
  });

  it("writes input in order with one write in flight, sizes to the newest, and pastes in parts whole", async () => {
    const { table, host, openShell } = openTable();
    const { terminalId, child } = await openShell();
    const shell = { sessionId: SESSION_ID, terminalId };
    const { writes, resizes, letWritesThrough } = holdHostCalls(host);
    const laptop = paneOutlet(LAPTOP, 1);
    await table.subscribeOutput(shell, laptop.outlet);
    const typeKeys = (data: string): Promise<void> =>
      table.write(writeThrough(shell, laptop.caller.outputSubscriptionId, data), laptop.caller);

    // A write answers once its bytes are written, so a client pacing on the answers is paced.
    let isFirstAnswered = false;
    const typed = [
      typeKeys("a").then(() => {
        isFirstAnswered = true;
      }),
      typeKeys("b"),
      typeKeys("c"),
    ];
    await vi.waitFor(() => {
      expect(writes.map((write) => write.request.toString())).toEqual(["a"]);
    });
    await nextTurn();
    expect(writes).toHaveLength(1);
    expect(isFirstAnswered).toBe(false);
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
    letWritesThrough();
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

    // A shell holds one open paste, which belongs to the pane its newest part came through. A part
    // of another paste, from any pane, closes the open one with its end mark first; a paste its
    // pane leaves unfinished is closed with its end mark, after what it still held.
    const otherPane = paneOutlet(LAPTOP, 1);
    await table.subscribeOutput(shell, otherPane.outlet);
    const pastePart = (
      pane: typeof laptop,
      part: { pasteId: string; data: string; isLastPart: boolean },
    ): Promise<void> =>
      table.write(pasteThrough(shell, pane.caller.outputSubscriptionId, part), pane.caller);
    const moved = randomUUID();
    const displaced = randomUUID();
    await pastePart(laptop, { pasteId: moved, data: "m", isLastPart: false });
    await pastePart(otherPane, { pasteId: moved, data: "n", isLastPart: false });
    await pastePart(laptop, { pasteId: displaced, data: "d", isLastPart: false });
    await pastePart(laptop, { pasteId: randomUUID(), data: "z\x1b[2", isLastPart: false });
    const writtenBefore = writes.length;
    expect(writes.slice(-4).map((write) => write.request.toString())).toEqual([
      "\x1b[200~m",
      "n",
      "\x1b[201~\x1b[200~d",
      "\x1b[201~\x1b[200~z",
    ]);
    table.endOutputSubscription(laptop.outlet.subscriptionId);
    table.endOutputSubscription(otherPane.outlet.subscriptionId);
    const closings = (): string =>
      Buffer.concat(writes.slice(writtenBefore).map((write) => write.request)).toString();
    await vi.waitFor(() => {
      expect(closings()).toBe("\x1b[2\x1b[201~");
    });

    // A change of holder closes the open paste first, so the new holder's keys never land in it.
    const laptopAgain = paneOutlet(LAPTOP, 1);
    const phone = paneOutlet(PHONE, 2);
    await table.subscribeOutput(shell, laptopAgain.outlet);
    await table.subscribeOutput(shell, phone.outlet);
    await pastePart(laptopAgain, { pasteId: randomUUID(), data: "p", isLastPart: false });
    const writtenBeforeTake = writes.length;
    await table
      .leaseForOutputSubscription(SESSION_ID, terminalId, phone.caller)
      .take(phone.caller, true);
    await table.write(writeThrough(shell, phone.caller.outputSubscriptionId, "k"), phone.caller);
    expect(
      Buffer.concat(writes.slice(writtenBeforeTake).map((write) => write.request)).toString(),
    ).toBe("\x1b[201~k");
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

  it.skipIf(process.platform === "win32" || ZSH_PATH === undefined)(
    "keeps a real zsh's nonce and marks out of its scrollback and every output frame",
    async () => {
      if (ZSH_PATH === undefined) {
        throw new Error("this case runs only where zsh is installed");
      }
      const home = mkdtempSync(path.join(tmpdir(), "shell-table-"));
      writeFileSync(path.join(home, ".zshrc"), "PS1='$ '\n");
      const host = new NodePtyHost(
        makeOrphanGuardDouble(),
        selectTerminalOperatingSystem(process.platform, process.env),
      );
      // The nonce, read from the file the shell is handed before the shell reads and deletes it.
      const nonces: string[] = [];
      const spawn = host.spawn.bind(host);
      vi.spyOn(host, "spawn").mockImplementation((request) => {
        const nonceFile = request.env.find(
          ([name]) => name === SHELL_MARK_NONCE_FILE_ENVIRONMENT_NAME,
        )?.[1];
        if (nonceFile !== undefined) {
          nonces.push(readFileSync(nonceFile, "utf8").trim());
        }
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
        const nonce = nonces[0];
        if (nonce === undefined) {
          throw new Error("zsh was started with no nonce");
        }
        const laptop = paneOutlet(LAPTOP, 1);
        await table.subscribeOutput(shell, laptop.outlet);
        await vi.waitFor(
          () => {
            // On a timeout the pane's output says what zsh showed instead of a prompt.
            expect(
              table.isReportingMarks(SESSION_ID, terminalId),
              JSON.stringify(laptop.frames.flatMap((frame) => frame.changes)),
            ).toBe(true);
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
