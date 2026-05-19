import assert from 'node:assert/strict';
import test from 'node:test';
import { GitChange, RepositoryRef, WorkspaceState } from '../../src/model';
import { mergeRepositoryChanges } from '../../src/workspaceStateMerge';

test('keeps previous repo changes when a targeted status refresh fails', () => {
  const repoA: RepositoryRef = { root: '/repo-a', name: 'repo-a' };
  const repoB: RepositoryRef = { root: '/repo-b', name: 'repo-b' };
  const previous: WorkspaceState = {
    repositories: [repoA, repoB],
    changes: [change(repoA, 'a.go'), change(repoB, 'b.go')]
  };

  const merged = mergeRepositoryChanges(
    [repoA, repoB],
    [repoA],
    [{ repo: repoA, changes: [], failed: true }],
    previous
  );

  assert.deepEqual(merged.map((item) => `${item.repoName}:${item.path}`), ['repo-a:a.go', 'repo-b:b.go']);
});

test('replaces only the successfully refreshed targeted repo', () => {
  const repoA: RepositoryRef = { root: '/repo-a', name: 'repo-a' };
  const repoB: RepositoryRef = { root: '/repo-b', name: 'repo-b' };
  const previous: WorkspaceState = {
    repositories: [repoA, repoB],
    changes: [change(repoA, 'old-a.go'), change(repoB, 'b.go')]
  };

  const merged = mergeRepositoryChanges(
    [repoA, repoB],
    [repoA],
    [{ repo: repoA, changes: [change(repoA, 'new-a.go')], failed: false }],
    previous
  );

  assert.deepEqual(merged.map((item) => `${item.repoName}:${item.path}`), ['repo-a:new-a.go', 'repo-b:b.go']);
});

function change(repo: RepositoryRef, filePath: string): GitChange {
  return {
    repoRoot: repo.root,
    repoName: repo.name,
    path: filePath,
    area: 'workingTree',
    category: 'Changes',
    kind: 'modified',
    statusText: 'Modified'
  };
}
