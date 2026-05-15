import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverWorkspaceRepositoryRoots, uniqueRepositories } from '../../src/repositoryDiscovery';

test('discovers child repositories even when a workspace folder is also a repository', async () => {
  const children = new Map<string, string[]>([
    ['/workspace', ['/workspace/service-a', '/workspace/service-b']]
  ]);
  const gitRoots = new Map<string, string | undefined>([
    ['/workspace', '/workspace'],
    ['/workspace/service-a', '/workspace/service-a'],
    ['/workspace/service-b', '/workspace/service-b']
  ]);

  const roots = await discoverWorkspaceRepositoryRoots(
    ['/workspace'],
    async (candidate) => gitRoots.get(candidate),
    async (folder) => children.get(folder) ?? []
  );

  assert.deepEqual(roots.sort(), ['/workspace', '/workspace/service-a', '/workspace/service-b']);
});

test('normalizes and deduplicates repository roots from multiple discovery sources', () => {
  const repos = uniqueRepositories([
    '/workspace/service-a',
    '/workspace/../workspace/service-a',
    '/workspace/service-b'
  ]);

  assert.deepEqual(
    repos.map((repo) => repo.root),
    [path.resolve('/workspace/service-a'), path.resolve('/workspace/service-b')]
  );
  assert.deepEqual(repos.map((repo) => repo.name), ['service-a', 'service-b']);
});

test('deduplicates symlink and real repository roots', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gvc-repos-'));
  const realRepo = path.join(tempRoot, 'service-a');
  const linkRepo = path.join(tempRoot, 'service-a-link');
  fs.mkdirSync(realRepo);
  fs.symlinkSync(realRepo, linkRepo);

  try {
    const repos = uniqueRepositories([realRepo, linkRepo]);
    assert.equal(repos.length, 1);
    assert.equal(repos[0].root, fs.realpathSync.native(realRepo));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
