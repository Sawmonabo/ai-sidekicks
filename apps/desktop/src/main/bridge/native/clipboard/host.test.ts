// Each system reads its plain text and a held text flavor its own fastest way: macOS under the
// pasteboard's own type where the entry lists it, which Electron refuses where it does not, the
// plain text decoded a chunk at a time; Windows and Linux the plain text as Electron reads text.
// Each writes a picture's PNG bytes as they are under its own type.

import { describe, expect, it, vi } from "vitest";

import { MAIN_TASK_CHUNK } from "./host.js";
import { selectMainOperatingSystem } from "../../../operating-system/selection.js";

vi.mock("electron", () => ({
  ClipboardItem: class {
    public constructor(public readonly entries: Record<string, unknown>) {}
  },
}));

const NS_STRING = 'electron application/osclipboard;format="NSStringPboardType"';
const APPLE_HTML = 'electron application/osclipboard;format="Apple HTML pasteboard type"';

/**
 * An Electron clipboard holding one entry of `types`, each read as its own name, or as `bytesOf`
 * gives it.
 */
function holding(
  types: readonly string[],
  bytesOf: Readonly<Record<string, Blob>> = {},
): Electron.Clipboard {
  return {
    read: async () => [
      {
        types,
        getType: async (type: string) =>
          types.includes(type)
            ? (bytesOf[type] ?? new Blob([`read as ${type}`]))
            : Promise.reject(new Error(`The type '${type}' was not found in the ClipboardItem`)),
      },
    ],
    readText: async () => "read as text",
  } as unknown as Electron.Clipboard;
}

/** What the system clipboard reads for each of `flavors` of its one held entry. */
async function readsOf(
  platform: NodeJS.Platform,
  electronClipboard: Electron.Clipboard,
  flavors: readonly string[],
): Promise<string[]> {
  const [entry] = await selectMainOperatingSystem(platform)
    .clipboardHost(electronClipboard)
    .readHeld();
  const held = entry ?? expect.fail("the clipboard holds an entry");
  return await Promise.all(flavors.map(async (flavor) => (await held.read(flavor)).text()));
}

describe("a held text flavor's read", () => {
  it("is the pasteboard's own type on macOS where listed, else the flavor's MIME type", async () => {
    const twins = holding(["text/plain", "text/html", APPLE_HTML, NS_STRING]);
    const mimeOnly = holding(["text/plain", "text/html"]);

    await expect(readsOf("darwin", twins, ["text/plain", "text/html"])).resolves.toStrictEqual([
      `read as ${NS_STRING}`,
      `read as ${APPLE_HTML}`,
    ]);
    await expect(readsOf("darwin", mimeOnly, ["text/plain", "text/html"])).resolves.toStrictEqual([
      "read as text/plain",
      "read as text/html",
    ]);
  });

  it("is Electron's text read for plain text on Windows and Linux", async () => {
    const twins = holding(["text/plain", "text/html", APPLE_HTML, NS_STRING]);

    for (const platform of ["win32", "linux"] as const) {
      await expect(readsOf(platform, twins, ["text/plain", "text/html"])).resolves.toStrictEqual([
        "read as text",
        "read as text/html",
      ]);
    }
  });
});

describe("the plain text's read", () => {
  it("is decoded from the pasteboard's own type on macOS, a character a chunk cuts kept whole", async () => {
    // The dash's three bytes run across the first chunk's end.
    const text = `${"a".repeat(MAIN_TASK_CHUNK - 1)}—z`;
    const held = holding(["text/plain", NS_STRING], { [NS_STRING]: new Blob([text]) });

    await expect(selectMainOperatingSystem("darwin").clipboardHost(held).readText()).resolves.toBe(
      text,
    );
    await expect(
      selectMainOperatingSystem("darwin")
        .clipboardHost(holding(["image/png"]))
        .readText(),
    ).resolves.toBe("");
  });

  it("is Electron's text read on Windows and Linux", async () => {
    const held = holding(["text/plain", NS_STRING]);

    for (const platform of ["win32", "linux"] as const) {
      await expect(
        selectMainOperatingSystem(platform).clipboardHost(held).readText(),
      ).resolves.toBe("read as text");
    }
  });
});

describe("a copy's write", () => {
  it("puts a picture's PNG bytes under the system's own type as they are, and text by MIME type", async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])]);
    for (const [platform, pictureFormat] of [
      ["darwin", "public.png"],
      ["win32", "PNG"],
      ["linux", "image/png"],
    ] as const) {
      const written: unknown[] = [];
      const electronClipboard = {
        write: async (items: readonly unknown[]) => {
          written.push(...items);
        },
      } as unknown as Electron.Clipboard;
      const system = selectMainOperatingSystem(platform).clipboardHost(electronClipboard);

      await system.write({ "image/png": png });
      await system.write({ "text/plain": "a", "text/html": "<b>a</b>" });

      expect(written.map((item) => (item as { entries: unknown }).entries)).toStrictEqual([
        { [`electron application/osclipboard;format="${pictureFormat}"`]: png },
        { "text/plain": "a", "text/html": "<b>a</b>" },
      ]);
    }
  });
});
