// What each standing notice draws under the session header: the crash loop's four forms, the
// ignored-settings banner's shapes, a lost folder's two, and the restart that takes a crash loop's
// banner away until the next loop.

import { describe, expect, it } from "vitest";

import { eventOfKind } from "#test/helpers/session/events.js";
import type { FilePathRef } from "#shared/preload-api.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";

import { foldSessionNoticeBanners, sessionNoticeBannerWords } from "./notices.js";

const SESSION_ID = "session-banners";
const CONFIG_FILE = "/Users/me/.codex/config.toml";
const CONFIG_FILE_REF = "file-ref-config" as FilePathRef;

function notice(sequence: number, payload: Readonly<Record<string, unknown>>) {
  return eventOfKind(SESSION_ID, "session.notice.posted", sequence, {
    sessionId: SESSION_ID,
    ...payload,
  });
}

function mountHealth(sequence: number, health: Readonly<Record<string, unknown>>) {
  return eventOfKind(SESSION_ID, "repoMount.health.changed", sequence, {
    repoMountId: "mount-1",
    health: { checkedAt: "2026-01-01T09:00:00Z", ...health },
  });
}

// Each banner's words as drawn, the provider named from its section and the lost folder's path
// as its mount read gave it.
function drawn(events: readonly ProjectedSessionEvent[]): readonly string[] {
  return foldSessionNoticeBanners(events, (_event, path) =>
    path === CONFIG_FILE ? CONFIG_FILE_REF : undefined,
  ).map((banner) =>
    sessionNoticeBannerWords(banner, banner.kind === "folderLost" ? "" : "Codex", "/work/app").join(
      " · ",
    ),
  );
}

describe("the banners a session's standing notices raise", () => {
  it("names the one cause a crash loop carries in each of its four forms", () => {
    const loop = (sequence: number, cause: Readonly<Record<string, unknown>>) =>
      notice(sequence, { kind: "providerCrashLoop", provider: "codex", ...cause });

    expect(drawn([loop(1, { exitCode: 137 })])).toStrictEqual([
      "Codex ended unexpectedly · exit code 137",
    ]);
    expect(drawn([loop(1, { signal: "SIGKILL" })])).toStrictEqual([
      "Codex ended unexpectedly · ended by SIGKILL",
    ]);
    expect(drawn([loop(1, { startFailure: "spawn codex ENOENT\nat start" })])).toStrictEqual([
      "Codex could not start · spawn codex ENOENT",
    ]);
    expect(drawn([loop(1, { silentSeconds: 120 })])).toStrictEqual([
      "Codex stopped answering · no reply for 2 minutes",
    ]);
  });

  it("takes a crash loop's banner away at the restart and draws the next loop's again", () => {
    const loop = notice(1, { kind: "providerCrashLoop", provider: "codex", exitCode: 1 });
    const restarted = notice(2, { kind: "providerRestarted", provider: "codex" });
    const nextLoop = notice(3, { kind: "providerCrashLoop", provider: "codex", exitCode: 2 });

    expect(drawn([loop, restarted])).toStrictEqual([]);
    expect(drawn([restarted, nextLoop])).toStrictEqual(["Codex ended unexpectedly · exit code 2"]);
  });

  it("draws ignored settings by line, by file and key, by file alone, and by the words alone", () => {
    const ignored = (fields: Readonly<Record<string, unknown>>) =>
      notice(1, { kind: "settingsIgnored", provider: "codex", ...fields });
    const words = "Invalid configuration; using defaults";

    expect(drawn([ignored({ file: CONFIG_FILE, line: 4, text: words })])).toStrictEqual([
      `Codex ignored its config file · line 4 of ${CONFIG_FILE}`,
    ]);
    expect(drawn([ignored({ file: CONFIG_FILE, key: "model" })])).toStrictEqual([
      `Codex ignored ${CONFIG_FILE} · model`,
    ]);
    expect(drawn([ignored({ file: CONFIG_FILE, text: words })])).toStrictEqual([
      `Codex ignored ${CONFIG_FILE}`,
    ]);
    expect(drawn([ignored({ text: words })])).toStrictEqual([
      `Codex ignored its settings · ${words}`,
    ]);
    // The file's token is the one main minted for that path, and a notice naming no file has none.
    const [byFile] = foldSessionNoticeBanners(
      [ignored({ file: CONFIG_FILE })],
      () => CONFIG_FILE_REF,
    );
    const [byWords] = foldSessionNoticeBanners([ignored({ text: words })], () => CONFIG_FILE_REF);
    expect(byFile?.kind === "settingsIgnored" ? byFile.fileRef : "none").toBe(CONFIG_FILE_REF);
    expect(byWords?.kind === "settingsIgnored" ? byWords.fileRef : "none").toBeUndefined();
  });

  it("draws a lost folder while it is lost and nothing once it is healthy", () => {
    expect(drawn([mountHealth(1, { status: "unreachable" })])).toStrictEqual([
      "/work/app can't be reached · new runs wait until it's back",
    ]);
    expect(
      drawn([mountHealth(1, { status: "identityMismatch", isRepository: true })]),
    ).toStrictEqual(["/work/app is a different repository now · new runs are stopped"]);
    expect(drawn([mountHealth(1, { status: "healthy" })])).toStrictEqual([]);
  });
});
