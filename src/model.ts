export type ChangeArea = 'index' | 'workingTree' | 'untracked' | 'conflict';

export type ChangeCategory = 'Staged' | 'Changes' | 'Unversioned' | 'Conflicts';

export type ChangeKind =
  | 'added'
  | 'copied'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'typechange'
  | 'untracked'
  | 'conflict';

export interface RepositoryRef {
  root: string;
  name: string;
}

export interface GitStatusEntry {
  repoRoot: string;
  path: string;
  originalPath?: string;
  indexStatus: string;
  workingTreeStatus: string;
}

export interface GitChange {
  repoRoot: string;
  repoName: string;
  path: string;
  originalPath?: string;
  area: ChangeArea;
  category: ChangeCategory;
  kind: ChangeKind;
  statusText: string;
}

export interface WorkspaceState {
  repositories: RepositoryRef[];
  changes: GitChange[];
}

export interface ExtensionSettings {
  showUntracked: boolean;
  groupBy: 'changelist' | 'status' | 'folder';
  autoRefresh: boolean;
  confirmDiscard: boolean;
  debug: boolean;
  openDiffAtFirstChange: boolean;
  enableGoDiffDiagnostics: boolean;
  shelfLocation: string;
  stashIncludeUntracked: boolean;
  compareBase: 'HEAD';
}

export interface ShelfFile {
  path: string;
  originalPath?: string;
  statusText: string;
}

export interface ShelfEntry {
  id: string;
  name: string;
  repoRoot: string;
  repoName: string;
  baseCommit: string;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
  patchPath: string;
  files: ShelfFile[];
}

export interface ShelfIndex {
  version: 1;
  shelves: ShelfEntry[];
}

export interface StashFile {
  path: string;
  status: string;
}

export interface StashEntry {
  repoRoot: string;
  repoName: string;
  ref: string;
  message: string;
  hash: string;
  createdAt: string;
  files: StashFile[];
}

export const DEFAULT_CHANGELISTS = {
  staged: 'Staged',
  changes: 'Changes',
  unversioned: 'Unversioned',
  conflicts: 'Conflicts'
} as const;

export function changeKey(change: GitChange): string {
  return `${change.repoRoot}\u0000${change.area}\u0000${change.path}\u0000${change.originalPath ?? ''}`;
}

export function assignmentKey(change: Pick<GitChange, 'repoRoot' | 'path'>): string {
  return `${change.repoRoot}\u0000${change.path}`;
}
