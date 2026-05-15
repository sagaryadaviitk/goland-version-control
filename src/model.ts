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
  compareBase: 'HEAD';
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
