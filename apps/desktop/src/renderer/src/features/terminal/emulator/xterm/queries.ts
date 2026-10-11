// A pane never answers what a program asks its terminal: the daemon answers every question once,
// from its own copy of the shell's screen, so a shell shown in two panes, or replayed into one,
// gets one answer and never a second typed into its input. Each question the library would answer
// is taken here first and dropped; a color set rather than asked goes on to the library, and so do
// the sets in a color command that also asks.

import type { IFunctionIdentifier, Terminal } from "@xterm/xterm";

/** Drops every question a program asks the terminal before the library answers it. */
export function ignoreTerminalQueries(terminal: Terminal): void {
  const { parser } = terminal;
  for (const question of ANSWERED_CSI_QUESTIONS) {
    parser.registerCsiHandler(question, () => true);
  }
  parser.registerDcsHandler(SETTING_QUESTION, () => true);
  parser.registerOscHandler(PALETTE_COMMAND, (data) => dropPaletteQuestions(terminal, data));
  for (const command of DYNAMIC_COLOR_COMMANDS) {
    parser.registerOscHandler(command, (data) =>
      dropDynamicColorQuestions(terminal, command, data),
    );
  }
}

// A palette command lists index and color pairs; the pairs that set a color are written back
// without the questions, and the library takes them.
function dropPaletteQuestions(terminal: Terminal, data: string): boolean {
  const fields = data.split(";");
  if (!fields.includes(COLOR_QUESTION)) {
    return false;
  }
  const sets: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    if (fields[index + 1] !== COLOR_QUESTION) {
      sets.push(fields.slice(index, index + 2).join(";"));
    }
  }
  if (sets.length > 0) {
    terminal.write(`\x1b]${String(PALETTE_COMMAND)};${sets.join(";")}\x07`);
  }
  return true;
}

// A dynamic color command's fields name its own color and then each next one in turn, so
// `10;?;#000000` asks the foreground and sets the background; each set is written back on its own.
function dropDynamicColorQuestions(terminal: Terminal, command: number, data: string): boolean {
  const fields = data.split(";");
  if (!fields.includes(COLOR_QUESTION)) {
    return false;
  }
  const sets = fields
    .map((color, offset) => ({ color, command: command + offset }))
    .filter(
      ({ color, command: named }) =>
        color !== COLOR_QUESTION && DYNAMIC_COLOR_COMMANDS.includes(named),
    )
    .map(({ color, command: named }) => `\x1b]${String(named)};${color}\x07`);
  if (sets.length > 0) {
    terminal.write(sets.join(""));
  }
  return true;
}

// The questions `@xterm/xterm` 6.0.0 answers by itself: device attributes (primary and
// secondary), device status, a mode's state (ANSI and private) and a setting's state.
const ANSWERED_CSI_QUESTIONS: readonly IFunctionIdentifier[] = [
  { final: "c" },
  { prefix: ">", final: "c" },
  { final: "n" },
  { prefix: "?", final: "n" },
  { intermediates: "$", final: "p" },
  { prefix: "?", intermediates: "$", final: "p" },
];
const SETTING_QUESTION: IFunctionIdentifier = { intermediates: "$", final: "q" };
// A palette color (OSC 4) and the foreground, background and cursor colors (OSC 10, 11, 12).
const PALETTE_COMMAND = 4;
const DYNAMIC_COLOR_COMMANDS: readonly number[] = [10, 11, 12];
const COLOR_QUESTION = "?";
