// Where a provider reaches the daemon's tool servers for a session: the route the daemon's
// tool-server front registers once it runs.
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/**
 * The address of each of a session's tool servers, registered through a `PortRegistration`. Until
 * it is registered, a session starts with no daemon tool server entry.
 */
export interface ToolServerRoute {
  /** The address a provider reaches `serverName` at for `sessionId`. */
  urlFor(sessionId: SessionId, serverName: string): string;
}
