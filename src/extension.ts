import * as vscode from 'vscode';
import { ChangelistStore } from './changelists';
import { resolveChanges, resolveSingleChange } from './commandSelection';
import { GitService } from './gitService';
import { openDiff, openWorkingFile, registerDiffProvider } from './diffProvider';
import { ReviewSession } from './reviewSession';
import { DisposableLike, RefreshCoordinator } from './refreshCoordinator';
import { ChangeDecorationProvider, LocalChangesTreeProvider } from './treeView';
import { ExtensionSettings, GitChange, WorkspaceState } from './model';

let workspaceState: WorkspaceState = { repositories: [], changes: [] };

export interface GoLandVersionControlApi {
  getWorkspaceState(): WorkspaceState;
}

export function activate(context: vscode.ExtensionContext): GoLandVersionControlApi {
  const git = new GitService();
  const changelists = new ChangelistStore(context.workspaceState);
  const treeProvider = new LocalChangesTreeProvider(changelists);
  const decorationProvider = new ChangeDecorationProvider();
  const reviewSession = new ReviewSession();

  registerDiffProvider(context, git);

  const tree = vscode.window.createTreeView('golandVersionControl.localChanges', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    canSelectMany: true
  });

  const refresh = async (): Promise<WorkspaceState> => {
    try {
      const settings = readSettings();
      workspaceState = await git.loadWorkspaceState(settings.showUntracked);
      treeProvider.update(workspaceState, settings);
      decorationProvider.refresh();
      reviewSession.update(workspaceState);
      tree.badge = workspaceState.changes.length > 0
        ? { value: workspaceState.changes.length, tooltip: `${workspaceState.changes.length} local changes` }
        : undefined;
    } catch (error) {
      void vscode.window.showWarningMessage(`GoLand Version Control refresh failed: ${messageFrom(error)}`);
    }

    return workspaceState;
  };

  const refreshCoordinator = new RefreshCoordinator<WorkspaceState>({
    debounceMs: 350,
    isAutoRefreshEnabled: () => readSettings().autoRefresh,
    refresh,
    getWatchRoots: (state) => git.getGitWatchRoots(state.repositories),
    createWatcher: createGitWatcher,
    onError: (error) => {
      void vscode.window.showWarningMessage(`GoLand Version Control refresh failed: ${messageFrom(error)}`);
    }
  });
  const scheduleRefresh = () => refreshCoordinator.scheduleAutoRefresh();
  const refreshNow = () => refreshCoordinator.refreshNow();
  const revertChanges = async (input?: unknown, selected?: unknown[]) => {
    const changes = resolveChanges(input, selected);
    if (changes.length === 0) {
      void vscode.window.showInformationMessage('No local change selected.');
      return;
    }
    if (!(await confirmDiscard(changes))) {
      return;
    }
    await git.discard(changes);
    await refreshNow();
  };

  context.subscriptions.push(
    tree,
    refreshCoordinator,
    vscode.window.registerFileDecorationProvider(decorationProvider),
    command('golandVersionControl.refresh', refreshNow),
    command('golandVersionControl.openDiff', async (input?: unknown) => {
      const change = resolveSingleChange(input);
      if (!change) {
        void vscode.window.showInformationMessage('No local change selected.');
        return;
      }
      reviewSession.setCurrent(change);
      await openDiff(change);
    }),
    command('golandVersionControl.openFile', async (input?: unknown) => {
      const change = resolveSingleChange(input);
      if (!change) {
        void vscode.window.showInformationMessage('No local change selected.');
        return;
      }
      reviewSession.setCurrent(change);
      await openWorkingFile(change);
    }),
    command('golandVersionControl.nextChange', async () => {
      await vscode.commands.executeCommand('workbench.action.editor.nextChange');
    }),
    command('golandVersionControl.previousChange', async () => {
      await vscode.commands.executeCommand('workbench.action.editor.previousChange');
    }),
    command('golandVersionControl.nextFile', async () => {
      const change = reviewSession.next();
      if (change) {
        await openDiff(change);
      }
    }),
    command('golandVersionControl.previousFile', async () => {
      const change = reviewSession.previous();
      if (change) {
        await openDiff(change);
      }
    }),
    command('golandVersionControl.stage', async (input?: unknown, selected?: unknown[]) => {
      const changes = resolveChanges(input, selected).filter((change) => change.area === 'workingTree' || change.area === 'untracked');
      if (changes.length === 0) {
        return;
      }
      await git.stage(changes);
      await refreshNow();
    }),
    command('golandVersionControl.unstage', async (input?: unknown, selected?: unknown[]) => {
      const changes = resolveChanges(input, selected).filter((change) => change.area === 'index');
      if (changes.length === 0) {
        return;
      }
      await git.unstage(changes);
      await refreshNow();
    }),
    command('golandVersionControl.discard', revertChanges),
    command('golandVersionControl.revert', revertChanges),
    command('golandVersionControl.createChangelist', async () => {
      const repoRoot = await pickRepositoryRoot();
      if (!repoRoot) {
        return;
      }

      const name = await vscode.window.showInputBox({
        title: 'Create Changelist',
        prompt: 'Changelist name',
        ignoreFocusOut: true
      });
      if (!name) {
        return;
      }
      await changelists.create(repoRoot, name);
      await refreshNow();
    }),
    command('golandVersionControl.moveToChangelist', async (input?: unknown) => {
      const change = resolveSingleChange(input);
      if (!change) {
        return;
      }

      const existing = changelists.getChangelists(change.repoRoot);
      const picked = await vscode.window.showQuickPick([...existing, 'Create New Changelist...'], {
        title: 'Move to Changelist',
        placeHolder: 'Select a changelist'
      });
      if (!picked) {
        return;
      }

      const target = picked === 'Create New Changelist...'
        ? await vscode.window.showInputBox({ title: 'Create Changelist', prompt: 'Changelist name', ignoreFocusOut: true })
        : picked;
      if (!target) {
        return;
      }
      await changelists.move(change, target);
      await refreshNow();
    }),
    vscode.workspace.onDidSaveTextDocument(scheduleRefresh),
    vscode.workspace.onDidCreateFiles(scheduleRefresh),
    vscode.workspace.onDidDeleteFiles(scheduleRefresh),
    vscode.workspace.onDidRenameFiles(scheduleRefresh),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleRefresh),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        scheduleRefresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('golandVersionControl')) {
        void refreshNow();
      }
    })
  );

  void refreshNow();

  return {
    getWorkspaceState: () => workspaceState
  };
}

export function deactivate(): void {}

function command(name: string, callback: (...args: any[]) => unknown): vscode.Disposable {
  return vscode.commands.registerCommand(name, async (...args: any[]) => {
    try {
      await callback(...args);
    } catch (error) {
      void vscode.window.showErrorMessage(`${name} failed: ${messageFrom(error)}`);
    }
  });
}

function readSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration('golandVersionControl');
  return {
    showUntracked: config.get('showUntracked', false),
    groupBy: config.get('groupBy', 'changelist'),
    autoRefresh: config.get('autoRefresh', true),
    confirmDiscard: config.get('confirmDiscard', true),
    compareBase: config.get('compareBase', 'HEAD')
  };
}

async function confirmDiscard(changes: GitChange[]): Promise<boolean> {
  if (!readSettings().confirmDiscard) {
    return true;
  }

  const label = changes.length === 1 ? changes[0].path : `${changes.length} files`;
  const answer = await vscode.window.showWarningMessage(
    `Discard local changes in ${label}? This cannot be undone.`,
    { modal: true },
    'Discard'
  );
  return answer === 'Discard';
}

async function pickRepositoryRoot(): Promise<string | undefined> {
  if (workspaceState.repositories.length === 0) {
    void vscode.window.showInformationMessage('No Git repositories found.');
    return undefined;
  }

  if (workspaceState.repositories.length === 1) {
    return workspaceState.repositories[0].root;
  }

  const picked = await vscode.window.showQuickPick(
    workspaceState.repositories.map((repo) => ({ label: repo.name, description: repo.root, repoRoot: repo.root })),
    { title: 'Select Repository' }
  );
  return picked?.repoRoot;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createGitWatcher(basePath: string, pattern: string, onEvent: () => void): DisposableLike {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(basePath), pattern)
  );
  const subscriptions = [
    watcher.onDidChange(onEvent),
    watcher.onDidCreate(onEvent),
    watcher.onDidDelete(onEvent),
    watcher
  ];

  return {
    dispose: () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    }
  };
}
