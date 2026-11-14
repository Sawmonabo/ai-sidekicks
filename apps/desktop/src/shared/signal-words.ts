// How a process's end reads on screen, in the renderer and in main alike: a signal in words, so its
// name stays in the logs, a provider process's exit code, signal or silence after the provider's
// name, and any process's end as a line of its own. Any signal the system has can arrive; one no
// entry words reads as a system signal.

/**
 * How a process ended: exactly one of its exit code, the signal that ended it and, for a provider
 * process under work it carried, the silence the daemon ended it for, that silence already a
 * figure in words (`2 minutes`).
 */
export type ProcessEnd =
  | { readonly kind: "exitCode"; readonly exitCode: number }
  | { readonly kind: "signal"; readonly signal: string }
  | { readonly kind: "silence"; readonly silentFor: string };

/**
 * A signal's words in lower case, as they follow a middle dot, by its name as the system spells it
 * (`SIGKILL` reads `killed by the system`).
 */
export function signalWords(signal: string): string {
  return SIGNAL_WORDS.get(signal) ?? "stopped by a system signal";
}

/**
 * A provider process's end in words: what became of the provider by its name, then why
 * (`Claude Code ended unexpectedly`, `killed by the system`), parted by a middle dot when drawn.
 */
export function processEndWords(providerName: string, end: ProcessEnd): readonly [string, string] {
  const happened = end.kind === "silence" ? "stopped answering" : "ended unexpectedly";
  return [`${providerName} ${happened}`, processEndCause(end)];
}

/**
 * A process's end as a line of its own, in sentence case: `Exited with code 1`, `Killed by the
 * system`.
 */
export function processEndLine(end: ProcessEnd): string {
  const cause = processEndCause(end);
  return cause.charAt(0).toUpperCase() + cause.slice(1);
}

/** Why a process ended, in lower case: `exited with code 1`, `no reply for 2 minutes`. */
export function processEndCause(end: ProcessEnd): string {
  switch (end.kind) {
    case "exitCode":
      return `exited with code ${String(end.exitCode)}`;
    case "signal":
      return signalWords(end.signal);
    case "silence":
      return `no reply for ${end.silentFor}`;
  }
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
