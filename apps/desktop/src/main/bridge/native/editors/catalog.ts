// Every editor `Editor that opens files` lists, in the order it lists them, with what main needs
// to find each one on macOS and to open a file there at a line. Each bundle identifier, app name
// and bundled command is the one the editor's own Homebrew cask records.

/**
 * How an editor opens a file at a line on macOS. `bundledCommand` runs the command the app bundle
 * ships, at the first of its relative paths that exists, with the file and line in the form named
 * (`goto`: `--goto <file>:<line>`; `pathAtLine`: `<file>:<line>`); `jetbrains` passes
 * `--line <line> <file>` to the app; `xed` runs the `xed` command the found Xcode ships.
 */
export type MacLineLaunch =
  | {
      readonly kind: "bundledCommand";
      readonly relativePaths: readonly string[];
      readonly lineForm: "goto" | "pathAtLine";
    }
  | { readonly kind: "jetbrains" }
  | { readonly kind: "xed" };

/**
 * One editor main looks for: its id, which the machine's settings file keeps as `editorId`; the
 * name the list reads; its macOS bundle identifiers, the first one found winning; and how it opens
 * at a line there, absent where the editor takes no line from outside.
 */
export interface EditorDefinition {
  readonly id: string;
  readonly label: string;
  readonly macBundleIds: readonly string[];
  readonly macLineLaunch?: MacLineLaunch;
}

/** The VS Code command every fork ships at the same place in its bundle. */
const VS_CODE_COMMAND = "Contents/Resources/app/bin/code";

const JETBRAINS_LINE_LAUNCH: MacLineLaunch = { kind: "jetbrains" };

/** Every editor the console looks for, in list order. */
export const EDITOR_CATALOG: readonly EditorDefinition[] = [
  {
    id: "vscode",
    label: "Visual Studio Code",
    macBundleIds: ["com.microsoft.VSCode"],
    macLineLaunch: { kind: "bundledCommand", relativePaths: [VS_CODE_COMMAND], lineForm: "goto" },
  },
  {
    id: "vscode-insiders",
    label: "Visual Studio Code - Insiders",
    macBundleIds: ["com.microsoft.VSCodeInsiders"],
    macLineLaunch: { kind: "bundledCommand", relativePaths: [VS_CODE_COMMAND], lineForm: "goto" },
  },
  {
    id: "cursor",
    label: "Cursor",
    macBundleIds: ["com.todesktop.230313mzl4w4u92"],
    macLineLaunch: { kind: "bundledCommand", relativePaths: [VS_CODE_COMMAND], lineForm: "goto" },
  },
  {
    // One entry under its own command and under the one an install that has not updated from
    // Windsurf still carries; both keep Windsurf's bundle identifier.
    id: "devin-desktop",
    label: "Devin Desktop",
    macBundleIds: ["com.exafunction.windsurf"],
    macLineLaunch: {
      kind: "bundledCommand",
      relativePaths: [
        "Contents/Resources/app/bin/devin-desktop",
        "Contents/Resources/app/bin/windsurf",
      ],
      lineForm: "goto",
    },
  },
  {
    id: "vscodium",
    label: "VSCodium",
    macBundleIds: ["com.vscodium"],
    macLineLaunch: {
      kind: "bundledCommand",
      relativePaths: ["Contents/Resources/app/bin/codium"],
      lineForm: "goto",
    },
  },
  {
    id: "sublime-text",
    label: "Sublime Text",
    macBundleIds: ["com.sublimetext.4", "com.sublimetext.3"],
    macLineLaunch: {
      kind: "bundledCommand",
      relativePaths: ["Contents/SharedSupport/bin/subl"],
      lineForm: "pathAtLine",
    },
  },
  {
    id: "zed",
    label: "Zed",
    macBundleIds: ["dev.zed.Zed"],
    macLineLaunch: {
      kind: "bundledCommand",
      relativePaths: ["Contents/MacOS/cli"],
      lineForm: "pathAtLine",
    },
  },
  {
    id: "xcode",
    label: "Xcode",
    macBundleIds: ["com.apple.dt.Xcode"],
    macLineLaunch: { kind: "xed" },
  },
  {
    id: "intellij-idea",
    label: "IntelliJ IDEA",
    macBundleIds: ["com.jetbrains.intellij", "com.jetbrains.intellij.ce"],
    macLineLaunch: JETBRAINS_LINE_LAUNCH,
  },
  {
    id: "webstorm",
    label: "WebStorm",
    macBundleIds: ["com.jetbrains.WebStorm"],
    macLineLaunch: JETBRAINS_LINE_LAUNCH,
  },
  {
    id: "pycharm",
    label: "PyCharm",
    macBundleIds: ["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"],
    macLineLaunch: JETBRAINS_LINE_LAUNCH,
  },
  {
    id: "goland",
    label: "GoLand",
    macBundleIds: ["com.jetbrains.goland"],
    macLineLaunch: JETBRAINS_LINE_LAUNCH,
  },
  {
    id: "clion",
    label: "CLion",
    macBundleIds: ["com.jetbrains.CLion"],
    macLineLaunch: JETBRAINS_LINE_LAUNCH,
  },
  {
    id: "rubymine",
    label: "RubyMine",
    macBundleIds: ["com.jetbrains.rubymine"],
    macLineLaunch: JETBRAINS_LINE_LAUNCH,
  },
  {
    id: "phpstorm",
    label: "PhpStorm",
    macBundleIds: ["com.jetbrains.PhpStorm"],
    macLineLaunch: JETBRAINS_LINE_LAUNCH,
  },
  {
    id: "rider",
    label: "Rider",
    macBundleIds: ["com.jetbrains.rider"],
    macLineLaunch: JETBRAINS_LINE_LAUNCH,
  },
  {
    id: "rustrover",
    label: "RustRover",
    macBundleIds: ["com.jetbrains.rustrover"],
    macLineLaunch: JETBRAINS_LINE_LAUNCH,
  },
  { id: "nova", label: "Nova", macBundleIds: ["com.panic.Nova"] },
  { id: "bbedit", label: "BBEdit", macBundleIds: ["com.barebones.bbedit"] },
  { id: "emacs", label: "Emacs", macBundleIds: ["org.gnu.Emacs"] },
  // A Windows editor: listed everywhere, and never found on macOS.
  { id: "notepad-plus-plus", label: "Notepad++", macBundleIds: [] },
];

/** The catalog entry an `editorId` names, or `undefined` for an id the catalog does not hold. */
export function findEditor(editorId: string): EditorDefinition | undefined {
  return EDITOR_CATALOG.find((editor) => editor.id === editorId);
}
