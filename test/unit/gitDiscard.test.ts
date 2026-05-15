import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiscardPlan } from '../../src/gitDiscard';
import { GitChange } from '../../src/model';

test('restores unstaged tracked files from the index without resetting staged changes', () => {
  const plan = buildDiscardPlan([
    change('partial.go', 'workingTree', 'modified')
  ]);

  assert.deepEqual(plan, {
    stagedAndWorktreePaths: [],
    worktreePaths: ['partial.go'],
    cleanPaths: []
  });
});

test('restores staged files from HEAD through the index and working tree', () => {
  const plan = buildDiscardPlan([
    change('staged.go', 'index', 'modified')
  ]);

  assert.deepEqual(plan, {
    stagedAndWorktreePaths: ['staged.go'],
    worktreePaths: [],
    cleanPaths: []
  });
});

test('restores both sides of a staged rename', () => {
  const plan = buildDiscardPlan([
    change('new.go', 'index', 'renamed', 'old.go')
  ]);

  assert.deepEqual(plan, {
    stagedAndWorktreePaths: ['new.go', 'old.go'],
    worktreePaths: [],
    cleanPaths: []
  });
});

test('cleans untracked files and directories', () => {
  const plan = buildDiscardPlan([
    change('tmp/new.go', 'untracked', 'untracked')
  ]);

  assert.deepEqual(plan, {
    stagedAndWorktreePaths: [],
    worktreePaths: [],
    cleanPaths: ['tmp/new.go']
  });
});

test('restores conflicts through staged and working tree restore', () => {
  const plan = buildDiscardPlan([
    change('conflict.go', 'conflict', 'conflict')
  ]);

  assert.deepEqual(plan, {
    stagedAndWorktreePaths: ['conflict.go'],
    worktreePaths: [],
    cleanPaths: []
  });
});

function change(
  filePath: string,
  area: GitChange['area'],
  kind: GitChange['kind'],
  originalPath?: string
): GitChange {
  return {
    repoRoot: '/repo',
    repoName: 'repo',
    path: filePath,
    originalPath,
    area,
    category: area === 'index' ? 'Staged' : area === 'untracked' ? 'Unversioned' : area === 'conflict' ? 'Conflicts' : 'Changes',
    kind,
    statusText: kind
  };
}
