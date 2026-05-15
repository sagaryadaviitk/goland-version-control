import assert from 'node:assert/strict';
import test from 'node:test';
import { GitWatchRoot, RefreshCoordinator, gitWatchBases } from '../../src/refreshCoordinator';

class MemoryDisposable {
  disposed = false;

  dispose(): void {
    this.disposed = true;
  }
}

test('debounces automatic refresh events', async () => {
  let refreshCount = 0;
  const coordinator = new RefreshCoordinator({
    debounceMs: 5,
    isAutoRefreshEnabled: () => true,
    refresh: async () => {
      refreshCount += 1;
      return { value: refreshCount };
    },
    getWatchRoots: async () => [],
    createWatcher: () => new MemoryDisposable()
  });

  coordinator.scheduleAutoRefresh();
  coordinator.scheduleAutoRefresh();
  coordinator.scheduleAutoRefresh();
  await delay(30);

  assert.equal(refreshCount, 1);
  coordinator.dispose();
});

test('does not schedule automatic refresh when disabled', async () => {
  let refreshCount = 0;
  const createdWatchers: MemoryDisposable[] = [];
  const coordinator = new RefreshCoordinator({
    debounceMs: 5,
    isAutoRefreshEnabled: () => false,
    refresh: async () => {
      refreshCount += 1;
      return { value: refreshCount };
    },
    getWatchRoots: async () => [{ gitDir: '/repo/.git', commonDir: '/repo/.git' }],
    createWatcher: () => {
      const watcher = new MemoryDisposable();
      createdWatchers.push(watcher);
      return watcher;
    }
  });

  coordinator.scheduleAutoRefresh();
  await delay(30);
  assert.equal(refreshCount, 0);

  await coordinator.refreshNow();
  assert.equal(refreshCount, 1);
  assert.equal(createdWatchers.length, 0);
  coordinator.dispose();
});

test('queues one follow-up refresh instead of overlapping refreshes', async () => {
  let refreshCount = 0;
  let unblockFirstRefresh: (() => void) | undefined;
  const firstRefresh = new Promise<void>((resolve) => {
    unblockFirstRefresh = resolve;
  });
  const coordinator = new RefreshCoordinator({
    isAutoRefreshEnabled: () => true,
    refresh: async () => {
      refreshCount += 1;
      if (refreshCount === 1) {
        await firstRefresh;
      }
      return { value: refreshCount };
    },
    getWatchRoots: async () => [],
    createWatcher: () => new MemoryDisposable()
  });

  const first = coordinator.refreshNow();
  const second = coordinator.refreshNow();

  await delay(10);
  assert.equal(refreshCount, 1);

  unblockFirstRefresh?.();
  await Promise.all([first, second]);

  assert.equal(refreshCount, 2);
  coordinator.dispose();
});

test('ignores watcher events caused by its own refresh pass', async () => {
  let refreshCount = 0;
  const coordinator = new RefreshCoordinator({
    debounceMs: 5,
    isAutoRefreshEnabled: () => true,
    refresh: async () => {
      refreshCount += 1;
      return { value: refreshCount };
    },
    getWatchRoots: async () => [],
    createWatcher: () => new MemoryDisposable()
  });

  await coordinator.refreshNow();
  coordinator.scheduleAutoRefresh();
  await delay(30);

  assert.equal(refreshCount, 1);
  coordinator.dispose();
});

test('rebuilds Git watchers when watch roots change', async () => {
  const watcherSets: MemoryDisposable[][] = [];
  const roots: GitWatchRoot[][] = [
    [{ gitDir: '/repo-a/.git', commonDir: '/repo-a/.git' }],
    [{ gitDir: '/repo-b/.git', commonDir: '/repo-b/.git' }]
  ];
  const coordinator = new RefreshCoordinator({
    isAutoRefreshEnabled: () => true,
    refresh: async () => ({ value: watcherSets.length }),
    getWatchRoots: async () => roots.shift() ?? [],
    createWatcher: () => {
      const watcher = new MemoryDisposable();
      if (watcherSets.length === 0 || watcherSets.at(-1)?.every((existing) => existing.disposed)) {
        watcherSets.push([]);
      }
      watcherSets[watcherSets.length - 1].push(watcher);
      return watcher;
    }
  });

  await coordinator.refreshNow();
  const firstSet = watcherSets[0];
  assert.ok(firstSet.length > 0);

  await coordinator.refreshNow();
  assert.ok(firstSet.every((watcher) => watcher.disposed));
  assert.ok(watcherSets[1].length > 0);

  coordinator.dispose();
  assert.ok(watcherSets[1].every((watcher) => watcher.disposed));
});

test('deduplicates Git watch bases across git dir and common dir', () => {
  const bases = gitWatchBases([
    { gitDir: '/repo/.git', commonDir: '/repo/.git' },
    { gitDir: '/worktree/.git/worktrees/service', commonDir: '/repo/.git' }
  ]);

  assert.deepEqual(bases, ['/repo/.git', '/worktree/.git/worktrees/service']);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
