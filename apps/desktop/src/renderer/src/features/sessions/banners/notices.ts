// The banners the session's standing notices raise under its header: a provider caught in a crash
// loop until the person's restart brings it back, a provider that started without part of its
// settings, and a folder the session works in that is lost. Each is read from the newest event of
// its kind the session store keeps standing, so a banner outlasts the transcript window it arrived
// in. Pure: the events in, the banners out, and their words from the provider's name and the
// folder's path the caller read.

import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type { FilePathRef } from "#shared/preload-api.js";

import { isWireRecord } from "#renderer/lib/wire/record.js";
import { readWireString } from "#renderer/lib/wire/strings.js";
import { formatWholeDuration } from "#renderer/lib/wire/figures.js";
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
      readonly line: number | undefined;
      readonly key: string | undefined;
      readonly text: string | undefined;
      /** Main's token for `file`, which `Open the file` hands the editor; absent with no file. */
      readonly fileRef: FilePathRef | undefined;
    }
  | {
      readonly kind: "folderLost";
      readonly eventId: string;
      readonly repoMountId: string;
      readonly health: LostFolderHealth;
    };

/** Reads main's token for a path a notice names, or `undefined` where main minted none. */
export type NoticeFileRefReader = (
  event: ProjectedSessionEvent,
  path: string,
) => FilePathRef | undefined;

/**
 * The banners `standingEvents` raise, in the order their events arrived. A crash loop stands until
 * a later `providerRestarted` of its provider; a later crash loop raises its banner again.
 */
export function foldSessionNoticeBanners(
  standingEvents: readonly ProjectedSessionEvent[],
  fileRefOf: NoticeFileRefReader,
): readonly SessionNoticeBanner[] {
  const restartedAtByProvider = new Map<string, number>();
  for (const event of standingEvents) {
    const provider = readWireString(event.payload?.["provider"]);
    if (
      event.kind === SESSION_NOTICE_EVENT_KIND &&
      event.payload?.["kind"] === "providerRestarted" &&
      provider !== undefined
    ) {
      restartedAtByProvider.set(
        provider,
        Math.max(restartedAtByProvider.get(provider) ?? -1, event.sequence),
      );
    }
  }
  const banners: SessionNoticeBanner[] = [];
  for (const event of standingEvents) {
    const banner = readNoticeBanner(event, fileRefOf);
    if (
      banner?.kind === "crashLoop" &&
      (restartedAtByProvider.get(banner.provider) ?? -1) > event.sequence
    ) {
      continue;
    }
    if (banner !== undefined) {
      banners.push(banner);
    }
  }
  return banners;
}

/**
 * A banner's words in reading order, parted by ` · ` when drawn: `providerName` names the notice's
 * provider, and `folder` the lost folder's path, which a lost-folder banner waits for.
 */
export function sessionNoticeBannerWords(
  banner: SessionNoticeBanner,
  providerName: string,
  folder: string | undefined,
): readonly string[] {
  switch (banner.kind) {
    case "crashLoop":
      return crashLoopWords(banner.cause, providerName);
    case "settingsIgnored":
      return settingsIgnoredWords(banner, providerName);
    case "folderLost":
      if (folder === undefined) {
        return [];
      }
      return banner.health === "unreachable"
        ? [`${folder} can't be reached`, "new runs wait until it's back"]
        : [`${folder} is a different repository now`, "new runs are stopped"];
  }
}

function readNoticeBanner(
  event: ProjectedSessionEvent,
  fileRefOf: NoticeFileRefReader,
): SessionNoticeBanner | undefined {
  const payload = event.payload;
  if (event.kind === MOUNT_HEALTH_EVENT_KIND) {
    const repoMountId = readWireString(payload?.["repoMountId"]);
    const health = payload?.["health"];
    const status = isWireRecord(health) ? readWireString(health["status"]) : undefined;
    return repoMountId !== undefined && (status === "unreachable" || status === "identityMismatch")
      ? { kind: "folderLost", eventId: event.id, repoMountId, health: status }
      : undefined;
  }
  const provider = readWireString(payload?.["provider"]) as ProviderId | undefined;
  if (event.kind !== SESSION_NOTICE_EVENT_KIND || provider === undefined) {
    return undefined;
  }
  switch (payload?.["kind"]) {
    case "providerCrashLoop": {
      const cause = readCrashLoopCause(payload);
      return cause === undefined
        ? undefined
        : { kind: "crashLoop", eventId: event.id, provider, cause };
    }
    case "settingsIgnored": {
      const file = readWireString(payload["file"]);
      const line = payload["line"];
      return {
        kind: "settingsIgnored",
        eventId: event.id,
        provider,
        file,
        line: typeof line === "number" ? line : undefined,
        key: readWireString(payload["key"]),
        text: readWireString(payload["text"]),
        fileRef: file === undefined ? undefined : fileRefOf(event, file),
      };
    }
    default:
      return undefined;
  }
}

function readCrashLoopCause(
  payload: Readonly<Record<string, unknown>>,
): CrashLoopCause | undefined {
  const exitCode = payload["exitCode"];
  if (typeof exitCode === "number") {
    return { kind: "exitCode", exitCode };
  }
  const signal = readWireString(payload["signal"]);
  if (signal !== undefined) {
    return { kind: "signal", signal };
  }
  const silentSeconds = payload["silentSeconds"];
  if (typeof silentSeconds === "number") {
    return { kind: "silence", silentSeconds };
  }
  const startFailure = readWireString(payload["startFailure"]);
  return startFailure === undefined ? undefined : { kind: "startFailure", startFailure };
}

function crashLoopWords(cause: CrashLoopCause, providerName: string): readonly string[] {
  switch (cause.kind) {
    case "exitCode":
      return [`${providerName} ended unexpectedly`, `exit code ${String(cause.exitCode)}`];
    case "signal":
      return [`${providerName} ended unexpectedly`, `ended by ${cause.signal}`];
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
): readonly string[] {
  if (banner.file !== undefined && banner.line !== undefined) {
    return [
      `${providerName} ignored its config file`,
      `line ${String(banner.line)} of ${banner.file}`,
    ];
  }
  if (banner.file !== undefined) {
    return [
      `${providerName} ignored ${banner.file}`,
      ...(banner.key === undefined ? [] : [banner.key]),
    ];
  }
  // Naming no file, the provider's own words, or the key it named, say what it ignored.
  const named = banner.text ?? banner.key;
  return [`${providerName} ignored its settings`, ...(named === undefined ? [] : [named])];
}

// What a crash loop's banner names: exactly one of the four the notice carries.
type CrashLoopCause =
  | { readonly kind: "exitCode"; readonly exitCode: number }
  | { readonly kind: "signal"; readonly signal: string }
  | { readonly kind: "startFailure"; readonly startFailure: string }
  | { readonly kind: "silence"; readonly silentSeconds: number };

// How a lost folder is lost: gone from reach, or holding another repository.
type LostFolderHealth = "unreachable" | "identityMismatch";
