// Who holds a session's shared-terminal write lease, as the session roster reads it.
import type { UserId } from "@ai-sidekicks/contracts";

/**
 * The roster's reading of a session's one shared-terminal write lease.
 *
 * The lease is per session, so the holder rides beside the session's nodes rather
 * than on each of them.
 *
 * `controlHolder` is required and nullable, so a client cannot read "nobody holds it"
 * out of an absent member. `null` carries two readings a client deliberately cannot
 * tell apart: the lease is free, or it is held by a node the control plane reads as
 * `offline`. Both render as no holder, because no client should offer to write
 * against a holder that cannot be vouched live. The suppression binds at `offline`
 * and nothing weaker; `degraded` is a band a node recovers from.
 */
export interface SessionTerminalControlReading {
  controlHolder: UserId | null;
}
