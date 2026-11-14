// The keys a shell's terminal may turn into a signal, which a client sends at once rather than
// behind the writes waiting for the daemon's answer, so Ctrl-C reaches a program that stopped
// reading. Both the pane's input queue and the client helper's hold read them.

/** Whether `data` holds an interrupt (Ctrl-C), quit (Ctrl-\) or suspend (Ctrl-Z) key. */
export function carriesSignalKey(data: string): boolean {
  return data.includes("\u0003") || data.includes("\u001c") || data.includes("\u001a");
}
