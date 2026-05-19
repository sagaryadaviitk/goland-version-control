import { GitChange } from './model';

export interface DiffRequest {
  area: 'cached' | 'worktree';
  paths: string[];
}

export interface StashPlan {
  mode: 'all' | 'staged' | 'worktree';
  paths: string[];
  includeUntracked: boolean;
}

export interface AreaAwareDiscardPlan {
  resetPaths: string[];
  indexOnlyPaths: string[];
  worktreeOnlyPaths: string[];
  cleanPaths: string[];
}

export function buildDiffRequests(changes: GitChange[]): DiffRequest[] {
  const cachedPaths = uniquePaths(changes
    .filter((change) => change.area === 'index' || change.area === 'conflict')
    .flatMap(pathsKnownToGit));
  const worktreePaths = uniquePaths(changes
    .filter((change) => change.area === 'workingTree' || change.area === 'conflict')
    .flatMap(pathsKnownToGit));
  const requests: DiffRequest[] = [];

  if (cachedPaths.length > 0) {
    requests.push({ area: 'cached', paths: cachedPaths });
  }
  if (worktreePaths.length > 0) {
    requests.push({ area: 'worktree', paths: worktreePaths });
  }

  return requests;
}

export function buildStashPlans(changes: GitChange[], includeUntracked: boolean): StashPlan[] {
  const selections = selectedPaths(changes);
  const allPaths: string[] = [];
  const stagedPaths: string[] = [];
  const worktreePaths: string[] = [];
  const untrackedPaths: string[] = [];

  for (const selection of selections.values()) {
    if (selection.untracked) {
      untrackedPaths.push(...selection.paths);
      continue;
    }

    if (selection.conflict || (selection.index && selection.worktree)) {
      allPaths.push(...selection.paths);
      continue;
    }

    if (selection.index) {
      stagedPaths.push(...selection.paths);
    } else if (selection.worktree) {
      worktreePaths.push(...selection.paths);
    }
  }

  const plans: StashPlan[] = [];
  if (allPaths.length > 0) {
    plans.push({ mode: 'all', paths: uniquePaths(allPaths), includeUntracked: false });
  }
  if (stagedPaths.length > 0) {
    plans.push({ mode: 'staged', paths: uniquePaths(stagedPaths), includeUntracked: false });
  }
  if (worktreePaths.length > 0) {
    plans.push({ mode: 'worktree', paths: uniquePaths(worktreePaths), includeUntracked: false });
  }
  if (includeUntracked && untrackedPaths.length > 0) {
    plans.push({ mode: 'all', paths: uniquePaths(untrackedPaths), includeUntracked: true });
  }

  return plans;
}

export function buildAreaAwareDiscardPlan(changes: GitChange[]): AreaAwareDiscardPlan {
  const selections = selectedPaths(changes);
  const resetPaths: string[] = [];
  const indexOnlyPaths: string[] = [];
  const worktreeOnlyPaths: string[] = [];
  const cleanPaths: string[] = [];

  for (const selection of selections.values()) {
    if (selection.untracked) {
      cleanPaths.push(...selection.paths);
      continue;
    }

    if (selection.conflict || (selection.index && selection.worktree)) {
      resetPaths.push(...selection.paths);
      continue;
    }

    if (selection.index) {
      indexOnlyPaths.push(...selection.paths);
    } else if (selection.worktree) {
      worktreeOnlyPaths.push(...selection.paths);
    }
  }

  return {
    resetPaths: uniquePaths(resetPaths),
    indexOnlyPaths: uniquePaths(indexOnlyPaths),
    worktreeOnlyPaths: uniquePaths(worktreeOnlyPaths),
    cleanPaths: uniquePaths(cleanPaths)
  };
}

interface PathSelection {
  paths: string[];
  index: boolean;
  worktree: boolean;
  untracked: boolean;
  conflict: boolean;
}

function selectedPaths(changes: GitChange[]): Map<string, PathSelection> {
  const selections = new Map<string, PathSelection>();
  for (const change of changes) {
    const key = `${change.repoRoot}\0${change.path}`;
    const selection = selections.get(key) ?? {
      paths: [],
      index: false,
      worktree: false,
      untracked: false,
      conflict: false
    };
    selection.paths.push(...pathsKnownToGit(change));
    selection.index ||= change.area === 'index';
    selection.worktree ||= change.area === 'workingTree';
    selection.untracked ||= change.area === 'untracked';
    selection.conflict ||= change.area === 'conflict';
    selections.set(key, selection);
  }

  for (const selection of selections.values()) {
    selection.paths = uniquePaths(selection.paths);
  }

  return selections;
}

function pathsKnownToGit(change: GitChange): string[] {
  return [change.path, change.originalPath].filter(isDefined);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
