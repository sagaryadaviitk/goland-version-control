import assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangelistStore } from '../../src/changelists';
import { GitChange, WorkspaceState } from '../../src/model';
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
    assert.ok(commands.includes('golandVersionControl.createStash'));
  });

  test('file nodes expose inline revert context', () => {
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
});

function state(changes: GitChange[]): WorkspaceState {
  return { repositories: [{ root: '/repo', name: 'repo' }], changes };
}

function gitChange(
  filePath: string,
  category: GitChange['category'],
  area: GitChange['area'],
  kind: GitChange['kind'],
  statusText: string
): GitChange {
  return {
    repoRoot: '/repo',
    repoName: 'repo',
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

function runGit(repoRoot: string, args: string[]): void {
  cp.execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'ignore' });
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
