import assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangelistStore } from '../../src/changelists';
import { GitService } from '../../src/gitService';
import { GitChange, ShelfEntry, WorkspaceState } from '../../src/model';
import { ShelfTreeProvider } from '../../src/shelfView';
import { LocalChangesTreeProvider } from '../../src/treeView';

interface ExtensionApi {
  getWorkspaceState(): {
    repositories: Array<{ root: string }>;
    changes: Array<{ repoRoot: string; path: string; area: string; category: string }>;
  };
}

class MemoryMemento {
  private values = new Map<string, unknown>();

  get<T>(key: string, fallback: T): T {
    return (this.values.get(key) as T | undefined) ?? fallback;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

suite('GoLand Version Control extension', () => {
  test('registers public commands', async () => {
    const extension = vscode.extensions.getExtension('sagaryadaviitk.goland-version-control');
    assert.ok(extension);
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('golandVersionControl.refresh'));
    assert.ok(commands.includes('golandVersionControl.openDiff'));
    assert.ok(commands.includes('golandVersionControl.stage'));
    assert.ok(commands.includes('golandVersionControl.unstage'));
    assert.ok(commands.includes('golandVersionControl.revert'));
    assert.ok(commands.includes('golandVersionControl.shelve'));
    assert.ok(commands.includes('golandVersionControl.saveToShelf'));
    assert.ok(commands.includes('golandVersionControl.stashSelected'));
    assert.ok(commands.includes('golandVersionControl.createStash'));
  });

  test('file nodes expose inline shelf, stash, and revert context', () => {
    const provider = new LocalChangesTreeProvider(new ChangelistStore(new MemoryMemento() as any));
    provider.update(
      state([gitChange('main.go', 'Changes', 'workingTree', 'modified', 'Modified')]),
      {
        showUntracked: false,
        groupBy: 'changelist',
        autoRefresh: true,
        confirmDiscard: false,
        debug: false,
        openDiffAtFirstChange: true,
        enableGoDiffDiagnostics: false,
        shelfLocation: '',
        stashIncludeUntracked: true,
        compareBase: 'HEAD'
      }
    );

    const repoNode = provider.getChildren()[0] as any;
    const groupNode = repoNode.children[0] as any;
    const fileNode = groupNode.children[0];
    const treeItem = provider.getTreeItem(fileNode);

    assert.match(String(treeItem.contextValue), /discardable/);
    assert.match(String(treeItem.contextValue), /shelvable/);
    assert.match(String(treeItem.contextValue), /stashable/);
  });

  test('shelf view groups shelves by repository like stash view', () => {
    const provider = new ShelfTreeProvider();
    provider.update([
      shelf('shelf-a', '/repo-b', 'repo-b'),
      shelf('shelf-b', '/repo-a', 'repo-a'),
      shelf('shelf-c', '/repo-b', 'repo-b')
    ]);

    const repoNodes = provider.getChildren();
    assert.deepEqual(repoNodes.map((node) => node.type === 'repository' ? node.repoName : ''), ['repo-a', 'repo-b']);

    const firstRepoItem = provider.getTreeItem(repoNodes[0]);
    assert.equal(firstRepoItem.contextValue, 'repository');
    assert.equal(firstRepoItem.description, '1 shelf');

    const secondRepoItem = provider.getTreeItem(repoNodes[1]);
    assert.equal(secondRepoItem.description, '2 shelves');

    const repoBShelves = provider.getChildren(repoNodes[1]);
    assert.deepEqual(repoBShelves.map((node) => node.type === 'shelf' ? node.shelf.name : ''), ['shelf-a', 'shelf-c']);
  });

  test('refreshes automatically when a repository index changes', async function () {
    this.timeout(15000);

    const extension = vscode.extensions.getExtension('sagaryadaviitk.goland-version-control');
    assert.ok(extension);
    const api = await extension.activate() as ExtensionApi;
    const repoRoot = createTempRepository();

    try {
      assert.ok(vscode.workspace.updateWorkspaceFolders(
        vscode.workspace.workspaceFolders?.length ?? 0,
        0,
        { uri: vscode.Uri.file(repoRoot), name: path.basename(repoRoot) }
      ));
      await waitFor(() => workspaceContains(repoRoot));

      await vscode.commands.executeCommand('golandVersionControl.refresh');
      await waitFor(() => api.getWorkspaceState().repositories.some((repo) => repo.root === repoRoot));
      fs.writeFileSync(path.join(repoRoot, 'main.go'), 'package main\n\nfunc main() { println("changed") }\n');
      runGit(repoRoot, ['add', 'main.go']);

      await waitFor(() =>
        api.getWorkspaceState().changes.some((change) =>
          change.repoRoot === repoRoot &&
          change.path === 'main.go' &&
          change.area === 'index' &&
          change.category === 'Staged'
        )
      );
    } finally {
      removeWorkspaceFolder(repoRoot);
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('discarding a staged row preserves unstaged changes on the same file', async function () {
    this.timeout(15000);

    const repoRoot = createTempRepositoryWithLines();
    try {
      writeLine(repoRoot, 2, 'index-only-marker');
      runGit(repoRoot, ['add', 'main.go']);
      writeLine(repoRoot, 30, 'worktree-only-marker');

      await new GitService().discard([
        gitChange('main.go', 'Staged', 'index', 'modified', 'Modified', repoRoot)
      ]);

      assert.equal(runGitOutput(repoRoot, ['diff', '--cached']).trim(), '');
      const worktreeDiff = runGitOutput(repoRoot, ['diff']);
      assert.ok(!worktreeDiff.includes('index-only-marker'), worktreeDiff);
      assert.ok(worktreeDiff.includes('worktree-only-marker'), worktreeDiff);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('stashing a worktree row keeps staged changes on the same file', async function () {
    this.timeout(15000);

    const repoRoot = createTempRepositoryWithLines();
    try {
      writeLine(repoRoot, 2, 'index-only-marker');
      runGit(repoRoot, ['add', 'main.go']);
      writeLine(repoRoot, 30, 'worktree-only-marker');

      await new GitService().createStashForChanges([
        gitChange('main.go', 'Changes', 'workingTree', 'modified', 'Modified', repoRoot)
      ], 'worktree-only', true);

      const cachedDiff = runGitOutput(repoRoot, ['diff', '--cached']);
      const worktreeDiff = runGitOutput(repoRoot, ['diff']);
      const stashDiff = runGitOutput(repoRoot, ['stash', 'show', '-p', 'stash@{0}']);
      assert.ok(cachedDiff.includes('index-only-marker'));
      assert.equal(worktreeDiff.trim(), '');
      assert.ok(!stashDiff.includes('index-only-marker'), stashDiff);
      assert.ok(stashDiff.includes('worktree-only-marker'), stashDiff);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

function state(changes: GitChange[]): WorkspaceState {
  return { repositories: [{ root: '/repo', name: 'repo' }], changes };
}

function shelf(name: string, repoRoot: string, repoName: string): ShelfEntry {
  return {
    id: name,
    name,
    repoRoot,
    repoName,
    baseCommit: '',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    fileCount: 1,
    patchPath: `${repoRoot}/${name}.patch`,
    files: [{ path: 'main.go', statusText: 'Modified' }]
  };
}

function gitChange(
  filePath: string,
  category: GitChange['category'],
  area: GitChange['area'],
  kind: GitChange['kind'],
  statusText: string,
  repoRoot = '/repo'
): GitChange {
  return {
    repoRoot,
    repoName: path.basename(repoRoot),
    path: filePath,
    area,
    category,
    kind,
    statusText
  };
}

function createTempRepository(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gvc-auto-refresh-'));
  runGit(repoRoot, ['init']);
  runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
  runGit(repoRoot, ['config', 'user.name', 'GoLand Version Control Test']);
  fs.writeFileSync(path.join(repoRoot, 'main.go'), 'package main\n\nfunc main() {}\n');
  runGit(repoRoot, ['add', 'main.go']);
  runGit(repoRoot, ['commit', '-m', 'initial']);
  return fs.realpathSync.native(repoRoot);
}

function createTempRepositoryWithLines(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gvc-partial-'));
  runGit(repoRoot, ['init']);
  runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
  runGit(repoRoot, ['config', 'user.name', 'GoLand Version Control Test']);
  fs.writeFileSync(path.join(repoRoot, 'main.go'), numberedLines());
  runGit(repoRoot, ['add', 'main.go']);
  runGit(repoRoot, ['commit', '-m', 'initial']);
  return fs.realpathSync.native(repoRoot);
}

function numberedLines(): string {
  return Array.from({ length: 40 }, (_value, index) => `line ${index + 1}`).join('\n') + '\n';
}

function writeLine(repoRoot: string, lineNumber: number, value: string): void {
  const filePath = path.join(repoRoot, 'main.go');
  const lines = fs.readFileSync(filePath, 'utf8').trimEnd().split('\n');
  lines[lineNumber - 1] = value;
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function runGit(repoRoot: string, args: string[]): void {
  cp.execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'ignore' });
}

function runGitOutput(repoRoot: string, args: string[]): string {
  return cp.execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('Timed out waiting for condition');
}

function workspaceContains(repoRoot: string): boolean {
  return Boolean(vscode.workspace.workspaceFolders?.some((folder) => folder.uri.fsPath === repoRoot));
}

function removeWorkspaceFolder(repoRoot: string): void {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const index = folders.findIndex((folder) => folder.uri.fsPath === repoRoot);
  if (index >= 0) {
    vscode.workspace.updateWorkspaceFolders(index, 1);
  }
}
