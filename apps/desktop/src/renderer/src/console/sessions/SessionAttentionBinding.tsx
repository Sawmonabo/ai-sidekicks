// The one attention read this window performs, for as long as the window is open.
//
// WHY IT IS A FRAME-LIFETIME BINDING. A window that has simply moved to another
// destination is not an unreachable machine: the daemon is answering and this window is
// following it. A read mounted on a destination would throw its answer away whenever
// somebody navigated. It happens here, on the frame-lifetime binding seat, so the
// reading is live from the moment the window resolves a bridge until it tears down.
//
// AND IT IS STILL EXACTLY ONE READ. The destination consumes what this binding holds
// rather than opening its own — the notification center renders the same reading the
// all-sessions list takes each row's severity from, so the panel and the list cannot
// disagree about what needs a person, which two reads, however carefully written,
// eventually would.
//
// THE DIRECTORY COMES WITH IT, read once and provided beside the reading, so the
// destination takes both from the same place.
//
// THE TWO CALLS ARE THE MOUNTING COMPOSITION'S. This module holds only how the answers
// are kept and provided; the calls that list the node's sessions and read the
// projection are handed in, so nothing here reaches a wire.
//
// NOTHING HERE POLLS AND NOTHING HERE RENDERS. The attention read re-runs when the
// session projections underneath it move, through the console's one push-driven read
// discipline; this component draws no markup and returns the subtree it was handed.
// The directory re-reads on the window's own focus trigger and on a settled act's
// explicit ask, which are the two moments `store/read/read-triggers.ts` already names
// for a node-scoped reading.

import { createContext, useCallback, useContext, useMemo } from "react";

import { ConsoleRefusalError, refuse } from "@renderer/lib/refusal.js";
// The seat's own props type rather than a second declaration of the same two
// members: this component IS a frame binding's mount, so its shape is the board's and
// a local copy would be one more thing to keep in step.
import type { FrameBindingProps } from "../seats/index.js";
import {
  requestSessionDirectoryRead,
  useSessionDirectory,
  type SessionDirectoryReadCall,
  type SessionDirectoryState,
} from "../seats/index.js";
import {
  useAttentionProjection,
  type AttentionProjectionReadCall,
  type AttentionReading,
} from "./notifications/index.js";

/** The subsystem a missing binding names as the author of its refusal. */
const SESSION_ATTENTION_ORIGIN = "session-attention-binding";

/**
 * What this window holds about the sessions it can name, read once.
 *
 * The members are what the consumers between them need, and no more: the destination
 * renders the reading and can ask for the directory again.
 */
export interface SessionAttention {
  /** The node's own session list, as the read settled it. */
  readonly directory: SessionDirectoryState;
  readonly reading: AttentionReading;
  /** Declare the node's directory stale, so it is read again. */
  readonly recheckDirectory: () => void;
}

/** The binding's props: the seat's own, and the two calls it keeps answers for. */
export interface SessionAttentionBindingProps extends FrameBindingProps {
  /** The call that lists the node's sessions. */
  readonly readDirectory: SessionDirectoryReadCall;
  /** The call that reads the attention projection. */
  readonly readAttention: AttentionProjectionReadCall;
}

const SessionAttentionContext = createContext<SessionAttention | undefined>(undefined);

/**
 * Perform the read for the frame's lifetime and provide it to whatever is below.
 *
 * MOUNTED BY THE COMPOSITION AND NEVER BY A ROUTE. The frame wraps its subtree in
 * every registered binding, so this component's lifetime is the window's.
 */
export function SessionAttentionBinding(props: SessionAttentionBindingProps): React.JSX.Element {
  const { bridge, sessionStoreRegistry } = props.context;
  const directory = useSessionDirectory(props.readDirectory, bridge.transportReconnect);
  const reading = useAttentionProjection(props.readAttention, sessionStoreRegistry);
  const { readDirectory } = props;
  const recheckDirectory = useCallback(() => {
    requestSessionDirectoryRead(readDirectory);
  }, [readDirectory]);
  const held = useMemo<SessionAttention>(
    () => ({
      directory,
      reading,
      recheckDirectory,
    }),
    [directory, reading, recheckDirectory],
  );
  return (
    <SessionAttentionContext.Provider value={held}>
      {props.children}
    </SessionAttentionContext.Provider>
  );
}

/**
 * What the binding above holds.
 *
 * RAISES RATHER THAN SUBSTITUTES. A surface reaching for a binding no composition
 * mounted is a wiring defect, and the honest answers a fallback could give are both
 * wrong: an empty reading would render "nothing needs you" over a projection nobody
 * read, and a second read here would be the second answer this binding exists to
 * prevent. It is the rule `useConsoleBridge` already follows one layer down.
 */
export function useSessionAttention(): SessionAttention {
  const held = useContext(SessionAttentionContext);
  if (held === undefined) {
    throw new ConsoleRefusalError(
      refuse(
        SESSION_ATTENTION_ORIGIN,
        "binding-unmounted",
        "This surface reads the window's attention binding, and no composition mounted one above it.",
      ),
    );
  }
  return held;
}
