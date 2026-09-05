// Standing in for one named subscription, and leaving every other one real.
//
// IN THE BRIDGE FAMILY BECAUSE TAKING `sidekicks.daemon` IS. The chokepoint gate
// admits exactly this family to the raw namespace — a test in any other family is
// standing in for a surface, and a surface goes through the door — and every wrapper
// here replaces the namespace's own `subscribe`.
//
// FIVE ROLES, ONE HOME, and each is a SPREAD OVER A REAL BRIDGE rather than a
// fabricated object. That is the whole difference from the stand-ins these replaced:
// an object cast to `ConsoleBridge` answers every stream and every call with whatever
// its author remembered to write, so a surface that opened a SECOND read passed
// against an answer nobody chose, and each copy had to carry a hand-made scenario
// engine because a cast is not a bridge and has no clock to schedule against. These
// leave everything they do not name exactly as the bridge underneath answers it.
//
// The delivery pair is `withCapturedStream`'s sibling rather than its rival, and the
// difference is WHEN. That helper holds the CURRENT sink so a case can place a frame
// after a read has settled; {@link withReplayedStream} delivers during the open,
// which is what a stream really does with its backlog; and
// {@link withRecordedStreamSinks} keeps the superseded sinks a re-open left behind,
// which is the only way to deliver into a read the surface has already moved on from.

import type { ConsoleBridge } from "./console-bridge.js";

/** The raw subscribe arm, as these wrappers have to call it. */
type RawSubscribe = (name: string, sink: (payload: unknown) => void) => () => void;

function rawSubscribeOf(bridge: ConsoleBridge): RawSubscribe {
  return bridge.sidekicks.daemon.subscribe as RawSubscribe;
}

/** One bridge with its subscribe arm replaced, and nothing else touched. */
function withSubscribeArm(bridge: ConsoleBridge, subscribe: RawSubscribe): ConsoleBridge {
  return {
    ...bridge,
    sidekicks: {
      ...bridge.sidekicks,
      daemon: {
        ...bridge.sidekicks.daemon,
        subscribe: subscribe as ConsoleBridge["sidekicks"]["daemon"]["subscribe"],
      },
    },
  } as ConsoleBridge;
}

/** A bridge recording what was opened and closed on it, and what it recorded. */
export interface RecordedStreamLifecycle {
  readonly bridge: ConsoleBridge;
  /** Every stream name opened on this bridge, in order, repeats included. */
  readonly openedStreams: readonly string[];
  /** How many times one stream was opened — the reading a re-open case makes. */
  readonly openCountFor: (streamName: string) => number;
  /** How many of that stream's subscriptions were closed again. */
  readonly closeCountFor: (streamName: string) => number;
}

/**
 * Record the subscriptions a bridge is asked for and released, leaving them real.
 *
 * The open record is NAMES rather than a count of one stream, because the two claims
 * that need it are different questions about the same record: a re-open case asks how
 * many times one stream was opened, and an opening case asks that exactly one stream
 * was opened and which — which a counter scoped to a single name cannot answer, since
 * it says nothing about the streams it was not counting.
 *
 * Closes are counted beside them rather than in a wrapper of their own, because they
 * are the same fact: a surface that opens and never releases and one that releases
 * what it opened are told apart only by holding both halves, and a second wrapper
 * would have to be composed in exactly this position to see the same subscriptions.
 */
export function withRecordedStreamLifecycle(bridge: ConsoleBridge): RecordedStreamLifecycle {
  const openedStreams: string[] = [];
  const closedStreams: string[] = [];
  const underlying = rawSubscribeOf(bridge);
  const countIn = (record: readonly string[], streamName: string): number =>
    record.filter((entry) => entry === streamName).length;
  return {
    openedStreams,
    openCountFor: (streamName: string) => countIn(openedStreams, streamName),
    closeCountFor: (streamName: string) => countIn(closedStreams, streamName),
    bridge: withSubscribeArm(bridge, (name, sink) => {
      openedStreams.push(name);
      const release = underlying(name, sink);
      return () => {
        closedStreams.push(name);
        release();
      };
    }),
  };
}

/** A bridge holding every sink one stream was opened with, in order. */
export interface RecordedStreamSinks {
  readonly bridge: ConsoleBridge;
  /** Each sink, oldest first — including the ones a re-open has superseded. */
  readonly sinks: readonly ((payload: unknown) => void)[];
}

/**
 * Keep every sink one stream is opened with, superseded ones included.
 *
 * The superseded ones are the point: a case delivers to a sink the surface has
 * already moved on from, to prove a frame from the previous session's stream reaches
 * no reading — a claim that is unreachable if the only sink you can name is the live
 * one.
 */
export function withRecordedStreamSinks(
  bridge: ConsoleBridge,
  streamName: string,
): RecordedStreamSinks {
  const sinks: ((payload: unknown) => void)[] = [];
  const underlying = rawSubscribeOf(bridge);
  return {
    sinks,
    bridge: withSubscribeArm(bridge, (name, sink) => {
      if (name !== streamName) {
        return underlying(name, sink);
      }
      sinks.push(sink);
      return () => undefined;
    }),
  };
}

/**
 * A bridge whose named subscription throws in the caller's own frame.
 *
 * The shipped Tier-1 preload does exactly this when no daemon is attached, so the
 * throw is the transport's real failure mode rather than an invented one: a surface
 * opens inside an effect commit, and a throw there takes the whole tree down unless
 * the surface catches it.
 */
export function withUnopenableStream(
  bridge: ConsoleBridge,
  streamName: string,
  thrown: unknown,
): ConsoleBridge {
  const underlying = rawSubscribeOf(bridge);
  return withSubscribeArm(bridge, (name, sink) => {
    if (name !== streamName) {
      return underlying(name, sink);
    }
    throw thrown;
  });
}

/**
 * A bridge whose named subscription throws on its FIRST open and opens after that.
 *
 * The transport arm of a refused open, which is a different fact from
 * {@link withUnopenableStream}'s permanent one: a bridge that threw once is the same
 * bridge a repair, a focus, or a fresh mount asks again, so a reading that settled
 * refused on the open has to be able to come back. Refusing every open cannot state
 * that claim — under it a re-open and a reading that never tries again look
 * identical — which is why this is its own role rather than a flag on that one.
 */
export function withStreamUnopenableAtFirst(
  bridge: ConsoleBridge,
  streamName: string,
  thrown: unknown,
): ConsoleBridge {
  const underlying = rawSubscribeOf(bridge);
  let hasRefused = false;
  return withSubscribeArm(bridge, (name, sink) => {
    if (name !== streamName) {
      return underlying(name, sink);
    }
    if (!hasRefused) {
      hasRefused = true;
      throw thrown;
    }
    return underlying(name, sink);
  });
}

/**
 * Replay a script into one subscription as it is opened.
 *
 * AT OPEN TIME, which is what a stream really does with its backlog: a case about
 * what a surface RENDERS for a set of frames wants them delivered by the time the
 * render settles, so a surface that only reads frames arriving later fails here
 * rather than passing on a technicality.
 */
export function withReplayedStream(
  bridge: ConsoleBridge,
  streamName: string,
  deliveries: readonly unknown[],
): ConsoleBridge {
  const underlying = rawSubscribeOf(bridge);
  return withSubscribeArm(bridge, (name, sink) => {
    if (name !== streamName) {
      return underlying(name, sink);
    }
    for (const delivery of deliveries) {
      sink(delivery);
    }
    return () => undefined;
  });
}
