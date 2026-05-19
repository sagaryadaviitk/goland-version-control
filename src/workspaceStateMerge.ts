import { GitChange, RepositoryRef, WorkspaceState } from './model';

export interface RepositoryChanges {
  repo: RepositoryRef;
  changes: GitChange[];
  failed: boolean;
}

export function mergeRepositoryChanges(
  repositories: RepositoryRef[],
  targetRepositories: RepositoryRef[],
  results: RepositoryChanges[],
  previous?: WorkspaceState
): GitChange[] {
  const targetRoots = new Set(targetRepositories.map((repo) => repo.root));
  const resultByRoot = new Map(results.map((result) => [result.repo.root, result]));
  const previousByRoot = groupChangesByRepo(previous?.changes ?? []);
  const merged: GitChange[] = [];

  for (const repo of repositories) {
    if (!targetRoots.has(repo.root)) {
      merged.push(...(previousByRoot.get(repo.root) ?? []));
      continue;
    }

    const result = resultByRoot.get(repo.root);
    if (!result || result.failed) {
      merged.push(...(previousByRoot.get(repo.root) ?? []));
      continue;
    }

    merged.push(...result.changes);
  }

  return merged;
}

function groupChangesByRepo(changes: GitChange[]): Map<string, GitChange[]> {
  const grouped = new Map<string, GitChange[]>();
  for (const change of changes) {
    const existing = grouped.get(change.repoRoot) ?? [];
    existing.push(change);
    grouped.set(change.repoRoot, existing);
  }
  return grouped;
}
