// Every word the honest-chrome plane says, in one module.
//
// The chrome's job is to be believed, and a sentence written beside the component
// that renders it is a sentence nobody can audit against the others: the disconnect
// line, the read-only line, the version remedy, and the two security notices all
// have to agree about what is still true during an outage. Held here, the whole
// vocabulary reads as one page, and the count claims below are checkable.
//
// THREE RULES GOVERN EVERY STRING HERE.
//
// It says what is STALE rather than what is broken. A window whose runtime is
// unreachable is still showing real state that was really delivered — it is just no
// longer being added to — and copy that says "disconnected" without saying what that
// costs a person leaves them guessing whether what is on screen is fiction.
//
// And it never names a governance document, a task id, or a method the daemon
// registry owns as prose. The six method NAMES are wire strings and appear as wire
// figures; what appears in a sentence is what each one does in a person's words.
//
// AND NO SENTENCE HERE CARRIES A VALUE THE SHELL REPORTED. That was the third rule
// all along and this module was breaking it: the mismatch line pasted both protocol
// versions into proportional prose and the outage lines pasted the attempt counters
// in through `String()`, so four figures the shell had sent reached the screen with
// none of the provenance `Spec-023 §Console Design (Meridian)` rule 4 requires and
// none of them through the console's one formatter. Every such sentence is now a
// SENTENCE MODEL — words and figure slots — and {@link ShellSentenceText} is what
// turns one into elements. The words stay here where the whole vocabulary can be read
// as one page; the figures leave through `primitives/wire-figures.ts`, which is the
// only module allowed to format a wire value at all.

import {
  MUTATING_DAEMON_METHODS,
  type SessionDegradedCause,
  type MutatingDaemonMethod,
  type ShellConnection,
  type ShellNegotiation,
} from "../../store/index.js";

/**
 * One part of a sentence the honest chrome says.
 *
 * THREE KINDS, AND THE LAST TWO ARE THE EIGHT RULES' OWN TWO CLASSES. A byte-for-byte
 * string the shell sent — a protocol version — is a `figure` and renders verbatim; a
 * quantity it sent — an attempt out of a ladder — is a `count` and renders through
 * `Intl`. Neither is formatted here: this module states WHICH class a value is, and
 * `primitives/wire-figures.ts` stays the only module that turns one into text.
 *
 * A model rather than a string is what makes that reachable at all. A sentence
 * returned as text has exactly one way to carry a version — pasted into the prose —
 * and no element to hang the mono signature on.
 */
export type ShellSentencePart =
  | { readonly kind: "words"; readonly words: string }
  | { readonly kind: "figure"; readonly value: string }
  | { readonly kind: "count"; readonly count: number };

/** One sentence, as alternating words and figure slots. Rendered, never joined. */
export type ShellSentence = readonly ShellSentencePart[];

/** The console's own words. Named so a builder below reads as the sentence it is. */
function words(text: string): ShellSentencePart {
  return { kind: "words", words: text };
}

/** A byte-for-byte string the shell reported. Rendered verbatim, in mono. */
function figure(value: string): ShellSentencePart {
  return { kind: "figure", value };
}

/** A quantity the shell reported. Rendered through `Intl`, in mono. */
function count(value: number): ShellSentencePart {
  return { kind: "count", count: value };
}

/** The console's own protocol version, as the negotiation reports this build's side. */
export interface VersionRemedy {
  /** The banner's headline: which side is out of range. */
  readonly headline: string;
  /** What the person does about it. Never a control — both remedies are elsewhere. */
  readonly remedy: string;
}

/**
 * Which side moves, from the refused ack's own reason.
 *
 * `Spec-023 §Daemon Supervision Lifecycle` step 3 requires the incompatibility be
 * surfaced and does not write the copy, and the two registered reasons admit exactly
 * one reading each: below the daemon's floor, this console is what moves; above its
 * ceiling, the runtime is. A reason this build does not know is not guessed at — the
 * remedy line says the console cannot tell which side to move, which is true, rather
 * than picking one and being wrong half the time.
 */
export function versionRemedyFor(reason: string | undefined): VersionRemedy {
  switch (reason) {
    case "version.floor_exceeded":
      return {
        headline: "This console is older than the local runtime accepts.",
        remedy: "Update the console. Reads stay live until you do.",
      };
    case "version.ceiling_exceeded":
      return {
        headline: "This console is newer than the local runtime supports.",
        remedy: "Update the local runtime. Reads stay live until you do.",
      };
    case "protocol.handshake_already_completed":
      return {
        headline: "The local runtime had already completed a handshake on this connection.",
        remedy: "Restart the local runtime from the daemon settings page to negotiate again.",
      };
    default:
      return {
        headline: "The console and the local runtime did not agree on a protocol version.",
        remedy:
          "The runtime did not say which side is out of range, so this console will not guess. The supported versions are below.",
      };
  }
}

/**
 * The version pair, as one line: what this build speaks and what the runtime chose.
 *
 * Both versions are wire strings — `store/shell-state.ts` types each of them
 * "verbatim" — so each takes a figure slot rather than a position in a template. A
 * version pasted into prose is a version a person cannot tell from the sentence around
 * it, and the one thing this banner exists to let them do is read the two and compare.
 */
export function describeVersionPair(negotiation: ShellNegotiation): ShellSentence {
  return [
    words("This console speaks "),
    figure(negotiation.consoleProtocolVersion),
    words("; the local runtime answered "),
    figure(negotiation.daemonProtocolVersion),
    words("."),
  ];
}

/**
 * What the runtime says it supports, or that it did not say.
 *
 * HERE RATHER THAN AT THE BANNER, where it was composed inline until this sweep. It is
 * a sentence the honest-chrome plane says, so it belongs in the module whose header
 * claims to hold every one of them — and it carries the same defect the pair above
 * did, a list of wire versions joined into prose, so it takes the same repair.
 */
export function describeSupportedProtocols(negotiation: ShellNegotiation): ShellSentence {
  if (negotiation.daemonSupportedProtocols.length === 0) {
    return [words("The runtime did not list the versions it supports.")];
  }
  const listed = negotiation.daemonSupportedProtocols.flatMap<ShellSentencePart>(
    (version, position) => (position === 0 ? [figure(version)] : [words(", "), figure(version)]),
  );
  return [words("The runtime supports "), ...listed, words(".")];
}

/**
 * What each blocked method does, in a person's words.
 *
 * A TOTAL record over the six, so a seventh mutating registration is a compile error
 * here rather than a control that quietly disappears from the read-only line while
 * still being disabled on screen.
 */
const MUTATING_METHOD_LABELS: Record<MutatingDaemonMethod, string> = {
  "session.create": "starting a session",
  "session.join": "joining a session",
  "driver.interruptRun": "interrupting a run",
  "driver.applyIntervention": "steering, rewinding, and the other run controls",
  "driver.respondToRequest": "answering a provider's question",
  "driver.compactContext": "compacting a session's context",
};

/**
 * The read-only line: exactly what stops, listed, and what keeps working.
 *
 * Derived from the closed method tuple rather than written out, so the sentence and
 * the predicate that disables the controls cannot disagree — which is the whole
 * point of naming the set at all.
 */
export function readOnlyLine(): string {
  const blocked = MUTATING_DAEMON_METHODS.map((method) => MUTATING_METHOD_LABELS[method]);
  const listed = `${blocked.slice(0, -1).join(", ")}, and ${blocked[blocked.length - 1] ?? ""}`;
  return `Read-only: ${listed} are unavailable. Reading, watching, and the provider catalogues stay live.`;
}

/**
 * The connection banner's sentence, or `undefined` where the state raises none.
 *
 * The two ladder arms carry figures for the same reason the version pair does: the
 * attempt and the limit are numbers the supervisor reported, and `String()` around one
 * is a formatter this console does not own — it bypasses `Intl` and it puts a
 * quantity on screen wearing no provenance at all. Every other arm is the console's
 * own words end to end and is one part.
 */
export function connectionLineFor(connection: ShellConnection): ShellSentence | undefined {
  switch (connection.kind) {
    case "unreported":
    case "connected":
    case "version-incompatible":
      // The mismatch has a banner of its own, and it is deliberately not this one:
      // an incompatible handshake is not a disconnect and must not wear its chrome.
      return undefined;
    case "probing":
      return [
        words(
          "Checking whether the local runtime is already running. Nothing on screen is out of date yet.",
        ),
      ];
    case "starting":
      return [words("The local runtime is starting. This window is waiting for it, not frozen.")];
    case "reconnecting":
      return [
        words("The local runtime dropped. Reconnecting — attempt "),
        count(connection.attempt),
        words(" of "),
        count(connection.attemptLimit),
        words(". Everything on screen is the last state that reached this window."),
      ];
    case "offline":
      return [
        words("The local runtime did not come back after "),
        count(connection.attemptLimit),
        words(
          " attempts. Everything on screen is the last state that reached this window, and nothing new will arrive until it starts again.",
        ),
      ];
    case "stopped":
      return [
        words(
          "The local runtime is stopped. Starting it again is a shell action rather than a call, because a stopped runtime has no server to receive one.",
        ),
      ];
  }
}

/**
 * The catch-up line, named by the cause the store's own ladder settled on.
 *
 * TOTAL OVER THE FIVE, so a sixth cause is a compile error here rather than a window
 * that recovers silently. What every arm has in common is the remedy — a completed
 * re-pull and nothing else clears any of them — and what differs is what a person is
 * owed an explanation of.
 */
export function recoveryLineFor(cause: SessionDegradedCause): string {
  switch (cause) {
    case "sequence-gap":
      return "A gap opened in this session's stream, so this window is re-reading it rather than replaying what was missed. What is on screen is the last complete state until that read lands.";
    case "stream-diverged":
      return "This session's stream stopped matching what this window holds, so the whole projection is being re-read. What is on screen is not trusted until it lands.";
    case "projection-failed":
      return "This window could not apply part of this session's stream, so it is re-reading the session from the daemon.";
    case "subscription-closed":
      return "The subscription carrying this session closed, so this window is re-reading it. Nothing new arrives until that read lands.";
    case "read-failed":
      return "The re-read of this session did not come back. This window will ask again; what is on screen is the last state that reached it.";
  }
}

/** The loopback notice. A lesser posture, stated as one. */
export const LOOPBACK_NOTICE = {
  title: "Loopback transport is in use",
  detail:
    "OS-local transport to the local runtime was unavailable on this host, so the connection fell back to loopback. It works, and it is weaker: loopback is reachable by anything else running as you.",
  remedy:
    "The transport is chosen by the shell at startup. Restarting the runtime retries OS-local.",
} as const;

/** The keystore notice, and what memory-only costs stated where it is felt. */
export const KEYSTORE_NOTICE = {
  title: "No OS keystore — this sign-in is memory-only",
  detail:
    "The shell will not write long-lived sign-in material with no keystore to protect it, because the platform primitive falls back to a hardcoded plaintext password when none is available. This session ends at quit, and sign-in is required again next launch.",
  remedy: "Install or unlock a system keyring, then restart the console.",
} as const;
