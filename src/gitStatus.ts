import { ChangeArea, ChangeCategory, ChangeKind, GitChange, GitStatusEntry, RepositoryRef } from './model';

const CONFLICT_STATUSES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

export function parsePorcelainStatus(repoRoot: string, output: string): GitStatusEntry[] {
  const records = output.split('\0').filter(Boolean);
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) {
      continue;
    }

    const indexStatus = record[0];
    const workingTreeStatus = record[1];
    const path = record.slice(3);
    const isRenameOrCopy = indexStatus === 'R' || indexStatus === 'C' || workingTreeStatus === 'R' || workingTreeStatus === 'C';
    const originalPath = isRenameOrCopy ? records[index + 1] : undefined;

    entries.push({
      repoRoot,
      path,
      originalPath,
      indexStatus,
      workingTreeStatus
    });

    if (isRenameOrCopy && originalPath) {
      index += 1;
    }
  }

  return entries;
}

export function buildChangeRecords(repo: RepositoryRef, entries: GitStatusEntry[]): GitChange[] {
  const changes: GitChange[] = [];

  for (const entry of entries) {
    if (entry.indexStatus === '!' && entry.workingTreeStatus === '!') {
      continue;
    }

    if (entry.indexStatus === '?' && entry.workingTreeStatus === '?') {
      changes.push(toChange(repo, entry, 'untracked', 'Unversioned', 'untracked', 'Untracked'));
      continue;
    }

    if (isConflict(entry)) {
      changes.push(toChange(repo, entry, 'conflict', 'Conflicts', 'conflict', 'Conflict'));
      continue;
    }

    if (entry.indexStatus !== ' ') {
      changes.push(toChange(
        repo,
        entry,
        'index',
        'Staged',
        statusToKind(entry.indexStatus),
        statusToText(entry.indexStatus)
      ));
    }

    if (entry.workingTreeStatus !== ' ') {
      changes.push(toChange(
        repo,
        entry,
        'workingTree',
        'Changes',
        statusToKind(entry.workingTreeStatus),
        statusToText(entry.workingTreeStatus)
      ));
    }
  }

  return changes;
}

function toChange(
  repo: RepositoryRef,
  entry: GitStatusEntry,
  area: ChangeArea,
  category: ChangeCategory,
  kind: ChangeKind,
  statusText: string
): GitChange {
  return {
    repoRoot: repo.root,
    repoName: repo.name,
    path: entry.path,
    originalPath: entry.originalPath,
    area,
    category,
    kind,
    statusText
  };
}

function isConflict(entry: GitStatusEntry): boolean {
  return CONFLICT_STATUSES.has(`${entry.indexStatus}${entry.workingTreeStatus}`);
}

function statusToKind(status: string): ChangeKind {
  switch (status) {
    case 'A':
      return 'added';
    case 'C':
      return 'copied';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'T':
      return 'typechange';
    case 'M':
    default:
      return 'modified';
  }
}

function statusToText(status: string): string {
  switch (status) {
    case 'A':
      return 'Added';
    case 'C':
      return 'Copied';
    case 'D':
      return 'Deleted';
    case 'R':
      return 'Renamed';
    case 'T':
      return 'Type Changed';
    case 'M':
    default:
      return 'Modified';
  }
}
