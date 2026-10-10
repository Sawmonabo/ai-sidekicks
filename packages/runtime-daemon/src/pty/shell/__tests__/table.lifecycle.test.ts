// A session's shells from open to end over the in-process terminal host driving a fake PTY child:
// one open per idempotency key, shown in every follower's list; a working folder not in place
// refused; a login shell the system will not start giving way to the platform's default with a
// line that says why; a shell that did not start kept as such; a close, an exit and a session's
// deletion each ending the shell's panes and releasing the holds they carried, its nonce file
// gone; and a take or write whose pane ended while a change of holder was in flight refused.

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";

import { afterAll, describe, expect, it, vi } from "vitest";

import { SHELL_MARK_NONCE_FILE_ENVIRONMENT_NAME } from "@ai-sidekicks/contracts/machine-settings";
import { PTY_CONTROL_HELD_BY_OTHER_CODE, type PtyListUpdate } from "@ai-sidekicks/contracts/pty";
import { SESSION_WORKING_FOLDER_UNAVAILABLE_CODE } from "@ai-sidekicks/contracts/session/methods";

import { LAPTOP, PHONE, SESSION_ID } from "../../__tests__/control-lease.test-support.js";
import type { PtyHost } from "../../host/contract.js";
import type { SpawnRequest } from "../../host/protocol.js";
import {
  OTHER_SESSION_ID,
  holdHostCalls,
  notFound,
  openTable,
  paneOutlet,
  refusalOf,
  subscriptionNotFound,
  writeThrough,
} from "./table.test-support.js";

// A program named zsh, so each shell gets a nonce file; only the start check ever runs it.
const SCRATCH_FOLDER = mkdtempSync(path.join(tmpdir(), "shell-table-lifecycle-"));
const ZSH_STAND_IN = path.join(SCRATCH_FOLDER, "zsh");
writeFileSync(ZSH_STAND_IN, "#!/bin/sh\n", { mode: 0o755 });

afterAll(() => {
  rmSync(SCRATCH_FOLDER, { recursive: true, force: true });
});

// The nonce file a shell's start hands it.
function nonceFileOf(request: SpawnRequest): string {
  const nonceFile = request.env.find(
    ([name]) => name === SHELL_MARK_NONCE_FILE_ENVIRONMENT_NAME,
  )?.[1];
  if (nonceFile === undefined) {
    throw new Error("the shell was started with no nonce file");
  }
  return nonceFile;
}

// The nonce file each shell the host starts is handed, in start order; `refuseFirst` makes the
// host refuse the first start.
function recordNonceFiles(host: PtyHost, refuseFirst = false): string[] {
  const nonceFiles: string[] = [];
  const spawn = host.spawn.bind(host);
  vi.spyOn(host, "spawn").mockImplementation(async (request) => {
    nonceFiles.push(nonceFileOf(request));
    if (refuseFirst && nonceFiles.length === 1) {
      throw new Error("posix_spawnp failed.");
    }
    return spawn(request);
  });
  return nonceFiles;
}

// Every list a follower of the session is sent.
function followLists(table: ReturnType<typeof openTable>["table"]): PtyListUpdate[] {
  const lists: PtyListUpdate[] = [];
  table.followList(SESSION_ID, (update) => {
    lists.push(update);
  });
  return lists;
}

describe("ShellTable lifecycle", () => {
  it("opens one shell per key, shown in every follower's list, and starts none for a look", async () => {
    const { table, spawnCount } = openTable();
    const laptopLists = followLists(table);
    await vi.waitFor(() => {
      expect(laptopLists).toEqual([{ sessionId: SESSION_ID, terminals: [] }]);
    });

    const request = { sessionId: SESSION_ID, clientIdempotencyKey: randomUUID() };
    const [first, retry] = await Promise.all([table.open(request), table.open(request)]);
    expect(retry).toEqual(first);
    expect(await table.open(request)).toEqual(first);
    expect(spawnCount()).toBe(1);
    const entry = {
      terminalId: first.terminalId,
      title: "sh",
      status: { state: "running" },
      holder: null,
      leaseVersion: 0,
    };
    await vi.waitFor(() => {
      expect(laptopLists.at(-1)).toEqual({ sessionId: SESSION_ID, terminals: [entry] });
    });

    // Another connection's follow and a pane opened on the shell start nothing, and the
    // followers already there get nothing for the joining.
    const listsBefore = laptopLists.length;
    const phoneLists = followLists(table);
    await table.subscribeOutput(
      { sessionId: SESSION_ID, terminalId: first.terminalId },
      paneOutlet(PHONE, 2).outlet,
    );
    await vi.waitFor(() => {
      expect(phoneLists).toEqual([{ sessionId: SESSION_ID, terminals: [entry] }]);
    });
    await nextTurn();
    expect(laptopLists).toHaveLength(listsBefore);
    expect(spawnCount()).toBe(1);
  });

  it("refuses a shell while the working folder is not ready, or once it is gone", async () => {
    const goneFolder = path.join(SCRATCH_FOLDER, "gone");
    let workingFolder: string | null = null;
    const { table, spawnCount } = openTable({ readWorkingFolder: () => workingFolder });
    const open = () => table.open({ sessionId: SESSION_ID, clientIdempotencyKey: randomUUID() });

    const refusal = {
      code: SESSION_WORKING_FOLDER_UNAVAILABLE_CODE,
      detail: { sessionId: SESSION_ID },
    };
    expect(await refusalOf(open)).toMatchObject(refusal);
    workingFolder = goneFolder;
    expect(await refusalOf(open)).toMatchObject(refusal);
    expect(spawnCount()).toBe(0);
  });

  // Opens a pane on each unstartable login shell and checks that the platform's default shell
  // starts instead, with the line naming the shell and why it could not start.
  async function expectFallbackFor(
    unstartable: readonly (readonly [loginShell: string, reason: string])[],
  ): Promise<void> {
    const platformDefaultShell = process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
    for (const [loginShell, reason] of unstartable) {
      const { table, openShell, startedPrograms } = openTable({ loginShell });
      const { terminalId, child } = await openShell();
      const laptop = paneOutlet(LAPTOP, 1);
      await table.subscribeOutput({ sessionId: SESSION_ID, terminalId }, laptop.outlet);
      child.emitData("$ ");

      expect(startedPrograms).toEqual([platformDefaultShell]);
      const notice = `Could not start ${loginShell} (${reason}), so this tab runs ${platformDefaultShell}.\r\n`;
      expect(laptop.frames.flatMap((frame) => frame.changes)).toEqual([
        expect.objectContaining({ kind: "scrollback", data: notice }),
        expect.objectContaining({ kind: "output", data: "$ " }),
      ]);
    }
  }

  it.skipIf(process.platform === "win32")(
    "starts the platform's default shell, saying why first, where the login shell cannot start",
    async () => {
      const folder = path.join(SCRATCH_FOLDER, "unstartable");
      mkdirSync(folder, { recursive: true });
      const missingInterpreter = path.join(folder, "missing-interpreter");
      writeFileSync(missingInterpreter, `#!${path.join(folder, "no-such-interpreter")}\n`);
      chmodSync(missingInterpreter, 0o755);

      await expectFallbackFor([
        [path.join(folder, "no-such-shell"), "no such file"],
        [folder, "not allowed to run"],
        [missingInterpreter, "the program it names to run it is missing"],
      ]);
    },
  );

  // On Linux, Node's bundled libuv starts a file the kernel refuses through /bin/sh instead.
  it.skipIf(process.platform === "win32" || process.platform === "linux")(
    "starts the platform's default shell where the login shell is no program for this computer",
    async () => {
      const folder = path.join(SCRATCH_FOLDER, "unrunnable");
      mkdirSync(folder, { recursive: true });
      const notAProgram = path.join(folder, "not-a-program");
      writeFileSync(notAProgram, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]));
      chmodSync(notAProgram, 0o755);

      await expectFallbackFor([[notAProgram, "not a program this computer can run"]]);
    },
  );

  it("keeps a shell that did not start, in the system's words, its nonce file gone", async () => {
    const { table, host } = openTable({ loginShell: ZSH_STAND_IN });
    const nonceFiles = recordNonceFiles(host, true);
    const lists = followLists(table);

    const { terminalId } = await table.open({
      sessionId: SESSION_ID,
      clientIdempotencyKey: randomUUID(),
    });
    const status = { state: "did_not_start", cause: "posix_spawnp failed." };
    await vi.waitFor(() => {
      expect(lists.at(-1)?.terminals).toEqual([expect.objectContaining({ terminalId, status })]);
    });
    const laptop = paneOutlet(LAPTOP, 1);
    await table.subscribeOutput({ sessionId: SESSION_ID, terminalId }, laptop.outlet);
    expect(laptop.frames.flatMap((frame) => frame.changes)).toEqual([
      expect.objectContaining({ kind: "scrollback", data: "" }),
    ]);
    expect(laptop.isCompleted()).toBe(true);
    await vi.waitFor(() => {
      expect(nonceFiles.map((nonceFile) => existsSync(path.dirname(nonceFile)))).toEqual([false]);
    });
  });

  it("closes a shell: its holds released and appended first, its panes ended, its PTY gone", async () => {
    const { table, host, changes, openShell, holdNextControlChange } = openTable({
      loginShell: ZSH_STAND_IN,
    });
    const nonceFiles = recordNonceFiles(host);
    const { terminalId, child } = await openShell();
    const shell = { sessionId: SESSION_ID, terminalId };
    const lists = followLists(table);
    const laptop = paneOutlet(LAPTOP, 1);
    await table.subscribeOutput(shell, laptop.outlet);
    await table
      .leaseForOutputSubscription(SESSION_ID, terminalId, laptop.caller)
      .take(laptop.caller, false);
    const phone = paneOutlet(PHONE, 2);
    await table.subscribeOutput(shell, phone.outlet);

    expect(await refusalOf(() => table.close(shell, PHONE))).toMatchObject({
      code: PTY_CONTROL_HELD_BY_OTHER_CODE,
    });
    const letReleaseLand = holdNextControlChange();
    let isClosed = false;
    const closing = table.close({ ...shell, force: true }, PHONE).then(() => {
      isClosed = true;
    });
    await nextTurn();
    // The close answers only once the release is appended.
    expect(isClosed).toBe(false);
    expect(laptop.isCompleted() && phone.isCompleted()).toBe(true);
    letReleaseLand();
    await closing;

    expect(changes.at(-1)).toEqual({
      ...shell,
      holderDeviceId: null,
      previousHolderDeviceId: LAPTOP,
      reason: "auto_released_pane_closed",
      leaseVersion: 2,
    });
    expect(child.child.kill).toHaveBeenCalledTimes(1);
    expect(laptop.frames.flatMap((frame) => frame.changes).map((change) => change.kind)).toEqual([
      "scrollback",
    ]);
    await vi.waitFor(() => {
      expect(lists.at(-1)?.terminals).toEqual([]);
    });
    await vi.waitFor(() => {
      expect(existsSync(path.dirname(nonceFiles[0] ?? ""))).toBe(false);
    });
    expect(await refusalOf(() => table.close({ ...shell, force: true }, PHONE))).toMatchObject(
      notFound(terminalId),
    );
  });

  it("at an exit ends each pane with it, a behind one reseeded, and releases its holds", async () => {
    const { table, host, changes, openShell, fillQueue } = openTable({ loginShell: ZSH_STAND_IN });
    const nonceFiles = recordNonceFiles(host);
    const { terminalId, child } = await openShell();
    const shell = { sessionId: SESSION_ID, terminalId };
    const { writes, resizes } = holdHostCalls(host);
    const laptop = paneOutlet(LAPTOP, 1);
    await table.subscribeOutput(shell, laptop.outlet);
    await table
      .leaseForOutputSubscription(SESSION_ID, terminalId, laptop.caller)
      .take(laptop.caller, false);
    const phone = paneOutlet(PHONE, 2);
    await table.subscribeOutput(shell, phone.outlet);
    fillQueue(2);
    child.emitData("one\r\n");

    // A write in flight and one queued behind it, and a resize in flight and one queued.
    const typeKeys = (data: string): Promise<void> =>
      table.write(writeThrough(shell, laptop.caller.outputSubscriptionId, data), laptop.caller);
    const inFlight = typeKeys("a");
    await vi.waitFor(() => {
      expect(writes).toHaveLength(1);
    });
    const queued = typeKeys("b");
    const sized = [
      table.resize({ ...shell, columns: 100, rows: 30 }, laptop.connection),
      table.resize({ ...shell, columns: 120, rows: 32 }, laptop.connection),
    ];
    await vi.waitFor(() => {
      expect(resizes).toHaveLength(1);
    });
    const queuedRefusal = refusalOf(() => queued);

    child.triggerExit(3);
    const exited = { ...shell, kind: "exited", exitCode: 3, cursor: 5 };
    expect(laptop.frames.at(-1)).toEqual({ changes: [exited] });
    expect(laptop.isCompleted()).toBe(true);
    await vi.waitFor(() => {
      expect(phone.isCompleted()).toBe(true);
    });
    expect(phone.frames.at(-1)).toEqual({
      changes: [expect.objectContaining({ kind: "scrollback", data: "one\r\n" }), exited],
      dropped: true,
    });
    await vi.waitFor(() => {
      expect(changes.at(-1)).toMatchObject({ reason: "auto_released_pane_closed" });
    });

    // The write in flight lands; the one behind it is refused, and the newest size is kept for
    // the shell's next drawing without reaching the stopped terminal.
    writes[0]?.finish();
    await inFlight;
    expect(await queuedRefusal).toMatchObject({
      message: expect.stringMatching(/stopped running/),
    });
    resizes[0]?.finish();
    await Promise.all(sized);
    expect(writes).toHaveLength(1);
    expect(resizes).toHaveLength(1);
    const later = paneOutlet(LAPTOP, 1);
    await table.subscribeOutput(shell, later.outlet);
    expect(later.frames).toEqual([
      {
        changes: [
          expect.objectContaining({ kind: "scrollback", columns: 120, rows: 32, holder: null }),
          exited,
        ],
      },
    ]);
    await vi.waitFor(() => {
      expect(existsSync(path.dirname(nonceFiles[0] ?? ""))).toBe(false);
    });
  });

  it("refuses a take or write whose pane ended while a change of holder was in flight", async () => {
    const { table, host, changes, openShell, holdNextControlChange } = openTable();
    const { terminalId } = await openShell();
    const shell = { sessionId: SESSION_ID, terminalId };
    const write = vi.spyOn(host, "write");
    const laptop = paneOutlet(LAPTOP, 1);
    await table.subscribeOutput(shell, laptop.outlet);
    const phone = paneOutlet(PHONE, 2);
    await table.subscribeOutput(shell, phone.outlet);
    const lease = table.leaseForOutputSubscription(SESSION_ID, terminalId, laptop.caller);

    const letTakeLand = holdNextControlChange();
    const laptopTake = lease.take(laptop.caller, false);
    const phoneTake = refusalOf(() => lease.take(phone.caller, true));
    const phoneWrite = refusalOf(() =>
      table.write(writeThrough(shell, phone.caller.outputSubscriptionId, "x"), phone.caller),
    );
    await nextTurn();
    table.endOutputSubscription(phone.outlet.subscriptionId);
    letTakeLand();
    await laptopTake;

    const refusal = subscriptionNotFound(terminalId, phone.caller.outputSubscriptionId);
    expect(await phoneTake).toMatchObject(refusal);
    expect(await phoneWrite).toMatchObject(refusal);
    expect(await lease.readHolder()).toEqual({
      holder: { holderDeviceId: LAPTOP },
      leaseVersion: 1,
    });
    expect(changes.map((change) => change.reason)).toEqual(["taken"]);
    expect(write).not.toHaveBeenCalled();
  });

  it("ends every shell of a session being deleted, whoever holds it, and no other's", async () => {
    const { table, changes, openShell } = openTable();
    const first = await openShell();
    const second = await openShell();
    const other = await openShell(OTHER_SESSION_ID);
    const laptop = paneOutlet(LAPTOP, 1);
    const shell = { sessionId: SESSION_ID, terminalId: first.terminalId };
    await table.subscribeOutput(shell, laptop.outlet);
    await table
      .leaseForOutputSubscription(SESSION_ID, first.terminalId, laptop.caller)
      .take(laptop.caller, false);

    await table.closeSessionShells(SESSION_ID);

    expect(first.child.child.kill).toHaveBeenCalledTimes(1);
    expect(second.child.child.kill).toHaveBeenCalledTimes(1);
    expect(other.child.child.kill).not.toHaveBeenCalled();
    expect(laptop.isCompleted()).toBe(true);
    expect(changes.at(-1)).toMatchObject({ ...shell, reason: "auto_released_pane_closed" });
    expect(await refusalOf(() => table.close({ ...shell, force: true }, LAPTOP))).toMatchObject(
      notFound(first.terminalId),
    );
    expect(table.isReportingMarks(OTHER_SESSION_ID, other.terminalId)).toBe(false);
  });
});
