// The two handshake outcomes a scenario can script, and the key they are answered
// under.
//
// WHY A MODULE AND NOT TWO INLINE OBJECTS. Two scenarios script this read — one
// agreement, one refusal — and the fixture port routes both. The routing key has to
// be the same string in all three places, and the workflows precedent
// (`WORKFLOWS_RUN_ENUMERATION_CALL`) names it once for exactly that reason. Here it
// is named once for two callers rather than one, so the constant cannot live in
// either scenario without the other importing its sibling, which no scenario module
// does. The two replies come with it, because the versions in them are one pair of
// builds meeting or failing to meet, and a second copy of that pair would let the
// agreeing window and the refusing window disagree about which console this is.
//
// KEYED ON THE OPERATION AND NOT ON `daemon.hello`. The row declares no expected wire
// method — a window must never re-issue the handshake, which the daemon latches per
// connection and refuses the second time — so the reply wears the operation id under
// the `growth:` prefix no daemon method can carry. `wire-truth/reply-walk.ts` admits
// exactly that form for a growth row with no registered name.

import type { ConsoleScenario } from "../scenario-runtime/index.js";

/** The routing key both scripted handshake outcomes are answered under. */
export const DAEMON_NEGOTIATION_READ_CALL = "growth:daemonNegotiationRead";

/** The protocol this console proposes in both scripted outcomes. */
const CONSOLE_PROTOCOL_VERSION = "2026-05-01";

/** A protocol the runtime speaks in the refusing outcome and this console does not. */
const RUNTIME_ONLY_PROTOCOL_VERSION = "2026-09-01";

/**
 * The two builds meeting.
 *
 * No `daemonSupportedProtocols`: the daemon's agreeing ack carries the verdict and
 * the negotiated version and nothing else, and a fixture that answered with a set
 * would be teaching every surface a member the live reply never sends.
 */
export const AGREED_NEGOTIATION_REPLY: ConsoleScenario["replies"][number] = {
  call: DAEMON_NEGOTIATION_READ_CALL,
  result: {
    compatible: true,
    consoleProtocolVersion: CONSOLE_PROTOCOL_VERSION,
    daemonProtocolVersion: CONSOLE_PROTOCOL_VERSION,
  },
};

/**
 * The two builds failing to meet, below the runtime's floor.
 *
 * `version.floor_exceeded` rather than either sibling reason, because it is the one
 * a person actually hits: a console ages past a runtime far more often than a runtime
 * ages past a console, and `protocol.handshake_already_completed` is a connection
 * fault rather than a version one. This arm carries the supported set, which is what
 * the two out-of-range refusals differ from the third by.
 */
export const REFUSED_NEGOTIATION_REPLY: ConsoleScenario["replies"][number] = {
  call: DAEMON_NEGOTIATION_READ_CALL,
  result: {
    compatible: false,
    reason: "version.floor_exceeded",
    consoleProtocolVersion: CONSOLE_PROTOCOL_VERSION,
    daemonProtocolVersion: RUNTIME_ONLY_PROTOCOL_VERSION,
    daemonSupportedProtocols: [RUNTIME_ONLY_PROTOCOL_VERSION],
  },
};
