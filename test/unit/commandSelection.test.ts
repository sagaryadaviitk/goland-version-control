import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveChanges } from '../../src/commandSelection';
import { GitChange } from '../../src/model';
import { FileNode, GroupNode, RepositoryNode } from '../../src/treeModel';

test('uses clicked file when tree selection is stale', () => {
  const clicked = fileNode(change('clicked.go'));
  const staleSelection = [fileNode(change('previous.go'))];

  assert.deepEqual(resolveChanges(clicked, staleSelection).map((item) => item.path), ['clicked.go']);
});

test('uses multi-selection when clicked file is selected', () => {
  const clickedChange = change('clicked.go');
  const otherChange = change('other.go');

  assert.deepEqual(
    resolveChanges(fileNode(clickedChange), [fileNode(otherChange), fileNode(clickedChange)]).map((item) => item.path),
    ['other.go', 'clicked.go']
  );
});

test('falls back to clicked file when selected items are not files', () => {
  const clicked = fileNode(change('clicked.go'));

  assert.deepEqual(resolveChanges(clicked, [{ type: 'group' }]).map((item) => item.path), ['clicked.go']);
});

test('deduplicates selected changes', () => {
  const selected = fileNode(change('same.go'));

  assert.deepEqual(resolveChanges(selected, [selected, selected]).map((item) => item.path), ['same.go']);
});

test('resolves changes from group and repository nodes', () => {
  const group: GroupNode = {
    type: 'group',
    id: 'group:Changes',
    label: 'Changes',
    count: 2,
    children: [fileNode(change('one.go')), fileNode(change('two.go'))]
  };
  const repo: RepositoryNode = {
    type: 'repository',
    id: 'repo:/repo',
    label: 'repo',
    repo: { root: '/repo', name: 'repo' },
    count: 2,
    children: [group]
  };

  assert.deepEqual(resolveChanges(group).map((item) => item.path), ['one.go', 'two.go']);
  assert.deepEqual(resolveChanges(repo).map((item) => item.path), ['one.go', 'two.go']);
});

function fileNode(gitChange: GitChange): FileNode {
  return {
    type: 'file',
    id: `file:${gitChange.path}`,
    label: gitChange.path,
    change: gitChange
  };
}

function change(filePath: string): GitChange {
  return {
    repoRoot: '/repo',
    repoName: 'repo',
    path: filePath,
    area: 'workingTree',
    category: 'Changes',
    kind: 'modified',
    statusText: 'Modified'
  };
}
