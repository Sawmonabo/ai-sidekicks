// One clipboard as main drives it over Electron's: one write of every flavor a copy carries, its
// plain text, and the entries it holds with each text flavor's bytes. Each system reads its plain
// text and a held text flavor in its own fastest way, and takes a picture's PNG bytes as they are
// under its own type, so each system is a module of its own.

import { ClipboardItem } from "electron";

/**
 * The most one of main's tasks joins, compares, digests or decodes of a copy: code units of its
 * text, or bytes of what the clipboard holds. Measured in Node, a mebibyte takes well under a
 * millisecond for each.
 */
export const MAIN_TASK_CHUNK = 1_048_576;

/** Each flavor one copy writes, by its MIME type: text with its formatting, or a picture. */
export type ClipboardFlavors =
  | { readonly "text/plain": string; readonly "text/html"?: string }
  | { readonly "image/png": Blob };

/** One entry a clipboard holds: the types of its flavors, and a text flavor's bytes by its type. */
export interface HeldClipboardEntry {
  readonly types: readonly string[];
  /** The bytes of the text flavor `type` names, as UTF-8; rejects for a type the entry lacks. */
  read(type: string): Promise<Blob>;
}

/**
 * One clipboard over Electron's: writes one entry with one `ClipboardItem`, and reads its text and
 * the entries it holds.
 */
export interface ClipboardHost {
  write(flavors: ClipboardFlavors): Promise<void>;
  /** The plain text the clipboard holds now, empty when it holds none. */
  readText(): Promise<string>;
  readHeld(): Promise<readonly HeldClipboardEntry[]>;
}

/** The clipboards a copy may name: the system's, and the selection one only Linux keeps. */
export interface ClipboardHosts {
  readonly system: ClipboardHost;
  readonly selection: ClipboardHost | undefined;
}

/** What an operating system's clipboards are built from. */
export interface ClipboardOperatingSystem {
  /** The system's clipboard over one of Electron's, read and written in the system's own way. */
  readonly clipboardHost: (electronClipboard: Electron.Clipboard) => ClipboardHost;
  /** Whether the system keeps a primary selection, a clipboard of its own a middle-click pastes. */
  readonly hasPrimarySelection: boolean;
}

/**
 * `operatingSystem`'s clipboards over Electron's: the system one, and the selection one where the
 * system keeps a primary selection.
 */
export function clipboardHostsOn(
  operatingSystem: ClipboardOperatingSystem,
  electronClipboard: Electron.Clipboard,
): ClipboardHosts {
  return {
    system: operatingSystem.clipboardHost(electronClipboard),
    selection: operatingSystem.hasPrimarySelection
      ? operatingSystem.clipboardHost(electronClipboard.selection)
      : undefined,
  };
}

/** A held text flavor's bytes, read from Electron's entry by the system's own reading. */
export type HeldTextReading = (item: Electron.ClipboardItem, type: string) => Promise<Blob>;

/** How one system's clipboard is read, and the system's own type a picture's PNG bytes go under. */
export interface ClipboardSystem {
  readonly readHeldText: HeldTextReading;
  /** The plain text the clipboard holds now, empty when it holds none. */
  readonly readText: () => Promise<string>;
  readonly pictureFormat: string;
}

/** The type Electron reads and writes the system's own clipboard type `name` under, as is. */
export function rawClipboardFormat(name: string): string {
  return `electron application/osclipboard;format="${name}"`;
}

/** Electron's own reading of `electronClipboard`: the plain text as text, the rest by MIME type. */
export function electronTextReading(
  electronClipboard: Electron.Clipboard,
): Pick<ClipboardSystem, "readHeldText" | "readText"> {
  return {
    readHeldText: async (item, type) =>
      type === "text/plain"
        ? new Blob([await electronClipboard.readText()])
        : ((await item.getType(type)) as Blob),
    readText: () => electronClipboard.readText(),
  };
}

/**
 * `electronClipboard` as a `ClipboardHost` read as `system` reads it. A picture is written as its
 * PNG bytes under the system's own type, which Electron writes as they are; under `image/png`
 * Electron would decode the picture and encode it again, on main's thread.
 */
export function clipboardHostOver(
  electronClipboard: Electron.Clipboard,
  system: ClipboardSystem,
): ClipboardHost {
  return {
    write: (flavors) =>
      electronClipboard.write([
        new ClipboardItem(
          "image/png" in flavors
            ? { [rawClipboardFormat(system.pictureFormat)]: flavors["image/png"] }
            : { ...flavors },
        ),
      ]),
    readText: system.readText,
    readHeld: async () =>
      (await electronClipboard.read()).map((item) => ({
        types: item.types,
        read: (type) => system.readHeldText(item, type),
      })),
  };
}
