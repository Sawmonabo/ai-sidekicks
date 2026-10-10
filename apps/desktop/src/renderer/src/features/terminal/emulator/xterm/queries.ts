// A pane never answers what a program asks its terminal: the daemon answers every question once,
// from its own copy of the shell's screen, so a shell shown in two panes, or replayed into one,
// gets one answer and never a second typed into its input. Each question the library would answer
// is taken here first and dropped; a color set rather than asked goes on to the library.

import type { IFunctionIdentifier, Terminal } from "@xterm/xterm";

/** Drops every question a program asks the terminal before the library answers it. */
export function ignoreTerminalQueries(terminal: Terminal): void {
  const { parser } = terminal;
  for (const question of ANSWERED_CSI_QUESTIONS) {
    parser.registerCsiHandler(question, () => true);
  }
  parser.registerDcsHandler(SETTING_QUESTION, () => true);
  for (const command of COLOR_COMMANDS) {
    parser.registerOscHandler(command, (data) => data.split(";").includes(COLOR_QUESTION));
  }
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
const COLOR_COMMANDS = [4, 10, 11, 12] as const;
const COLOR_QUESTION = "?";
