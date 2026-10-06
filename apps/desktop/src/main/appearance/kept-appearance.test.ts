// The appearance record across a restart: a choice is written to `appearance.json`, read back
// before the next start's first window, and drives the platform scheme, the first frame's ground
// and the stamp on the served document's root. A missing, unreadable or broken file reads as the
// default appearance and never stops a start; a broken one is rewritten as it. A choice is in
// force only once written, the choices made during one write are written as their last, a View-menu
// pick never carries in a choice whose write failed, and a listener that throws stops nothing.

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APPEARANCE_RECORD,
  type AppearanceChoice,
  type AppearanceGrounds,
  type AppearanceRecord,
} from "#shared/appearance.js";
import type { MainDiagnosticEntry } from "../services/diagnostic-log.js";

import { KeptAppearance } from "./kept-appearance.js";
import { APPEARANCE_FILE_NAME, AppearanceRecordFile } from "./record-file.js";
import { stampRootElement } from "../services/root-stamp.js";

const CHOICE: AppearanceChoice = {
  theme: "graphite",
  scheme: "dark",
  textSize: 15,
  transcriptWidth: 44,
};
const GROUNDS: AppearanceGrounds = { light: "#f6f5f2", dark: "#17181a" };

let userData: string;
let filePath: string;
let logged: MainDiagnosticEntry[];

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "sidekicks-appearance-test-"));
  filePath = path.join(userData, APPEARANCE_FILE_NAME);
  logged = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await chmod(userData, 0o700);
  await rm(userData, { recursive: true, force: true });
});

/** A `nativeTheme` stand-in whose dark answer follows `themeSource`, the operating system light. */
function createNativeTheme(): { themeSource: string; shouldUseDarkColors: boolean; on(): void } {
  return {
    themeSource: "system",
    get shouldUseDarkColors(): boolean {
      return this.themeSource === "dark";
    },
    on: () => undefined,
  };
}

/** One start: the kept appearance read from this case's file, its reports in `logged`. */
function startApp(nativeTheme = createNativeTheme()): KeptAppearance {
  return new KeptAppearance({
    file: new AppearanceRecordFile({
      filePath,
      log: { write: (entry) => logged.push(entry) },
      now: () => new Date("2026-10-05T09:00:00.000Z"),
    }),
    nativeTheme: nativeTheme as never,
  });
}

/** One write a case settles by hand. */
interface HeldWrite {
  readonly record: AppearanceRecord;
  readonly land: () => void;
  readonly fail: (failure: Error) => void;
}

/** A kept appearance over a file whose every write waits in `writes` until the case settles it. */
function startOverHeldWrites(nativeTheme = createNativeTheme()) {
  const writes: HeldWrite[] = [];
  const appearance = new KeptAppearance({
    file: {
      readSync: () => DEFAULT_APPEARANCE_RECORD,
      write: (record) =>
        new Promise<void>((resolve, reject) => {
          writes.push({ record, land: resolve, fail: reject });
        }),
    },
    nativeTheme: nativeTheme as never,
  });
  let changes = 0;
  appearance.subscribe(() => {
    changes += 1;
  });
  return { appearance, writes, changeCount: () => changes };
}

describe("the appearance record", () => {
  it("is kept across a restart and drives the next start's first frame and stamp", async () => {
    await startApp().choose(CHOICE, GROUNDS);

    // Readable and writable only by the person.
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);

    const nativeTheme = createNativeTheme();
    const nextStart = startApp(nativeTheme);

    expect(nextStart.record).toStrictEqual({ ...CHOICE, grounds: GROUNDS });
    // Set before any window exists, so the first frame resolves the kept scheme.
    expect(nativeTheme.themeSource).toBe("dark");
    expect(nextStart.ground).toBe(GROUNDS.dark);

    const stamped = stampRootElement('<!doctype html><html lang="en"><head></head></html>', {
      record: nextStart.record,
      platformScheme: "dark",
      isSafeStart: false,
    });
    expect(stamped).toBe(
      '<!doctype html><html lang="en" data-theme="graphite" data-color-scheme="dark" ' +
        'data-resolved-color-scheme="dark" ' +
        'style="font-size:15px;--meridian-transcript-width:44rem"><head></head></html>',
    );
  });

  it("stamps no explicit scheme under system, so the stylesheet follows the system", async () => {
    await startApp().choose({ ...CHOICE, scheme: "system" }, GROUNDS);

    const stamped = stampRootElement("<html><body></body></html>", {
      record: startApp().record,
      platformScheme: "dark",
      isSafeStart: false,
    });

    expect(stamped).toBe(
      '<html data-theme="graphite" data-resolved-color-scheme="dark" ' +
        'style="font-size:15px;--meridian-transcript-width:44rem"><body></body></html>',
    );
  });

  it("reads a missing file as the default, and writes nothing until a choice", async () => {
    const nativeTheme = createNativeTheme();
    const appearance = startApp(nativeTheme);

    expect(appearance.record).toStrictEqual(DEFAULT_APPEARANCE_RECORD);
    expect(nativeTheme.themeSource).toBe("system");
    // The first frame is painted before any page has loaded, in the default theme's ground.
    expect(appearance.ground).toBe(DEFAULT_APPEARANCE_RECORD.grounds.light);
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(logged).toStrictEqual([]);
  });

  it.each([
    ["not JSON", "{ theme"],
    ["refused by the schema", JSON.stringify({ ...CHOICE, grounds: { light: "red", dark: "" } })],
    ["off the text sizes", JSON.stringify({ ...CHOICE, textSize: 17, grounds: GROUNDS })],
    [
      "past the widest transcript",
      JSON.stringify({ ...CHOICE, transcriptWidth: 75, grounds: GROUNDS }),
    ],
  ])("reads a file that is %s as the default, and rewrites it so", async (_case, fileText) => {
    await writeFile(filePath, fileText, "utf8");

    expect(startApp().record).toStrictEqual(DEFAULT_APPEARANCE_RECORD);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toStrictEqual(DEFAULT_APPEARANCE_RECORD);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(logged).toMatchObject([{ level: "warning", source: "main/appearance" }]);
  });

  it("reads a file it cannot read or repair as the default, logging it, never stopping a start", async () => {
    // A folder where the file belongs cannot be read as one, and is left as it is.
    await mkdir(filePath);
    expect(startApp().record).toStrictEqual(DEFAULT_APPEARANCE_RECORD);
    expect((await stat(filePath)).isDirectory()).toBe(true);

    // A broken file in a folder the person cannot write cannot be rewritten.
    await rm(filePath, { recursive: true });
    await writeFile(filePath, "{ theme", "utf8");
    await chmod(userData, 0o500);
    expect(startApp().record).toStrictEqual(DEFAULT_APPEARANCE_RECORD);

    expect(logged.map(({ level, source }) => ({ level, source }))).toStrictEqual([
      { level: "warning", source: "main/appearance" },
      { level: "error", source: "main/appearance" },
    ]);
  });
});

describe("a choice", () => {
  it("is in force only once written, and a run of quick ones is written as its first and last", async () => {
    const nativeTheme = createNativeTheme();
    const { appearance, writes, changeCount } = startOverHeldWrites(nativeTheme);

    const first = appearance.choose(CHOICE, GROUNDS);
    // Made while the first is written: the middle one is never written, and the View menu's pick
    // keeps the text size and width of the choice before it.
    const middle = appearance.choose({ ...CHOICE, textSize: 20 }, GROUNDS);
    const last = appearance.chooseScheme("light");

    expect(writes.map(({ record }) => record)).toStrictEqual([{ ...CHOICE, grounds: GROUNDS }]);
    expect(appearance.record).toStrictEqual(DEFAULT_APPEARANCE_RECORD);
    expect(nativeTheme.themeSource).toBe("system");
    expect(changeCount()).toBe(0);

    writes[0]?.land();
    await first;
    expect(appearance.record).toStrictEqual({ ...CHOICE, grounds: GROUNDS });
    expect(nativeTheme.themeSource).toBe("dark");
    expect(changeCount()).toBe(1);

    const lastRecord = { ...CHOICE, textSize: 20, scheme: "light", grounds: GROUNDS };
    expect(writes.map(({ record }) => record)).toStrictEqual([
      { ...CHOICE, grounds: GROUNDS },
      lastRecord,
    ]);
    writes[1]?.land();
    await Promise.all([middle, last]);
    expect(appearance.record).toStrictEqual(lastRecord);
    expect(changeCount()).toBe(2);
  });

  it("whose write fails is refused, and the record, the platform scheme and the listeners stand", async () => {
    const nativeTheme = createNativeTheme();
    const { appearance, writes, changeCount } = startOverHeldWrites(nativeTheme);

    const refused = appearance.chooseScheme("dark");
    writes[0]?.fail(new Error("no space left on device"));

    await expect(refused).rejects.toThrow("no space left on device");
    expect(appearance.record).toStrictEqual(DEFAULT_APPEARANCE_RECORD);
    expect(nativeTheme.themeSource).toBe("system");
    expect(changeCount()).toBe(0);

    // The next choice is written as usual.
    const next = appearance.chooseScheme("light");
    writes[1]?.land();
    await next;
    expect(appearance.scheme).toBe("light");
  });

  it("picked from the View menu during a write that fails is kept without the failed choice", async () => {
    const { appearance, writes } = startOverHeldWrites();

    const refused = appearance.choose({ ...CHOICE, textSize: 20 }, GROUNDS);
    const picked = appearance.chooseScheme("light");
    writes[0]?.fail(new Error("no space left on device"));
    await expect(refused).rejects.toThrow("no space left on device");

    // Built over the record kept, not over the choice the disk refused.
    const pickedRecord = { ...DEFAULT_APPEARANCE_RECORD, scheme: "light" };
    expect(writes[1]?.record).toStrictEqual(pickedRecord);
    writes[1]?.land();
    await picked;
    expect(appearance.record).toStrictEqual(pickedRecord);
  });

  it("is kept and heard by every listener when one listener throws", async () => {
    const { appearance, writes, changeCount } = startOverHeldWrites();
    const thrownLater: (() => void)[] = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      thrownLater.push(callback);
    });
    const listenerFailure = new Error("a window was already gone");
    appearance.subscribe(() => {
      throw listenerFailure;
    });
    let heardAfter = 0;
    appearance.subscribe(() => {
      heardAfter += 1;
    });

    const kept = appearance.choose(CHOICE, GROUNDS);
    writes[0]?.land();

    await expect(kept).resolves.toBeUndefined();
    expect(appearance.record).toStrictEqual({ ...CHOICE, grounds: GROUNDS });
    expect([changeCount(), heardAfter]).toStrictEqual([1, 1]);
    // The failure is not dropped: it is thrown again on its own task.
    expect(thrownLater).toHaveLength(1);
    expect(() => thrownLater[0]?.()).toThrow(listenerFailure);
  });
});
