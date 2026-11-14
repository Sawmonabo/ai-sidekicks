// How a process a signal ended reads on screen, so a signal's name stays in the daemon's log. The
// daemon names any signal the system has; one no entry words reads as a system signal.

/**
 * A signal's words in lower case, as they follow a middle dot, by its name as the daemon sends it
 * (`SIGKILL` reads `killed by the system`).
 */
export function signalWords(signal: string): string {
  return SIGNAL_WORDS.get(signal) ?? "stopped by a system signal";
}

// The signals that end a process unasked, in words.
const SIGNAL_WORDS: ReadonlyMap<string, string> = new Map([
  ["SIGKILL", "killed by the system"],
  ["SIGTERM", "told to stop"],
  ["SIGINT", "interrupted"],
  ["SIGHUP", "its terminal closed"],
  ["SIGQUIT", "told to quit"],
  ["SIGABRT", "stopped on an internal error"],
  ["SIGSEGV", "crashed on a memory error"],
  ["SIGBUS", "crashed on a memory error"],
  ["SIGILL", "crashed on an invalid instruction"],
  ["SIGFPE", "crashed on an arithmetic error"],
  ["SIGPIPE", "its output was closed"],
  ["SIGXCPU", "ran past its processor time limit"],
  ["SIGXFSZ", "ran past its file size limit"],
]);
