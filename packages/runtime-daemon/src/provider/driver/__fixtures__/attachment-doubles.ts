// A stand-in for the daemon's attachment resolver: it binds the ids it was given files for and
// marks every other id deleted in its own place, as the real one does for a manifest that is gone.

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { AttachmentResolver, ProviderAttachment, ResolvedAttachment } from "../attachments.js";

/** A resolver over a fixed set of stored files. */
export class FakeAttachmentResolver implements AttachmentResolver {
  readonly #filesById: ReadonlyMap<ArtifactId, ResolvedAttachment>;

  constructor(files: readonly ResolvedAttachment[] = []) {
    this.#filesById = new Map(files.map((file) => [file.artifactId, file]));
  }

  async resolveAttachments(
    _sessionId: SessionId,
    artifactIds: readonly ArtifactId[],
  ): Promise<ProviderAttachment[]> {
    await Promise.resolve();
    return artifactIds.map(
      (artifactId) =>
        this.#filesById.get(artifactId) ?? { kind: "unresolved", artifactId, cause: "deleted" },
    );
  }
}

/** The three files the attachment tests stage: a picture, a text file, and one since deleted. */
export const STAGED_ATTACHMENT_IDS = {
  picture: "01890a5d-ac96-774b-bcce-b302099a8057" as ArtifactId,
  textFile: "01890a5d-ac96-774b-bcce-b302099a8058" as ArtifactId,
  deleted: "01890a5d-ac96-774b-bcce-b302099a8059" as ArtifactId,
} as const;

/** A 1×1 transparent PNG, the smallest picture a provider's image input takes. */
export const ONE_PIXEL_PNG: Buffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==",
  "base64",
);

/** The picture and text file of {@link STAGED_ATTACHMENT_IDS}, stored under `folder`. */
export function stagedFiles(folder: string): readonly ResolvedAttachment[] {
  return [
    {
      kind: "resolved",
      artifactId: STAGED_ATTACHMENT_IDS.picture,
      path: `${folder}/picture`,
      fileName: "screenshot.png",
      mediaType: "image/png",
    },
    {
      kind: "resolved",
      artifactId: STAGED_ATTACHMENT_IDS.textFile,
      path: `${folder}/notes`,
      fileName: "notes.txt",
      mediaType: "text/plain",
    },
  ];
}
