export interface MigrationMapping {
  workspaceId: string;
  /** Explicit user-selected repository identity; groups are never inferred. */
  projectKey: string;
  taskKey: string;
}
export interface MigrationPreview {
  operationId: string;
  /** Immutable fingerprint of the exact source reviewed by the user. */
  sourceFingerprint: string;
  backupPath: string;
  suggestedMappings: MigrationMapping[];
  workspaces: Array<{
    id: string;
    name: string;
    path: string;
    repositoryIdentity: string;
    git: string;
    panes: number;
    piSessions: string[];
  }>;
  groups: Record<string, string[]>;
  /** Original unrecognized pane records retained verbatim by the host. */
  unsupported: unknown[];
}
export interface MigrationImportRequest {
  operationId: string;
  networkId: string;
  sourceFingerprint: string;
  mappings: MigrationMapping[];
  /** Device that owns the imported task paths. Defaults to this installation for local imports. */
  targetDeviceId?: string;
}

export interface MigrationStatus {
  needsMigration: boolean;
  state: "pending" | "importing" | "complete" | "exported";
  operationId?: string;
}

export interface MigrationConflict {
  conflictId: string;
  original: unknown;
  incoming: unknown;
  revisionHash: string;
  state: string;
  resolutionTaskId?: string;
  proposal?: MigrationConflictProposal;
}
export interface MigrationConflictProposal {
  conflictId: string;
  revisionHash: string;
  sourceRecordIds: string[];
  action: "keep_original" | "use_incoming" | "merge" | "manual";
  mapping: Record<string, string>;
  diff: unknown;
}
export interface MigrationConflictApproval {
  conflictId: string;
  revisionHash: string;
  sourceRecordIds: string[];
  approve: true;
}
