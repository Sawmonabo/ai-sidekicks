// The roster read itself: when it is asked, and what makes it ask again.
//
// WHAT THIS READ IS. `channel.list` carries `{id, name?, state, participantCount}`, so
// three facts a row wears come from somewhere else — what a channel is FOR, which kind
// it is, and which two humans a `direct` one is between. `channel-roster.ts` beside this
// file is what those three become on screen; this is the call that fetches them.
//
// WHY IT IS NO LONGER ASKED ONCE. It was, through `seats/growth-read.ts`, whose whole
// contract is one read per subject — and the subject is the SESSION, which does not move
// when a channel is created in it. So a person who created a direct channel while the
// list stayed mounted watched the row arrive from the directory's own re-read and then
// sit there wearing its typed name instead of its member pair, with no audience badge,
// until something unmounted the section. The directory had moved and its enrichment had
// not, and nothing on screen said which of the two was stale.
//
// THAT SEAT SAYS WHERE SUCH A READ GOES: `store/scheduling.ts`, the console's refresh
// chokepoint, reached through `seats/push-driven-read.ts`. So this read takes the same
// five-part discipline every live read here takes — subscribe before reading, an opaque
// signal, one read per burst, no stale reply winning, and no flicker back to the unread
// shape while a refresh is in flight — and it is a `PushDrivenRead` like the directory
// beside it rather than a second mechanism with a timer in it.
//
// AND THE PUSH IS THE DIRECTORY. This read subscribes to no stream of its own, and that
// is a finding rather than an omission: `channel.rosterRead` is registered on no wire in
// this build, and no event payload anywhere in the census carries an audience — a
// `channel.created` frame is `{channelId, name?}` — so nothing the daemon emits announces
// that a channel's audience has changed. What DOES announce it is the directory: it is
// push-driven off the four `channel.*` kinds, and a channel this read has never been
// told about is exactly a row whose three facts are missing. So the trigger is the
// directory's own channel set moving, delivered as a prop by the list that holds both.
//
// WHICH IS WHY THE TRIGGER IS AN EDGE AND NOT A GAP. "The roster does not name every row
// the directory carries" is an ORDINARY state — a row the roster did not name renders
// without a badge, which is the enrichment's whole posture — so a refresh keyed on that
// difference would re-ask forever against a daemon that answers the same way each time.
// Keyed on the directory's set CHANGING, it asks exactly once per change and never
// otherwise: a mute, an unmute and an archive move a row's state and not the set, so
// they re-read nothing at all.
//
// AND AN EDGE NEEDS A BASELINE THAT IS TRUE, WHICH IS WHY THE READ WAITS. The rule, once:
// THE FIRST DIRECTORY ANSWER IS THE BASELINE BECAUSE THIS READ IS ISSUED AFTER IT, and
// never merely because it arrived first. Asked at the mount instead, this read could
// settle BEFORE the directory's own first reply — two calls put at the same moment answer
// in whichever order the daemon chooses — and a channel created in the gap between them is
// in that first directory answer and absent from the roster snapshot beside it. Taken as a
// baseline anyway, the row sat unenriched until some later channel-set change happened to
// ask again. So the mount opens nothing: the first read is issued when the directory's
// first answer arrives, which makes the reply strictly newer than that answer rather than
// racing it, and every set after it is an edge measured against a baseline the read has
// actually seen. Deferring costs no update, because the only producer of the signal below
// is `observeDirectory` itself and it emits nothing before that first read is asked — the
// seat's rule 1 is a subscription taken before a read can MISS something, and there is
// nothing here to miss.

import { useCallback, useEffect } from "react";

import type { ChannelListResponseChannel } from "@ai-sidekicks/contracts";

import {
  consoleClockFor,
  type ConsoleBridge,
  type GrowthChannelRosterEntry,
} from "../../bridge/index.js";
import { Emitter, type ConsoleClock } from "../../core/index.js";
import {
  PushDrivenRead,
  servedGrowthValueOrRaise,
  usePushDrivenRead,
  type PushDrivenReadState,
} from "../../seats/index.js";
import { useSubjectScopedResource, type SubjectScopedDisposal } from "../../store/index.js";

/** Names this read in a refusal the call itself did not name. */
export const CHANNEL_ROSTER_ORIGIN = "channel-roster";

/**
 * What the list holds for the roster at any moment.
 *
 * `undefined` on the served arm is the answer for a list addressed at no session: the
 * read IS the one this surface holds either way — a hook cannot be called conditionally
 * — and an empty entry list would say the daemon answered and named nothing, which is a
 * different claim from nobody having asked.
 */
export type ChannelRosterState = PushDrivenReadState<
  readonly GrowthChannelRosterEntry[] | undefined
>;

/**
 * The roster for one session, re-asked when the directory beside it moves.
 *
 * A class because it owns two things with lifetimes — the push-driven read and the
 * signal that drives it — and one piece of state, which set of channels was on screen
 * when this read was last asked. `apps/desktop/AGENTS.md` puts exactly that in a class
 * with private fields rather than in a ref inside a render body.
 */
export class ChannelRosterRead {
  readonly #model: PushDrivenRead<readonly GrowthChannelRosterEntry[] | undefined>;
  /**
   * The signal the read subscribes to, emitted by {@link observeDirectory}.
   *
   * An emitter rather than a direct `refresh()` call, so the read is wired exactly as
   * every other live read is — subscribe first, then read — and the seat's own rule 1
   * is met by a real subscription rather than waived for this one.
   */
  readonly #directoryChanges = new Emitter<void>("channel directory change");
  #askedForChannelKey: string | undefined;
  /**
   * Whether the mount has asked this read to run.
   *
   * Held apart from the model's own started reading because the two are different
   * facts here: the mount says a surface wants this read, and the baseline says the
   * read may be issued. The model opens on the LATER of the two, whichever arrives
   * second, so neither ordering of mount and first directory answer opens it early.
   */
  #isMounted = false;

  public constructor(options: {
    readonly bridge: ConsoleBridge;
    readonly sessionId: string | undefined;
    readonly clock: ConsoleClock;
  }) {
    const { bridge, sessionId, clock } = options;
    this.#model = new PushDrivenRead<readonly GrowthChannelRosterEntry[] | undefined>({
      clock,
      origin: CHANNEL_ROSTER_ORIGIN,
      read: async () =>
        sessionId === undefined
          ? undefined
          : servedGrowthValueOrRaise(await bridge.growth.channelRosterRead({ sessionId })),
      subscribe: (onChangeSignal) => this.#directoryChanges.subscribe(onChangeSignal),
    });
  }

  /**
   * The model React renders from.
   *
   * Handed over rather than mirrored: `usePushDrivenRead` is the seat's own binding, and
   * a second reading of one state here is the copy this console does not keep anywhere.
   */
  public get model(): PushDrivenRead<readonly GrowthChannelRosterEntry[] | undefined> {
    return this.#model;
  }

  /**
   * Say the surface wants this read. The first call goes out once a baseline exists.
   *
   * Nothing is asked while the directory has not answered: this read's answer has to
   * be newer than the directory answer it is baselined against, and a read issued at
   * the mount is only racing it.
   */
  public start(): void {
    this.#isMounted = true;
    this.#openOnceBaselined();
  }

  /** Release the read. Terminal, and the signal goes with it. */
  public dispose(): void {
    this.#model.dispose();
  }

  /** Whether {@link dispose} has run, for the resource seam that re-mints a corpse. */
  public get isDisposed(): boolean {
    return this.#model.isDisposed;
  }

  /**
   * Take the directory as it stands: baseline the read, or ask again where it moved.
   *
   * `undefined` is the directory that has not answered yet, and it is observed as
   * NOTHING rather than as an empty set: treating it as one would baseline this read
   * against a set the directory never served, and the first real answer would then be a
   * change against a claim nobody made.
   *
   * The FIRST set this sees is the baseline, and it is the one that ISSUES the first
   * read — which is what makes it a baseline rather than an assumption, since the reply
   * to a read issued here cannot predate the answer it is measured against. Every set
   * after it that differs asks once more. The key is the ids in the order the directory
   * serves them, so a re-order is a change too — which is honest, since the roster is
   * keyed by id and a directory that re-ordered has been re-read.
   */
  public observeDirectory(channels: readonly ChannelListResponseChannel[] | undefined): void {
    if (channels === undefined) {
      return;
    }
    const channelKey = channels.map((channel) => channel.id).join("\n");
    const previousKey = this.#askedForChannelKey;
    this.#askedForChannelKey = channelKey;
    if (previousKey === undefined) {
      this.#openOnceBaselined();
      return;
    }
    if (previousKey === channelKey) {
      return;
    }
    this.#directoryChanges.emit();
  }

  /**
   * Open the subscription and ask the first time, once both halves have arrived.
   *
   * Idempotent through the model, which is what lets both callers reach it without
   * either one having to know whether the other has run.
   */
  #openOnceBaselined(): void {
    if (!this.#isMounted || this.#askedForChannelKey === undefined) {
      return;
    }
    this.#model.start();
  }
}

/**
 * The read's own disposal, as one module-level object.
 *
 * Minted once rather than in a render body, because the resource seam holds `dispose`
 * and `isClosed` on dependencies of their own and a fresh literal each pass would
 * restart the lifetime beneath it.
 */
const CHANNEL_ROSTER_DISPOSAL: SubjectScopedDisposal<ChannelRosterRead> = {
  dispose: (read) => {
    read.dispose();
  },
  isClosed: (read) => read.isDisposed,
};

/**
 * Read the roster for one session, kept current with the directory it enriches.
 *
 * Held through the resource seam rather than a `useMemo` and a cleanup: this read owns a
 * subscription and a scheduler, so it is exactly the class of value that seam exists to
 * close exactly once — including under a session switch beneath a live mount.
 */
export function useChannelRoster(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
  directoryChannels: readonly ChannelListResponseChannel[] | undefined,
): ChannelRosterState {
  // Resolved inside the resource's own `open`, which runs once per subject: the live
  // arm of `consoleClockFor` MINTS, so reading it in a render body would hand this
  // `dispose()`-bearing read a fresh clock identity on every pass.
  const openRead = useCallback(
    () => new ChannelRosterRead({ bridge, sessionId, clock: consoleClockFor(bridge) }),
    [bridge, sessionId],
  );
  const { value: read } = useSubjectScopedResource(
    bridge,
    sessionId,
    openRead,
    CHANNEL_ROSTER_DISPOSAL,
  );
  useEffect(() => {
    // In an effect and not in the render body: `start` opens the signal and, once the
    // directory below has answered, puts a call on the wire — and a render React
    // discards must do neither.
    read.start();
  }, [read]);
  useEffect(() => {
    // BELOW the mount effect on purpose, so a first render that already carries the
    // directory's answer opens the read in this same commit rather than in the next
    // one: effects run in order, so the mount has recorded itself by the time this runs.
    read.observeDirectory(directoryChannels);
  }, [read, directoryChannels]);
  return usePushDrivenRead(read.model);
}
