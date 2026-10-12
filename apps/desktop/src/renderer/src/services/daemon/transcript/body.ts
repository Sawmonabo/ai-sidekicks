// The `transcript.bodyRead` client: the read of one row's large body or full output, which its row
// carries only as a size, asked for when a person opens the body or a copy takes it in.

import type {
  TranscriptBodyReadRequest,
  TranscriptBodyReadResponse,
} from "@ai-sidekicks/contracts/transcript/content";

import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { callDaemon, type DaemonCallOptions, type DaemonReply } from "../reply.js";

/**
 * One `transcript.bodyRead`, parsed, or the refusal standing in its place. Resolves `served` or
 * `refused` for every transport outcome and never rejects.
 */
export type TranscriptBodyRead = (
  request: TranscriptBodyReadRequest,
  options?: DaemonCallOptions,
) => Promise<DaemonReply<TranscriptBodyReadResponse>>;

/** The `transcript.bodyRead` call through one bridge. */
export function transcriptBodyReadThroughDaemon(bridge: PlatformBridge): TranscriptBodyRead {
  return (request, options) => callDaemon(bridge, "transcript.bodyRead", request, options);
}
