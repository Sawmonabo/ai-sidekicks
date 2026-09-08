import { useCallback, useMemo } from "react";

import {
  useCallerParticipantIdentity,
  usePushDrivenRead,
  type SidebarSectionContext,
} from "../../seats/index.js";
import { useSessionDegraded, useSessionPartition } from "../../store/index.js";
import { ChannelList } from "./ChannelList.js";
import { liveMembershipParticipantIds } from "../members/members-model.js";
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
  // WHO IS STILL IN THIS SESSION, not who has ever been projected into it. The
  // partition's keys are every participant the log has named, including the ones whose
  // membership the log has since said ended — and a direct channel opened against one
  // of those can only be refused, so the picker would be offering an act with a known
  // answer. The membership fold is what makes the difference readable and
  // `members/members-model.ts` owns the predicate, so the two collaboration surfaces
  // that ask who is in the session take one answer rather than each deriving their own.
  const participantIds = useMemo(
    () => liveMembershipParticipantIds(participantEntities),
    [participantEntities],
  );
  // WHICH PARTICIPANT THIS WINDOW IS, through the console's one composition of that
  // question rather than a second implementation of it. The IDENTITY arm and not the
  // role-chained one: nothing on this surface gates on a role, because eligibility for
  // every act here is the daemon's answer and arrives as a refusal — so taking the
  // chained hook would subscribe this section to a roster partition it never reads.
  // The id off the store ONCE, so the read below and every callback beside it name the
  // same subject rather than each re-reading the store that holds it.
  const sessionId = sessionStore.sessionId;
  const caller = useCallerParticipantIdentity(bridge, sessionId);
  // The read arm and nothing else. A viewer that is still being read and one whose
  // read refused are both "not known", and the two surfaces below fail closed on that
  // in their own way rather than being handed a guess.
  const viewerParticipantId = caller?.status === "read" ? caller.participantId : undefined;
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
