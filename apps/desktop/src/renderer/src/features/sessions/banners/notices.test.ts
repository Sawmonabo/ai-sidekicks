// What each standing notice draws under the session header: the crash loop's four forms, the
// ignored-settings banner's shapes, a lost folder's two, and the restart that takes a crash loop's
// banner away until the next loop.

import { describe, expect, it } from "vitest";

import { eventOfKind } from "#test/helpers/session/events.js";
import type { FilePathRef } from "#shared/preload-api.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";

import { foldSessionNoticeBanners, sessionNoticeBannerWords } from "./notices.js";

const SESSION_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const MOUNT_ID = "019b7b30-0280-7c3d-8110-cca0117a0171";
const NEW_MOUNT_ID = "019b7b30-0280-7c3d-8110-cca0117a0172";
const CONFIG_FILE = "/Users/me/.codex/config.toml";
const CONFIG_FILE_REF = "file-ref-config" as FilePathRef;
const SESSION_FOLDER = "/Users/me/project";
const SETTINGS_FILE = `${SESSION_FOLDER}/.claude/settings.json`;

function notice(
  sequence: number,
  payload: Readonly<Record<string, unknown>>,
  fileRefs?: ProjectedSessionEvent["fileRefs"],
): ProjectedSessionEvent {
  const event = eventOfKind(SESSION_ID, "session.notice.posted", sequence, {
    sessionId: SESSION_ID,
    ...payload,
  });
  return fileRefs === undefined ? event : { ...event, fileRefs };
}

function mountHealth(
  sequence: number,
  health: Readonly<Record<string, unknown>>,
  repoMountId = MOUNT_ID,
) {
  return eventOfKind(SESSION_ID, "repoMount.health.changed", sequence, {
    repoMountId,
    health: { checkedAt: "2026-01-01T09:00:00Z", ...health },
  });
}

// Each banner's words as drawn, the provider named from its section, the lost folder's path as
// its mount read gave it, and a settings file named from whichever of the session's folders holds
// it and the home folder.
function drawn(events: readonly ProjectedSessionEvent[]): readonly string[] {
  return foldSessionNoticeBanners(events).map((banner) =>
    sessionNoticeBannerWords(banner, banner.kind === "folderLost" ? "" : "Codex", "/work/app", {
      sessionFolders: ["/Users/me/other-repo", SESSION_FOLDER],
      homeFolder: "/Users/me",
    }).join(" · "),
  );
}

describe("the banners a session's standing notices raise", () => {
  it("names the one cause a crash loop carries in each of its four forms", () => {
    const loop = (sequence: number, cause: Readonly<Record<string, unknown>>) =>
      notice(sequence, { kind: "providerCrashLoop", provider: "codex", ...cause });

    expect(drawn([loop(1, { exitCode: 137 })])).toStrictEqual([
      "Codex ended unexpectedly · exited with code 137",
    ]);
    expect(drawn([loop(1, { signal: "SIGKILL" })])).toStrictEqual([
      "Codex ended unexpectedly · killed by the system",
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
    expect(drawn([restarted, nextLoop])).toStrictEqual([
      "Codex ended unexpectedly · exited with code 2",
    ]);
  });

  it("says a signal in words, never by its name, and an unworded signal as a system signal", () => {
    const endedBy = (signal: string) =>
      drawn([notice(1, { kind: "providerCrashLoop", provider: "codex", signal })]);

    expect(endedBy("SIGTERM")).toStrictEqual(["Codex ended unexpectedly · told to stop"]);
    expect(endedBy("SIGSEGV")).toStrictEqual([
      "Codex ended unexpectedly · crashed on a memory error",
    ]);
    expect(endedBy("SIGRTMIN+3")).toStrictEqual([
      "Codex ended unexpectedly · stopped by a system signal",
    ]);
  });

  it("draws ignored settings by line, by file and key, by file alone, and by the words alone", () => {
    const ignored = (fields: Readonly<Record<string, unknown>>) =>
      notice(1, { kind: "settingsIgnored", provider: "codex", ...fields });
    const words = "Invalid configuration; using defaults";

    // A bad line names the file by its name; the full path is the token's.
    expect(drawn([ignored({ file: CONFIG_FILE, line: 4, text: words })])).toStrictEqual([
      "Codex ignored its config file · line 4 of config.toml",
    ]);
    // A dropped key or file names the file from the session's folder, else from `~`, else whole.
    expect(drawn([ignored({ file: SETTINGS_FILE, key: "permissions.defaultMode" })])).toStrictEqual(
      ["Codex ignored .claude/settings.json · permissions.defaultMode"],
    );
    expect(
      drawn([ignored({ file: "/Users/me/.claude/settings.json", text: words })]),
    ).toStrictEqual(["Codex ignored ~/.claude/settings.json"]);
    expect(drawn([ignored({ file: "/etc/claude/settings.json" })])).toStrictEqual([
      "Codex ignored /etc/claude/settings.json",
    ]);
    expect(drawn([ignored({ text: words })])).toStrictEqual([
      `Codex ignored its settings · ${words}`,
    ]);
  });

  it("opens the file by the token the frame carried for its full path, and none without one", () => {
    const ignoredFile = { kind: "settingsIgnored", provider: "codex", file: CONFIG_FILE };
    const [byFile] = foldSessionNoticeBanners([
      notice(1, ignoredFile, { [CONFIG_FILE]: CONFIG_FILE_REF }),
    ]);
    const [unminted] = foldSessionNoticeBanners([notice(1, ignoredFile)]);
    expect(byFile?.kind === "settingsIgnored" ? byFile.fileRef : "none").toBe(CONFIG_FILE_REF);
    expect(unminted?.kind === "settingsIgnored" ? unminted.fileRef : "none").toBeUndefined();
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

  it("takes the old mount's banner away once a re-attach's new mount reads healthy", () => {
    const mismatched = mountHealth(1, { status: "identityMismatch", isRepository: true });

    expect(drawn([mismatched, mountHealth(2, { status: "healthy" }, NEW_MOUNT_ID)])).toStrictEqual(
      [],
    );
    // Only the newest health speaks, whichever mount it names.
    expect(
      foldSessionNoticeBanners([
        mountHealth(1, { status: "healthy" }, NEW_MOUNT_ID),
        mountHealth(2, { status: "identityMismatch", isRepository: false }),
      ]),
    ).toMatchObject([{ kind: "folderLost", repoMountId: MOUNT_ID, isRepository: false }]);
  });
});
