import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChangeRecords, parsePorcelainStatus } from '../../src/gitStatus';
import { RepositoryRef } from '../../src/model';

const repo: RepositoryRef = { root: '/repo', name: 'repo' };

test('parses modified, staged, untracked, deleted, and conflicted porcelain records', () => {
  const output = [
    ' M src/unstaged.go',
    'M  src/staged.go',
    '?? src/new.go',
    ' D src/deleted.go',
    'UU src/conflict.go',
    ''
  ].join('\0');

  const entries = parsePorcelainStatus(repo.root, output);
  const changes = buildChangeRecords(repo, entries);

  assert.deepEqual(
    changes.map((change) => [change.category, change.area, change.kind, change.path]),
    [
      ['Changes', 'workingTree', 'modified', 'src/unstaged.go'],
      ['Staged', 'index', 'modified', 'src/staged.go'],
      ['Unversioned', 'untracked', 'untracked', 'src/new.go'],
      ['Changes', 'workingTree', 'deleted', 'src/deleted.go'],
      ['Conflicts', 'conflict', 'conflict', 'src/conflict.go']
    ]
  );
});

test('splits partially staged files into staged and working tree records', () => {
  const output = 'MM src/partial.go\0';

  const changes = buildChangeRecords(repo, parsePorcelainStatus(repo.root, output));

  assert.deepEqual(
    changes.map((change) => [change.category, change.area, change.path]),
    [
      ['Staged', 'index', 'src/partial.go'],
      ['Changes', 'workingTree', 'src/partial.go']
    ]
  );
});

test('parses porcelain rename records with original path', () => {
  const output = 'R  src/new_name.go\0src/old_name.go\0';

  const changes = buildChangeRecords(repo, parsePorcelainStatus(repo.root, output));

  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'renamed');
  assert.equal(changes[0].path, 'src/new_name.go');
  assert.equal(changes[0].originalPath, 'src/old_name.go');
});

test('ignores ignored records when present', () => {
  const output = '!! tmp/cache.txt\0';

  const changes = buildChangeRecords(repo, parsePorcelainStatus(repo.root, output));

  assert.deepEqual(changes, []);
});
