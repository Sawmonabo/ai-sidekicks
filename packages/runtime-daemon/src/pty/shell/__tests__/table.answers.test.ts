// A program's questions to its terminal, answered once by the daemon's copy of the shell's screen:
// one answer however many panes show the shell, and the colors and cell size from the console
// theme the desktop reported until the holding pane reports its own, which a change of holder
// forgets; an answer that comes while a marked paste is open follows its end mark.

import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { TerminalColors, TerminalId } from "@ai-sidekicks/contracts/pty";

import { LAPTOP, PHONE, SESSION_ID } from "../../__tests__/control-lease.test-support.js";
import {
  TERMINAL_VERSION,
  holdHostCalls,
  openTable,
  paneOutlet,
  pasteThrough,
  textOf,
} from "./table.test-support.js";

// The status report every terminal answers with `ESC [ 0 n`, asked after a question so a case
// knows every answer to it has arrived.
const STATUS_QUESTION = "\x1b[5n";
const STATUS_ANSWER = "\x1b[0n";

function colorsWithBackground(background: string): TerminalColors {
  return {
    foreground: "#d0d0d0",
    background,
    cursor: "#ffcc00",
    palette: Array.from(
      { length: 16 },
      (_, index) => `#0000${index.toString(16).padStart(2, "0")}`,
    ),
  };
}

// A table and the answers the host was given for one shell whose fake child asks its terminal.
interface AskedShell extends ReturnType<typeof openTable> {
  readonly terminalId: TerminalId;
  readonly child: Awaited<ReturnType<ReturnType<typeof openTable>["openShell"]>>["child"];
  /** Asks the question, then the status, and resolves to every answer before the status's. */
  readonly ask: (question: string) => Promise<string>;
  /** Everything the host has written to the shell so far. */
  readonly readWritten: () => string;
}

async function openAskedShell(): Promise<AskedShell> {
  const table = openTable();
  const { terminalId, child } = await table.openShell();
  const { writes, letWritesThrough } = holdHostCalls(table.host);
  letWritesThrough();
  let answered = 0;
  const readWritten = (): string => writes.map((write) => write.request.toString()).join("");
  const ask = async (question: string): Promise<string> => {
    child.emitData(question + STATUS_QUESTION);
    let text = "";
    await vi.waitFor(() => {
      text = readWritten();
      expect(text.indexOf(STATUS_ANSWER, answered)).toBeGreaterThanOrEqual(0);
    });
    const end = text.indexOf(STATUS_ANSWER, answered);
    const answers = text.slice(answered, end);
    answered = end + STATUS_ANSWER.length;
    return answers;
  };
  return { ...table, terminalId, child, ask, readWritten };
}

describe("ShellTable answers", () => {
  it("answers a question once however many panes show the shell", async () => {
    const { table, terminalId, ask } = await openAskedShell();
    const shell = { sessionId: SESSION_ID, terminalId };
    const laptop = paneOutlet(LAPTOP, 1);
    const phone = paneOutlet(PHONE, 2);
    await table.subscribeOutput(shell, laptop.outlet);
    await table.subscribeOutput(shell, phone.outlet);

    expect(await ask("abc\x1b[6n\x1b[>q")).toBe(`\x1b[1;4R\x1bP>|${TERMINAL_VERSION}\x1b\\`);
    // A second copy would land before the next question's answers.
    expect(await ask("")).toBe("");
    // Each pane still gets the question, which it drops rather than answers.
    expect(textOf(laptop.frames)).toContain("\x1b[6n");
    expect(textOf(phone.frames)).toContain("\x1b[6n");
  });

  it("answers colors and cell size from the console theme until the holding pane reports", async () => {
    const { table, terminalId, ask } = await openAskedShell();
    const shell = { sessionId: SESSION_ID, terminalId };
    const colorAndCellQuestions = "\x1b]11;?\x07\x1b]4;1;?\x1b\\\x1b[16t\x1b[14t";

    // Before any report a color or cell question goes unanswered, as a terminal without it leaves.
    expect(await ask(colorAndCellQuestions)).toBe("");

    await table.reportTerminalAppearance(
      { source: "console_theme", colors: colorsWithBackground("#101820") },
      { deviceId: LAPTOP, transportId: 1 },
    );
    expect(await ask(colorAndCellQuestions)).toBe(
      "\x1b]11;rgb:1010/1818/2020\x1b\\\x1b]4;1;rgb:0000/0000/0101\x1b\\",
    );

    // The holding pane's report outranks the console theme and brings the cell size.
    const laptop = paneOutlet(LAPTOP, 1);
    await table.subscribeOutput(shell, laptop.outlet);
    await table
      .leaseForOutputSubscription(SESSION_ID, terminalId, laptop.caller)
      .take(laptop.caller, false);
    await table.reportTerminalAppearance(
      {
        source: "holding_pane",
        ...shell,
        colors: colorsWithBackground("#fafafa"),
        cellSize: { width: 9, height: 18 },
      },
      laptop.connection,
    );
    expect(await ask(colorAndCellQuestions)).toBe(
      "\x1b]11;rgb:fafa/fafa/fafa\x1b\\\x1b]4;1;rgb:0000/0000/0101\x1b\\" +
        "\x1b[6;18;9t\x1b[4;432;720t",
    );

    // Another device taking the shell forgets the pane's report: the console theme answers again.
    const phone = paneOutlet(PHONE, 2);
    await table.subscribeOutput(shell, phone.outlet);
    await table
      .leaseForOutputSubscription(SESSION_ID, terminalId, phone.caller)
      .take(phone.caller, true);
    expect(await ask(colorAndCellQuestions)).toBe(
      "\x1b]11;rgb:1010/1818/2020\x1b\\\x1b]4;1;rgb:0000/0000/0101\x1b\\",
    );
  });

  it("holds an answer while a marked paste is open and writes it after the end mark", async () => {
    const { table, terminalId, child, readWritten } = await openAskedShell();
    const shell = { sessionId: SESSION_ID, terminalId };
    const laptop = paneOutlet(LAPTOP, 1);
    await table.subscribeOutput(shell, laptop.outlet);
    await table
      .leaseForOutputSubscription(SESSION_ID, terminalId, laptop.caller)
      .take(laptop.caller, false);
    const pasteId = randomUUID();
    const paste = (data: string, isLastPart: boolean): Promise<void> =>
      table.write(
        pasteThrough(shell, laptop.caller.outputSubscriptionId, { pasteId, data, isLastPart }),
        laptop.caller,
      );

    child.emitData("\x1b[?2004h");
    await paste("a", false);
    // A part waits for the output before it to be read, so the question is read before "b".
    child.emitData("\x1b[6n");
    await paste("b", false);
    await paste("c", true);

    expect(readWritten()).toBe("\x1b[200~abc\x1b[201~\x1b[1;1R");
  });
});
