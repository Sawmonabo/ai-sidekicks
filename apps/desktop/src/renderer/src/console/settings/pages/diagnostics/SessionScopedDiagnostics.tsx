// The read-out, addressed to the runs of the session this window has open.
//
// A component of its own because `useSessionPartition` needs a store and a store is
// exactly what a settings surface may not have: settings is reachable with no session,
// and a hook cannot be called conditionally. So the page mounts THIS when it has a
// store and the read-out directly when it does not, which is the family's established
// shape for an optional store rather than a new one.
//
// WHAT IT ADDS is the subject resolution and nothing else. It renders no markup of its
// own, holds no state, and asks no wire: it reads the session's run partition, turns it
// into two ids, and hands them down. The read-out is identical on both paths, which is
// what keeps a window with no session from taking a different code path through the
// four readings that do not need one.

import type { ReactNode } from "react";

import { useSessionPartition, type SessionStore } from "../../../store/index.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { DiagnosticsReadOut } from "./DiagnosticsReadOut.js";
import { resolveDiagnosticsRunSubjects } from "./run-subjects.js";

export function SessionScopedDiagnostics(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
}): ReactNode {
  const { bridge, sessionStore } = props;
  const runs = useSessionPartition(sessionStore, "run");
  return (
    <DiagnosticsReadOut
      bridge={bridge}
      subjects={resolveDiagnosticsRunSubjects(runs)}
      sessionStore={sessionStore}
    />
  );
}
