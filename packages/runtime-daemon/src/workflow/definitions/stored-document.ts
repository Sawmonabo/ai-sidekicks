// A workflow document rebuilt from the columns that store it: the canonical hashed body, and
// beside it the layout, pinned data and tags that sit outside the hash.
import {
  WORKFLOW_DOCUMENT_SCHEMA_VERSION,
  type WorkflowDocument,
  type WorkflowDocumentHashedBody,
  type WorkflowLayout,
  type WorkflowPinnedItem,
} from "@ai-sidekicks/contracts/workflow/definition/document";

/** The stored columns a document is rebuilt from; pinned data and tags live on the definition. */
export interface StoredWorkflowDocumentColumns {
  readonly definitionBody: string;
  readonly layoutJson: string | null;
  readonly pinDataJson?: string | null;
  readonly tagsJson?: string;
}

/**
 * Parses a stored canonical body, which the store wrote from a checked document.
 *
 * @consumedBy the version chain and version difference reads
 */
export function parseStoredWorkflowBody(definitionBody: string): WorkflowDocumentHashedBody {
  return JSON.parse(definitionBody) as WorkflowDocumentHashedBody;
}

/**
 * Rebuilds the document a save stored. A member with nothing stored stays out of the document,
 * and an empty tag list reads as no tags.
 */
export function readStoredWorkflowDocument(
  columns: StoredWorkflowDocumentColumns,
): WorkflowDocument {
  const document: WorkflowDocument = {
    schemaVersion: WORKFLOW_DOCUMENT_SCHEMA_VERSION,
    ...parseStoredWorkflowBody(columns.definitionBody),
  };
  if (columns.layoutJson !== null) {
    document.layout = JSON.parse(columns.layoutJson) as WorkflowLayout;
  }
  if (columns.pinDataJson !== undefined && columns.pinDataJson !== null) {
    document.pinData = JSON.parse(columns.pinDataJson) as Record<string, WorkflowPinnedItem[]>;
  }
  if (columns.tagsJson !== undefined) {
    const tags = JSON.parse(columns.tagsJson) as string[];
    if (tags.length > 0) {
      document.tags = tags;
    }
  }
  return document;
}
