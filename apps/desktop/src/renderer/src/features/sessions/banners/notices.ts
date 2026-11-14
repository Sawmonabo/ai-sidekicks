// The banners the session's standing notices raise under its header: a provider caught in a crash
// loop until the person's restart brings it back, a provider that started without part of its
// settings, and a folder the session works in that is lost. Each is read from the newest event of
// its kind the session store keeps standing, so a banner outlasts the transcript window it arrived
// in. Pure: the events in, the banners out, and their words from the provider's name, the
// folder's path and the places a settings file is named from that the caller read, and the line a
// refused press draws. A signal reads in words; its name stays in the daemon's log.

import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type {
  RepoMountHealth,
  RepoMountHealthChangedPayload,
} from "@ai-sidekicks/contracts/repo/mount";
import type { SessionNoticePostedPayload } from "@ai-sidekicks/contracts/session/controls/events";
import type { FilePathRef } from "#shared/preload-api.js";

import { refusalSentence } from "#renderer/lib/code-words.js";
import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { signalWords } from "#renderer/lib/signal-words.js";
import { formatWholeDuration, formatWireString } from "#renderer/lib/wire/figures.js";
import { readRepoMountHealthChangedPayload } from "#renderer/services/daemon/payload/repo-mount-health-changed.js";
import { readSessionNoticePostedPayload } from "#renderer/services/daemon/payload/session-notice-posted.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import {
  MOUNT_HEALTH_EVENT_KIND,
  SESSION_NOTICE_EVENT_KIND,
} from "#renderer/store/session/standing-events.js";

/** One banner a standing notice raises, by the event that raised it. */
export type SessionNoticeBanner =
  | {
      readonly kind: "crashLoop";
      readonly eventId: string;
      readonly provider: ProviderId;
      readonly cause: CrashLoopCause;
    }
  | {
      readonly kind: "settingsIgnored";
      readonly eventId: string;
      readonly provider: ProviderId;
      readonly file: string | undefined;
      /** The bad line, where the notice names one; a file named without one is named by path. */
      readonly line: number | undefined;
      readonly key: string | undefined;
      readonly text: string | undefined;
      /**
       * Main's token for `file`, which `Open the file` hands the editor; absent where the notice
       * names no file or main minted none.
       */
      readonly fileRef: FilePathRef | undefined;
    }
  | {
      readonly kind: "folderLost";
      readonly eventId: string;
      readonly repoMountId: string;
      readonly health: LostFolderHealth;
      /** Whether git still answers for a folder holding another repository, so it re-attaches. */
      readonly isRepository: boolean;
    };

/**
 * Where a settings file the session's provider ignored is named from: inside one of the session's
 * folders by its path there, inside the home folder from `~`, anywhere else whole. A place whose
 * read was refused is absent, so a file in it reads whole.
 */
export interface SettingsFilePlaces {
  readonly sessionFolders: readonly string[];
  readonly homeFolder?: string;
}

/**
 * The banners `standingEvents` raise, in the order their events arrived. A crash loop stands until
 * a later `providerRestarted` of its provider; a later crash loop raises its banner again. Each
 * mount's banner stands on that mount's own newest health, since a session can work in several
 * folders. A folder holding another repository that git still answers for is the one a re-attach
 * ends, so a later `healthy` of another mount, the re-attach's new one, takes its banner away.
 */
export function foldSessionNoticeBanners(
  standingEvents: readonly ProjectedSessionEvent[],
): readonly SessionNoticeBanner[] {
  const restartedAtByProvider = new Map<string, number>();
  const newestHealthSequenceByMount = new Map<string, number>();
  const newestHealthySequenceByMount = new Map<string, number>();
  // Each payload is read once: the first pass keeps what it raised beside the event's place.
  const raised: { readonly banner: SessionNoticeBanner; readonly sequence: number }[] = [];
  for (const event of standingEvents) {
    let banner: SessionNoticeBanner | undefined;
    if (event.kind === MOUNT_HEALTH_EVENT_KIND) {
      const changed = readRepoMountHealthChangedPayload(event.payload);
      if (changed !== undefined) {
        const { repoMountId } = changed;
        keepNewest(newestHealthSequenceByMount, repoMountId, event.sequence);
        if (changed.health.status === "healthy") {
          keepNewest(newestHealthySequenceByMount, repoMountId, event.sequence);
        }
        banner = folderLostBannerOf(event, changed);
      }
    } else if (event.kind === SESSION_NOTICE_EVENT_KIND) {
      const notice = readSessionNoticePostedPayload(event.payload);
      if (notice?.kind === "providerRestarted") {
        keepNewest(restartedAtByProvider, notice.provider, event.sequence);
      }
      banner = notice === undefined ? undefined : noticeBannerOf(event, notice);
    }
    if (banner !== undefined) {
      raised.push({ banner, sequence: event.sequence });
    }
  }
  return raised.flatMap(({ banner, sequence }): readonly SessionNoticeBanner[] => {
    if (banner.kind === "crashLoop") {
      return (restartedAtByProvider.get(banner.provider) ?? -1) > sequence ? [] : [banner];
    }
    if (banner.kind !== "folderLost") {
      return [banner];
    }
    const isSuperseded = (newestHealthSequenceByMount.get(banner.repoMountId) ?? -1) > sequence;
    const isReattached =
      banner.isRepository &&
      [...newestHealthySequenceByMount].some(
        ([repoMountId, healthyAt]) => repoMountId !== banner.repoMountId && healthyAt > sequence,
      );
    return isSuperseded || isReattached ? [] : [banner];
  });
}

/**
 * A banner's words in reading order, parted by ` · ` when drawn: `providerName` names the notice's
 * provider, `folder` the lost folder's path, which a lost-folder banner waits for, and
 * `settingsPlaces` where a settings file named by path is named from, which that banner waits for.
 */
export function sessionNoticeBannerWords(
  banner: SessionNoticeBanner,
  providerName: string,
  folder: string | undefined,
  settingsPlaces: SettingsFilePlaces | undefined,
): readonly string[] {
  switch (banner.kind) {
    case "crashLoop":
      return crashLoopWords(banner.cause, providerName);
    case "settingsIgnored":
      return settingsIgnoredWords(banner, providerName, settingsPlaces);
    case "folderLost":
      if (folder === undefined) {
        return [];
      }
      return banner.health === "unreachable"
        ? [`${folder} can't be reached`, "new runs wait until it's back"]
        : [`${folder} is a different repository now`, "new runs are stopped"];
  }
}

/** The line a refused banner press draws beside its word: the code's words, then the message. */
export function refusedLine(refusal: ExtendedRefusal): string {
  return refusalSentence(refusal.code, refusal.reason, formatWireString(refusal.detail));
}

function keepNewest(newest: Map<string, number>, key: string, sequence: number): void {
  newest.set(key, Math.max(newest.get(key) ?? -1, sequence));
}

function folderLostBannerOf(
  event: ProjectedSessionEvent,
  changed: RepoMountHealthChangedPayload,
): SessionNoticeBanner | undefined {
  const { health } = changed;
  return health.status === "healthy"
    ? undefined
    : {
        kind: "folderLost",
        eventId: event.id,
        repoMountId: changed.repoMountId,
        health: health.status,
        isRepository: health.status === "identityMismatch" && health.isRepository,
      };
}

function noticeBannerOf(
  event: ProjectedSessionEvent,
  notice: SessionNoticePostedPayload,
): SessionNoticeBanner | undefined {
  switch (notice.kind) {
    case "providerCrashLoop": {
      const cause = readCrashLoopCause(notice);
      return cause === undefined
        ? undefined
        : { kind: "crashLoop", eventId: event.id, provider: notice.provider, cause };
    }
    case "settingsIgnored": {
      const { file } = notice;
      return {
        kind: "settingsIgnored",
        eventId: event.id,
        provider: notice.provider,
        file,
        line: notice.line,
        key: notice.key,
        text: notice.text,
        fileRef: file === undefined ? undefined : event.fileRefs?.[file],
      };
    }
    default:
      return undefined;
  }
}

// The one cause a crash loop's notice carries, whichever of the four it is.
function readCrashLoopCause(
  notice: Extract<SessionNoticePostedPayload, { readonly kind: "providerCrashLoop" }>,
): CrashLoopCause | undefined {
  if (notice.exitCode !== undefined) {
    return { kind: "exitCode", exitCode: notice.exitCode };
  }
  if (notice.signal !== undefined) {
    return { kind: "signal", signal: notice.signal };
  }
  if (notice.silentSeconds !== undefined) {
    return { kind: "silence", silentSeconds: notice.silentSeconds };
  }
  return notice.startFailure === undefined
    ? undefined
    : { kind: "startFailure", startFailure: notice.startFailure };
}

function crashLoopWords(cause: CrashLoopCause, providerName: string): readonly string[] {
  switch (cause.kind) {
    case "exitCode":
      return [`${providerName} ended unexpectedly`, `exited with code ${String(cause.exitCode)}`];
    case "signal":
      return [`${providerName} ended unexpectedly`, signalWords(cause.signal)];
    case "startFailure":
      // The start's failure in one line: its first, as the daemon quoted it.
      return [`${providerName} could not start`, cause.startFailure.split("\n", 1)[0] ?? ""];
    case "silence":
      return [
        `${providerName} stopped answering`,
        `no reply for ${formatWholeDuration(cause.silentSeconds / 60, "minute")}`,
      ];
  }
}

function settingsIgnoredWords(
  banner: Extract<SessionNoticeBanner, { readonly kind: "settingsIgnored" }>,
  providerName: string,
  settingsPlaces: SettingsFilePlaces | undefined,
): readonly string[] {
  // A bad line names the file by its name; its full path is behind `Open the file`.
  if (banner.file !== undefined && banner.line !== undefined) {
    return [
      `${providerName} ignored its config file`,
      `line ${String(banner.line)} of ${fileNameOf(banner.file)}`,
    ];
  }
  // A dropped key or file names the file from the nearest place it sits in, once those are read.
  if (banner.file !== undefined) {
    if (settingsPlaces === undefined) {
      return [];
    }
    return [
      `${providerName} ignored ${shownSettingsPath(banner.file, settingsPlaces)}`,
      ...(banner.key === undefined ? [] : [banner.key]),
    ];
  }
  // Naming no file, the provider's own words, or the key it named, say what it ignored.
  const named = banner.text ?? banner.key;
  return [`${providerName} ignored its settings`, ...(named === undefined ? [] : [named])];
}

// A settings file's path from the session folder holding it, else from `~` for the home folder,
// else whole.
function shownSettingsPath(file: string, places: SettingsFilePlaces): string {
  for (const sessionFolder of places.sessionFolders) {
    const inSession = pathInside(file, sessionFolder);
    if (inSession !== undefined) {
      return inSession.rest;
    }
  }
  const inHome = pathInside(file, places.homeFolder);
  return inHome === undefined ? file : `~${inHome.separator}${inHome.rest}`;
}

// The part of `path` past `folder` and the separator after it, or `undefined` outside it.
function pathInside(
  path: string,
  folder: string | undefined,
): { readonly separator: string; readonly rest: string } | undefined {
  if (folder === undefined) {
    return undefined;
  }
  const root = folder.replace(/[/\\]+$/, "");
  const separator = path.charAt(root.length);
  return path.startsWith(root) && (separator === "/" || separator === "\\")
    ? { separator, rest: path.slice(root.length + 1) }
    : undefined;
}

// The last segment of a path, on either separator.
function fileNameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

// What a crash loop's banner names: exactly one of the four the notice carries.
type CrashLoopCause =
  | { readonly kind: "exitCode"; readonly exitCode: number }
  | { readonly kind: "signal"; readonly signal: string }
  | { readonly kind: "startFailure"; readonly startFailure: string }
  | { readonly kind: "silence"; readonly silentSeconds: number };

// How a lost folder is lost: gone from reach, or holding another repository.
type LostFolderHealth = Exclude<RepoMountHealth["status"], "healthy">;
