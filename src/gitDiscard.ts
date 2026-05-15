import { GitChange } from './model';

export interface DiscardPlan {
  stagedAndWorktreePaths: string[];
  worktreePaths: string[];
  cleanPaths: string[];
}

export function buildDiscardPlan(changes: GitChange[]): DiscardPlan {
  return {
    stagedAndWorktreePaths: uniquePaths(changes
      .filter((change) => change.area === 'index' || change.area === 'conflict')
      .flatMap(pathsKnownToGit)),
    worktreePaths: uniquePaths(changes
      .filter((change) => change.area === 'workingTree')
      .flatMap(pathsToRestoreWorktree)),
    cleanPaths: uniquePaths(changes
      .filter((change) => change.area === 'untracked')
      .map((change) => change.path))
  };
}

function pathsKnownToGit(change: GitChange): string[] {
  return [change.path, change.originalPath].filter(isDefined);
}

function pathsToRestoreWorktree(change: GitChange): string[] {
  if (change.kind === 'added' || change.kind === 'copied' || change.kind === 'untracked') {
    return [];
  }

  return pathsKnownToGit(change);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
