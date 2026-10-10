// The system's primary selection, the text a middle-click pastes in another window, which a
// selection settled in the conversation, by a drag or the keys, puts its text on where the system
// keeps one. Each system's form is a module of its own.

/** What this operating system does with the text of a selection settled in the conversation. */
export interface PrimarySelection {
  /**
   * Puts a settled selection's text, read only where the system keeps a primary selection, on it.
   * Rejects when main refuses the write.
   */
  takeSettledSelection(readText: () => string | undefined): Promise<void>;
}
