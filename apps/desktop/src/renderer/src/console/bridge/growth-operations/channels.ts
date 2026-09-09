// The channel plane's ledger rows: the four lifecycle verbs, and the roster read
// that carries what `channel.list` does not.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`. The section
// comment below is the single table's own, kept with the rows it heads.
//
// WHY THESE ROWS EXIST AT ALL, GIVEN `channel.list` IS LIVE. The directory read is
// registered and the console calls it directly; nothing here duplicates it. What is
// missing is everything BESIDE it — the four verbs that change a channel's lifecycle
// state, and the roster read that says which audience a channel has, whether it is a
// `direct` channel, and which two humans its immutable pair names. All five are
// registered in `api-payload-contracts.md §Plan-016` and in no code package, so no
// bridge namespace serves them and every one refuses by name until its wire lands.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries, DERIVED from the id union rather than listed again.
 *
 * `Extract` against the plane's own name pattern is what makes the annotation below
 * exhaustive in both directions: a row this plane owns and forgot fails here, and a
 * key that is not an operation id fails here too.
 */
type ChannelOperationId = Extract<GrowthOperationId, `channel${string}`>;

/** The channel rows, in the order the registry carries them. */
export const CHANNEL_GROWTH_OPERATIONS: Readonly<Record<ChannelOperationId, GrowthOperationEntry>> =
  {
    // The four lifecycle verbs. Each names its registered wire method, because
    // `api-payload-contracts.md §Plan-016` registers all four strings — the transcription
    // `growth-operations/index.test.ts` holds to the id-folds-to-method rule.
    //
    // MUTE IS A CHANNEL VERB AND NEVER A NOTIFICATION CONTROL. `channel.mute` moves the
    // channel's own lifecycle state for every member of the session; the per-participant
    // notification mute `Spec-019` governs is global and has no per-channel form at all.
    // A surface that offered this control as "quieten this for me" would be promising a
    // scope the wire does not have.
    channelCreate: op("channelCreate", "channel-lifecycle-verbs", "method", "channel.create"),
    channelMute: op("channelMute", "channel-lifecycle-verbs", "method", "channel.mute"),
    channelUnmute: op("channelUnmute", "channel-lifecycle-verbs", "method", "channel.unmute"),
    channelArchive: op("channelArchive", "channel-lifecycle-verbs", "method", "channel.archive"),
    // The roster read, which is a DIFFERENT read from `channel.list` rather than a
    // richer version of it: the directory read is Plan-002's control-plane projection
    // and this is Plan-016's daemon-native session-local roster, carrying the three
    // members the directory reply has never had.
    channelRosterRead: op(
      "channelRosterRead",
      "channel-roster-read",
      "method",
      "channel.rosterRead",
    ),
  };
