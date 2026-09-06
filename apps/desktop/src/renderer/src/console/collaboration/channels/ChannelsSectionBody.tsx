import { useCallback, useMemo } from "react";

import { membershipRoleOf } from "../../bridge/index.js";
import { usePushDrivenRead, type SidebarSectionContext } from "../../seats/index.js";
import {
  useCallerMembershipRole,
  useSessionDegraded,
  useSessionPartition,
  type CallerParticipantReader,
} from "../../store/index.js";
import { ChannelList } from "./ChannelList.js";
import { type CollaborationSessionModels } from "../session-models.js";

/**
 * The body, mounted only once the models exist.
 *
 * A separate component because `usePushDrivenRead` needs a model to subscribe to and
 * a hook cannot be called conditionally — so the absence is rendered by the mount
 * above and the read is subscribed to here.
 *
 * IT IS ALSO WHERE THE STORE IS, which is why two facts the list cannot reach for
 * itself are resolved here and handed down: who else is in this session, and which
 * participant this window is. Both are the store's or are chained to it, and the list
 * holds no store at all.
 */
export function ChannelsSectionBody(props: {
  readonly context: SidebarSectionContext;
  readonly models: CollaborationSessionModels;
}): React.JSX.Element {
  const { context, models } = props;
  const { bridge, sessionStore } = context;
  const state = usePushDrivenRead(models.channelDirectory);
  // The store's own sticky degraded flag, read rather than inferred: the console
  // never decides on its own that a projection is behind. SUBSCRIBED rather than
  // sampled — a snapshot read in this body has nothing behind it, and this section
  // subscribes only to its channel read, so a store entering or leaving its degraded
  // state without that read settling moved the flag and re-rendered nothing.
  const isCatchingUp = useSessionDegraded(context.sessionStore);
  const participantEntities = useSessionPartition(sessionStore, "participant");
  const participantIds = useMemo(() => Object.keys(participantEntities), [participantEntities]);
  // WHICH PARTICIPANT THIS WINDOW IS, through the console's one reader of that
  // question rather than a second implementation of it. The identity read lives on
  // the growth port, which is a family ABOVE `store/`, so the reader is composed here
  // — the composition site — and the chaining hook is the store's. Its ROLE half is
  // deliberately unused: nothing on this surface gates on a role, because eligibility
  // for every act here is the daemon's answer and arrives as a refusal. What is
  // wanted is the identity, and a second read for it would be a second answer to a
  // question this hook already asks.
  // The id off the store ONCE, and the reader depends on the id rather than on the
  // store that holds it. The two differ where it counts: a store handed a second
  // session is a new object and would rebuild this reader either way, but a reader
  // whose dependency list names the store rather than the subject it closes over
  // reads as a callback that could be rebound without re-reading — which is the shape
  // the subject-state tripwire refuses, and it refuses it because that is how every
  // hand-rolled holder in this tree began.
  const sessionId = sessionStore.sessionId;
  const readCallerParticipant = useCallback<CallerParticipantReader>(async () => {
    const outcome = await bridge.growth.callerParticipantRead({ sessionId });
    // A served value answers with the identifier; a refusal IS a `ConsoleRefusal` and
    // travels back untouched, so the reason the viewer is unknown survives.
    return outcome.status === "served" ? outcome.value.participantId : outcome;
  }, [bridge, sessionId]);
  const caller = useCallerMembershipRole(readCallerParticipant, sessionStore, membershipRoleOf);
  // The read arm and nothing else. A viewer that is still being read and one whose
  // read refused are both "not known", and the two surfaces below fail closed on that
  // in their own way rather than being handed a guess.
  const viewerParticipantId = caller.status === "read" ? caller.participantId : undefined;
  // The read's OWN re-open, not a rebuild of the set: a refused subscribe leaves this
  // column terminal for the life of the window, and the directory that refused is the
  // only one that has to be re-opened.
  const reopenDirectory = useCallback(() => {
    // ONE CALL, because the seam owns the stream-then-read order now: `refresh` takes
    // the subscription first where it is not held and requests the read either way.
    // A branch here would be a second reading of a decision the read already makes,
    // and the branch this replaced could only be right while both halves agreed.
    models.channelDirectory.refresh("participant-request");
  }, [models]);

  return (
    <ChannelList
      state={state}
      bridge={bridge}
      sessionId={sessionId}
      viewerParticipantId={viewerParticipantId}
      participantIds={participantIds}
      openPane={context.openPane}
      activity={models.activity}
      labels={models.labels}
      isCatchingUp={isCatchingUp}
      onReopen={reopenDirectory}
    />
  );
}
