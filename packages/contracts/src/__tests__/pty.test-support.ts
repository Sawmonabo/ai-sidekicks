// Shell lease payloads several contracts tests parse.

/** The session the fixture shells belong to. */
export const SESSION_ID = "11111111-1111-4111-8111-111111111111";

/** The members every fixture lease change shares: the shell and its first raised version. */
export const SHELL_CHANGE: Readonly<Record<string, unknown>> = {
  sessionId: SESSION_ID,
  terminalId: "term-1",
  leaseVersion: 1,
};

/** A valid `pty.control_changed` payload: one device takes the shell from another. */
export const PTY_CONTROL_TAKEN_PAYLOAD: Readonly<Record<string, unknown>> = {
  ...SHELL_CHANGE,
  holderDeviceId: "desktop",
  previousHolderDeviceId: "laptop",
  reason: "taken",
};
