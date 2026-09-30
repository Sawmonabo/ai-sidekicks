/**
 * Reads the rendered transcript a Claude session is rebuilt from, and the errors that replay
 * raises when the transcript cannot be read or replayed.
 */

import {
  type ReplayTargetReadback,
  type ReplayTargetReadbackReader,
  type SeededTranscriptFrame,
} from "../../transcript/replay-assertion.js";

/**
 * Thrown when a replay against a build with a seeding surface fails; its own class because the
 * closed `reason` union of `ClaudeSessionUnavailableError` has no member for it.
 */
export class ClaudeTranscriptReplayFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeTranscriptReplayFailedError";
  }
}

/** Converts a rejecting readback reader into the `unreadable` arm, as the seam's contract says. */
export async function readReplayTargetSafely(
  read: ReplayTargetReadbackReader,
  targetProviderSessionId: string,
): Promise<ReplayTargetReadback> {
  try {
    return await read(targetProviderSessionId);
  } catch (error: unknown) {
    return { kind: "unreadable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Parses one exported transcript frame for the Claude replay leg, failing closed: skipping an
 * unreadable frame would be an undeclared loss that falsifies the `applied` arm's loss list. A
 * sibling of the Codex parser, not shared: the driver trees stay independent of each other.
 */
export function readRenderedTranscriptFrameForClaudeReplay(frame: unknown): SeededTranscriptFrame {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    throw new ClaudeTranscriptReplayFailedError(
      "A transcript frame handed to the Claude replay leg was not an object.",
    );
  }
  const candidate = frame as Record<string, unknown>;
  const position = candidate["position"];
  const role = candidate["role"];
  const segments = candidate["segments"];
  if (typeof position !== "number" || !Number.isInteger(position)) {
    throw new ClaudeTranscriptReplayFailedError(
      "A transcript frame handed to the Claude replay leg carried no integer position.",
    );
  }
  if (role !== "user" && role !== "assistant") {
    throw new ClaudeTranscriptReplayFailedError(
      `A transcript frame at position ${String(position)} carried the unrecognized role "${String(role)}".`,
    );
  }
  if (!Array.isArray(segments)) {
    throw new ClaudeTranscriptReplayFailedError(
      `The transcript frame at position ${String(position)} carried no segment list.`,
    );
  }
  const bodyParts: string[] = [];
  for (const segment of segments) {
    if (typeof segment !== "object" || segment === null || Array.isArray(segment)) {
      throw new ClaudeTranscriptReplayFailedError(
        `The transcript frame at position ${String(position)} carried a segment that was not an object.`,
      );
    }
    const kind = (segment as Record<string, unknown>)["kind"];
    if (kind === "text" || kind === "reasoning") {
      const text = (segment as Record<string, unknown>)["text"];
      if (typeof text !== "string") {
        throw new ClaudeTranscriptReplayFailedError(
          `A "${String(kind)}" segment of the transcript frame at position ${String(position)} carried no text.`,
        );
      }
      if (text.length > 0) {
        bodyParts.push(text);
      }
      continue;
    }
    if (kind === "tool_call" || kind === "tool_result") {
      continue;
    }
    // An unrecognized kind refuses, so a new canonical kind fails loudly.
    throw new ClaudeTranscriptReplayFailedError(
      `The transcript frame at position ${String(position)} carried an unsupported segment kind "${String(kind)}"; refusing to seed a frame this driver cannot represent.`,
    );
  }
  return { position, role, text: bodyParts.join("\n\n") };
}

/**
 * Thrown when a replay cannot be served (no surface reader bound, or the build's probe refused);
 * thrown rather than returned as `degraded`, which is the memo deliverer's.
 */
export class ClaudeTranscriptReplayUnsupportedError extends Error {
  constructor(reason: string) {
    super(
      `The installed Claude build exposes no prior-turn seeding surface this driver can drive: ${reason}`,
    );
    this.name = "ClaudeTranscriptReplayUnsupportedError";
  }
}
