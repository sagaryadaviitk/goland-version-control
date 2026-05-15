import assert from 'node:assert/strict';
import test from 'node:test';
import { ChangelistStore } from '../../src/changelists';
import { GitChange, WorkspaceState } from '../../src/model';
import { buildTree } from '../../src/treeModel';

class MemoryMemento {
  private values = new Map<string, unknown>();

  get<T>(key: string, fallback: T): T {
    return (this.values.get(key) as T | undefined) ?? fallback;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

const repo = { root: '/repo', name: 'repo' };

test('builds repository, changelist, and flat file path nodes without status or folder clutter', async () => {
  const store = new ChangelistStore(new MemoryMemento() as any);
  const change = gitChange('service/order.go', 'Changes', 'workingTree', 'modified', 'Modified');

  const tree = buildTree(state([change]), store, 'changelist');

  assert.equal(tree[0].label, 'repo');
  assert.equal(tree[0].count, 1);
  assert.equal(tree[0].children[0].label, 'Changes');
  const changesGroup = tree[0].children[0] as any;
  assert.equal(changesGroup.count, 1);
  assert.equal(changesGroup.children[0].label, 'service/order.go');
});

test('uses custom changelist assignments for unstaged changes', async () => {
  const store = new ChangelistStore(new MemoryMemento() as any);
  const change = gitChange('service/order.go', 'Changes', 'workingTree', 'modified', 'Modified');
  await store.move(change, 'Task 123');

  const tree = buildTree(state([change]), store, 'changelist');

  assert.equal(tree[0].children[0].label, 'Task 123');
});

test('keeps staged and unversioned changes in fixed default groups', async () => {
  const store = new ChangelistStore(new MemoryMemento() as any);
  const staged = gitChange('a.go', 'Staged', 'index', 'modified', 'Modified');
  const untracked = gitChange('b.go', 'Unversioned', 'untracked', 'untracked', 'Untracked');

  const tree = buildTree(state([untracked, staged]), store, 'changelist');

  assert.deepEqual(tree[0].children.map((node) => node.label), ['Staged', 'Unversioned Files']);
});

function state(changes: GitChange[]): WorkspaceState {
  return { repositories: [repo], changes };
}

function gitChange(
  filePath: string,
  category: GitChange['category'],
  area: GitChange['area'],
  kind: GitChange['kind'],
  statusText: string
): GitChange {
  return {
    repoRoot: repo.root,
    repoName: repo.name,
    path: filePath,
    area,
    category,
    kind,
    statusText
  };
}
