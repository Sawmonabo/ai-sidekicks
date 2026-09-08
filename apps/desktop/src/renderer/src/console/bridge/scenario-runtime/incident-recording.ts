// An incident recording: the wire frames a defect actually arrived on, kept as bytes.
//
// `Spec-023 §Console Design (Meridian)` §The fixture bridge names an `incident` class
// of scenario "carrying byte-faithful wire deltas for replay of recorded defects". It
// is the one mechanism the design gives for turning a defect that happened into a
// regression the console cannot lose, and the reason it has to be BYTES rather than a
// hand-written script is the defect class it exists for.
//
// A family scenario is authored in `ConsoleSessionEvent`s and composed onto the wire by
// `scenario-envelope.ts`. That is the readable way to write a session, and it is exactly
// what cannot reproduce a decode defect: an authored beat is written against the
// console's own reading of the wire, so a console that reads the wire wrongly composes
// frames that agree with it and every fixture run passes while every real session fails.
// `scenario-envelope.ts`'s header records that happening. A RECORDING is the other
// direction — what arrived, kept verbatim, replayed through the same boundary a live
// delivery crosses — so a console that no longer reads those bytes fails on them.
//
// WHAT "BYTE-FAITHFUL" MEANS HERE, STATED NARROWLY SO IT CAN BE TRUE. The recording
// holds each frame as the TEXT the recorder wrote, and the player parses that text and
// never recomposes a frame from a typed value. It does not claim the text is the exact
// octets some transport carried: the console's preload bridge hands its subscribers
// parsed values, not frames, so a recorder that demanded octets could never be fed by
// the one process that sees deliveries. The claim that IS made is the one that catches
// the defect class — the recording is the authority, nothing between the recording and
// the console's decode boundary re-derives a member, and an edit to a frame's text is an
// edit to what the replay delivers.
//
// WHAT IS NOT HERE. Replay, which is `incident-replay.ts`: writing a recording and
// reading one back are two jobs, and the reader has to reach the console's own decode
// boundary while the writer reaches nothing at all.

/**
 * One recorded frame: the tick it arrived at, and its text.
 *
 * `atMs` is measured from the recording's own start, the same origin a
 * {@link ScenarioBeat} measures from, so a replay needs no rebasing arithmetic.
 */
export interface IncidentWireDelta {
  readonly atMs: number;
  /** The frame's text, exactly as the recorder wrote it. Never re-serialized. */
  readonly frameJson: string;
}

/** A recorded defect: what it was, when it was taken, and the frames it arrived on. */
export interface IncidentRecording {
  /** Stable handle for this defect. Names the incident, never the surface it broke. */
  readonly incidentId: string;
  /** What went wrong, in the words the person replaying it needs. */
  readonly summary: string;
  readonly recordedAtIso: string;
  readonly deltas: readonly IncidentWireDelta[];
}

/**
 * What one {@link IncidentRecorder.record} call did.
 *
 * A returned outcome rather than a throw, because the recorder sits on a DELIVERY path:
 * a frame that cannot be recorded is a gap in a recording, and a recorder that threw
 * would turn it into a gap in the session the person is using. Every arm is a real
 * failure the replay would otherwise inherit silently.
 */
export type IncidentRecordOutcome =
  | "recorded"
  /** The delivered value has no JSON text — a cycle, a `BigInt`, or nothing at all. */
  | "unserializable"
  /** The tick is earlier than the frame in front of it; a recording is a timeline. */
  | "out-of-order"
  /** The recorder is full. Its bound is its caller's, stated at construction. */
  | "over-bound";

/** What a recorder needs before it can hold anything. Every member is required. */
export interface IncidentRecorderDeclaration {
  readonly incidentId: string;
  readonly summary: string;
  readonly recordedAtIso: string;
  /**
   * How many frames this recorder will hold.
   *
   * REQUIRED, AND NO DEFAULT, so no ceiling is minted here. `console/core/constants.ts`
   * is where a cap with a blast radius lives; this one has none — it bounds a single
   * recorder for as long as its caller holds it — and a default would be a ceiling
   * every caller inherited without naming, which is the shape that home exists to stop.
   */
  readonly frameBound: number;
}

/**
 * Writes an incident recording, one delivered frame at a time.
 *
 * A CLASS because it is the stateful half of this module: it holds the frames written
 * so far and the tick the last one took, and both of those decide what the next call
 * does. The reading half — what a recording IS — is the interfaces above, which is why
 * they are declared beside it rather than inside it.
 */
export class IncidentRecorder {
  readonly #declaration: IncidentRecorderDeclaration;
  readonly #deltas: IncidentWireDelta[] = [];
  #lastRecordedAtMs = Number.NEGATIVE_INFINITY;
  #refusedFrameCount = 0;

  public constructor(declaration: IncidentRecorderDeclaration) {
    if (!Number.isSafeInteger(declaration.frameBound) || declaration.frameBound < 1) {
      throw new RangeError(
        `an incident recorder's frame bound is a positive safe integer, and this one is ${String(declaration.frameBound)}. A recorder that holds nothing records nothing, and a fractional bound names no number of frames.`,
      );
    }
    this.#declaration = declaration;
  }

  /**
   * Record one delivered frame at the tick it arrived at.
   *
   * The value is serialized HERE, once, and the text is what the recording holds from
   * then on. Serializing at record time rather than at replay time is what makes the
   * recording the authority: a later change to the shape of the value that was
   * delivered cannot reach a frame already written down.
   */
  public record(atMs: number, deliveredFrame: unknown): IncidentRecordOutcome {
    if (this.#deltas.length >= this.#declaration.frameBound) {
      this.#refusedFrameCount += 1;
      return "over-bound";
    }
    if (atMs < this.#lastRecordedAtMs) {
      this.#refusedFrameCount += 1;
      return "out-of-order";
    }
    const frameJson = serializeDeliveredFrame(deliveredFrame);
    if (frameJson === undefined) {
      this.#refusedFrameCount += 1;
      return "unserializable";
    }
    this.#deltas.push({ atMs, frameJson });
    this.#lastRecordedAtMs = atMs;
    return "recorded";
  }

  /** Frames written down so far. */
  public get recordedFrameCount(): number {
    return this.#deltas.length;
  }

  /** Frames this recorder was handed and did not write down. */
  public get refusedFrameCount(): number {
    return this.#refusedFrameCount;
  }

  /** The recording as it stands. A snapshot: later calls do not reach what it returns. */
  public recording(): IncidentRecording {
    return {
      incidentId: this.#declaration.incidentId,
      summary: this.#declaration.summary,
      recordedAtIso: this.#declaration.recordedAtIso,
      deltas: [...this.#deltas],
    };
  }
}

/**
 * The text of one delivered frame, or `undefined` where it has none.
 *
 * `JSON.stringify` has two no-text answers and they are one fact here: it THROWS on a
 * cyclic value and on a `BigInt`, and it RETURNS `undefined` for `undefined` itself and
 * for a function or a symbol. Both mean the same thing to a recording — there is no
 * frame to write — so both arrive as the same absence rather than as an exception the
 * delivery path would have to carry.
 */
function serializeDeliveredFrame(deliveredFrame: unknown): string | undefined {
  try {
    return JSON.stringify(deliveredFrame);
  } catch {
    return undefined;
  }
}
