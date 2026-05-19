import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAreaAwareDiscardPlan, buildDiffRequests, buildStashPlans } from '../../src/gitOperationPlans';
import { GitChange } from '../../src/model';

test('builds separate cached and worktree diff requests for partially staged files', () => {
  const staged = change('partial.go', 'index');
  const worktree = change('partial.go', 'workingTree');

  assert.deepEqual(buildDiffRequests([staged]), [
    { area: 'cached', paths: ['partial.go'] }
  ]);
  assert.deepEqual(buildDiffRequests([worktree]), [
    { area: 'worktree', paths: ['partial.go'] }
  ]);
  assert.deepEqual(buildDiffRequests([staged, worktree]), [
    { area: 'cached', paths: ['partial.go'] },
    { area: 'worktree', paths: ['partial.go'] }
  ]);
});

test('plans selected stashes by selected change area', () => {
  const plans = buildStashPlans([
    change('both.go', 'index'),
    change('both.go', 'workingTree'),
    change('staged.go', 'index'),
    change('worktree.go', 'workingTree'),
    change('new.go', 'untracked')
  ], true);

  assert.deepEqual(plans, [
    { mode: 'all', paths: ['both.go'], includeUntracked: false },
    { mode: 'staged', paths: ['staged.go'], includeUntracked: false },
    { mode: 'worktree', paths: ['worktree.go'], includeUntracked: false },
    { mode: 'all', paths: ['new.go'], includeUntracked: true }
  ]);
});

test('skips untracked selected stashes when untracked stashing is disabled', () => {
  assert.deepEqual(buildStashPlans([change('new.go', 'untracked')], false), []);
});

test('plans discard without treating staged-only rows as whole-file reset', () => {
  assert.deepEqual(buildAreaAwareDiscardPlan([
    change('both.go', 'index'),
    change('both.go', 'workingTree'),
    change('staged.go', 'index'),
    change('worktree.go', 'workingTree'),
    change('new.go', 'untracked')
  ]), {
    resetPaths: ['both.go'],
    indexOnlyPaths: ['staged.go'],
    worktreeOnlyPaths: ['worktree.go'],
    cleanPaths: ['new.go']
  });
});

function change(filePath: string, area: GitChange['area']): GitChange {
  return {
    repoRoot: '/repo',
    repoName: 'repo',
    path: filePath,
    area,
    category: area === 'index' ? 'Staged' : area === 'untracked' ? 'Unversioned' : area === 'conflict' ? 'Conflicts' : 'Changes',
    kind: area === 'untracked' ? 'untracked' : area === 'conflict' ? 'conflict' : 'modified',
    statusText: area
  };
}
