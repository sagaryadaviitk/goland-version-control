import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangelistStore } from './changelists';
import { resolveChanges, resolveSingleChange } from './commandSelection';
import { registerDiffProvider, openWorkingFile } from './diffProvider';
import { GitService } from './gitService';
import { ExtensionSettings, GitChange, ShelfEntry, StashEntry, WorkspaceState, changeKey } from './model';
import { DisposableLike, RefreshCoordinator } from './refreshCoordinator';
import { ReviewSession } from './reviewSession';
import { SelectedChangesTreeProvider } from './selectedChangesView';
import { ShelfService } from './shelfService';
import { ShelfTreeProvider } from './shelfView';
import { StashTreeProvider } from './stashView';
import { ChangeDecorationProvider, LocalChangesTreeProvider } from './treeView';

let workspaceState: WorkspaceState = { repositories: [], changes: [] };

export interface GoLandVersionControlApi {
  getWorkspaceState(): WorkspaceState;
}

export function activate(context: vscode.ExtensionContext): GoLandVersionControlApi {
  const output = vscode.window.createOutputChannel('GoLand Version Control');
  const log = (message: string): void => {
    if (readSettings().debug) {
      output.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
  };

  const git = new GitService(log);
  const changelists = new ChangelistStore(context.workspaceState);
  const treeProvider = new LocalChangesTreeProvider(changelists);
  const selectedProvider = new SelectedChangesTreeProvider();
  const shelfProvider = new ShelfTreeProvider();
  const stashProvider = new StashTreeProvider((stash) => git.listStashFiles(stash));
  const decorationProvider = new ChangeDecorationProvider();
  const reviewSession = new ReviewSession();
  const diffController = registerDiffProvider(context, git);
  const shelfService = new ShelfService(context, git, readSettings);
  let refreshVersion = 0;
  let selectedChanges: GitChange[] = [];
  let lastCrossRepoSelectionWarningAt = 0;

  const tree = vscode.window.createTreeView('golandVersionControl.localChanges', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    canSelectMany: true
  });
  const selectedTree = vscode.window.createTreeView('golandVersionControl.selectedChanges', {
    treeDataProvider: selectedProvider,
    showCollapseAll: true
  });
  const shelfTree = vscode.window.createTreeView('golandVersionControl.shelf', {
    treeDataProvider: shelfProvider,
    showCollapseAll: true
  });
  const stashTree = vscode.window.createTreeView('golandVersionControl.stash', {
    treeDataProvider: stashProvider,
    showCollapseAll: true
  });

  const updateSelectedChanges = (changes: GitChange[]): void => {
    treeProvider.updateSelection(changes);
    const hasMultiSelection = changes.length > 1;
    const hasCrossRepoSelection = isCrossRepoSelection(changes);
    const hasValidMultiSelection = hasMultiSelection && !hasCrossRepoSelection;
    const actionableChanges = hasCrossRepoSelection ? [] : changes;

    selectedChanges = actionableChanges;
    selectedProvider.update(hasValidMultiSelection ? actionableChanges : []);
    void vscode.commands.executeCommand('setContext', 'golandVersionControl.hasMultiSelection', hasMultiSelection);
    void vscode.commands.executeCommand('setContext', 'golandVersionControl.hasValidMultiSelection', hasValidMultiSelection);
    void vscode.commands.executeCommand(
      'setContext',
      'golandVersionControl.selectedStageable',
      hasValidMultiSelection && actionableChanges.some((change) => change.area === 'workingTree' || change.area === 'untracked')
    );
    void vscode.commands.executeCommand(
      'setContext',
      'golandVersionControl.selectedUnstageable',
      hasValidMultiSelection && actionableChanges.some((change) => change.area === 'index')
    );
    void vscode.commands.executeCommand(
      'setContext',
      'golandVersionControl.selectedShelvable',
      hasValidMultiSelection && actionableChanges.some((change) => change.area !== 'untracked')
    );

    if (hasCrossRepoSelection) {
      warnCrossRepoSelection();
    }
  };

  const syncSelectedChangesWithState = (): void => {
    if (selectedChanges.length === 0) {
      updateSelectedChanges([]);
      return;
    }

    const current = new Map(workspaceState.changes.map((change) => [changeKey(change), change]));
    updateSelectedChanges(selectedChanges
      .map((change) => current.get(changeKey(change)))
      .filter(isDefined));
  };

  const commandChanges = (input?: unknown, selected?: unknown[]): GitChange[] => {
    const changes = resolveChanges(input, selected);
    const resolved = changes.length > 0 ? changes : selectedChanges;
    if (isCrossRepoSelection(resolved)) {
      warnCrossRepoSelection();
      return [];
    }
    return resolved;
  };

  const warnCrossRepoSelection = (): void => {
    const now = Date.now();
    if (now - lastCrossRepoSelectionWarningAt > 3000) {
      lastCrossRepoSelectionWarningAt = now;
      void vscode.window.showWarningMessage('Select files from one repository at a time.');
    }
  };

  const applyWorkspaceState = (): void => {
    const settings = readSettings();
    treeProvider.update(workspaceState, settings);
    decorationProvider.refresh();
    reviewSession.update(workspaceState);
    syncSelectedChangesWithState();
    tree.badge = workspaceState.changes.length > 0
      ? { value: workspaceState.changes.length, tooltip: `${workspaceState.changes.length} local changes` }
      : undefined;
  };

  const refresh = async (options: {
    forceDiscover?: boolean;
    repoRoots?: string[];
    previous?: WorkspaceState;
    concurrency?: number;
  } = {}): Promise<WorkspaceState> => {
    const version = ++refreshVersion;
    const settings = readSettings();
    const start = Date.now();
    const nextState = await git.loadWorkspaceState(settings.showUntracked, options);
    if (version !== refreshVersion) {
      return workspaceState;
    }
    const hasStateChanged = !sameWorkspaceState(workspaceState, nextState);
    workspaceState = nextState;
    if (hasStateChanged) {
      applyWorkspaceState();
    }
    log(`refresh ${options.repoRoots?.join(',') ?? 'all'} (${Date.now() - start}ms, ${workspaceState.changes.length} changes, ${hasStateChanged ? 'updated' : 'unchanged'})`);
    return workspaceState;
  };

  const refreshShelf = async (): Promise<void> => {
    shelfProvider.update(await shelfService.listShelves());
  };

  const refreshStash = async (): Promise<void> => {
    stashProvider.update(await git.listStashes(workspaceState.repositories));
  };

  const rebuildWatchersInBackground = (state: WorkspaceState): void => {
    void refreshCoordinator.rebuildWatchersForState(state).catch((error) => {
      log(`watcher rebuild failed: ${messageFrom(error)}`);
    });
  };

  const refreshShelfAndStashInBackground = (): void => {
    void Promise.allSettled([refreshShelf(), refreshStash()]).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          log(`secondary view refresh failed: ${messageFrom(result.reason)}`);
        }
      }
    });
  };

  const refreshCoordinator = new RefreshCoordinator<WorkspaceState>({
    debounceMs: 350,
    isAutoRefreshEnabled: () => readSettings().autoRefresh,
    refresh: () => refresh(),
    getWatchRoots: (state) => git.getGitWatchRoots(state.repositories),
    createWatcher: createGitWatcher,
    onError: (error) => {
      void vscode.window.showWarningMessage(`GoLand Version Control refresh failed: ${messageFrom(error)}`);
    }
  });
  const scheduleRefresh = () => refreshCoordinator.scheduleAutoRefresh();
  const refreshNow = () => refreshCoordinator.refreshNow();
  const repoTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const repoRefreshes = new Map<string, Promise<void>>();

  const refreshRepoNow = async (repoRoot: string): Promise<void> => {
    const existing = repoRefreshes.get(repoRoot);
    if (existing) {
      return existing;
    }

    const refreshPromise = refresh({
      repoRoots: [repoRoot],
      previous: workspaceState,
      concurrency: 1
    }).then(() => undefined).finally(() => {
      repoRefreshes.delete(repoRoot);
    });
    repoRefreshes.set(repoRoot, refreshPromise);
    return refreshPromise;
  };

  const scheduleRepoRefresh = (repoRoot: string): void => {
    if (!readSettings().autoRefresh) {
      return;
    }

    const existing = repoTimers.get(repoRoot);
    if (existing) {
      clearTimeout(existing);
    }

    repoTimers.set(repoRoot, setTimeout(() => {
      repoTimers.delete(repoRoot);
      void refreshRepoNow(repoRoot);
    }, 200));
  };

  const refreshChangedRepos = async (changes: GitChange[]): Promise<void> => {
    const repoRoots = [...new Set(changes.map((change) => change.repoRoot))];
    for (const repoRoot of repoRoots) {
      await refreshRepoNow(repoRoot);
    }
  };

  const openChangeDiff = async (change: GitChange): Promise<void> => {
    reviewSession.setCurrent(change);
    await diffController.openDiff(change, { openAtFirstChange: readSettings().openDiffAtFirstChange });
  };

  const revertChanges = async (input?: unknown, selected?: unknown[]) => {
    const changes = commandChanges(input, selected);
    if (changes.length === 0) {
      void vscode.window.showInformationMessage('No local change selected.');
      return;
    }
    if (!(await confirmDiscard(changes))) {
      return;
    }
    await git.discard(changes);
    await refreshChangedRepos(changes);
  };

  const createShelf = async (input: unknown, selected: unknown[] | undefined, removeAfterSave: boolean) => {
    const changes = commandChanges(input, selected);
    if (changes.length === 0) {
      void vscode.window.showInformationMessage('No local change selected.');
      return;
    }

    const name = await vscode.window.showInputBox({
      title: removeAfterSave ? 'Shelve Changes' : 'Save to Shelf',
      prompt: 'Shelf name',
      value: `Shelf ${new Date().toLocaleString()}`,
      ignoreFocusOut: true
    });
    if (!name) {
      return;
    }

    const result = await shelfService.createShelf(changes, name, removeAfterSave);
    await refreshShelf();
    await refreshChangedRepos(changes);

    if (result.shelves.length === 0) {
      void vscode.window.showInformationMessage('No tracked changes were available to shelve.');
      return;
    }

    if (result.skippedUntracked.length > 0) {
      void vscode.window.showInformationMessage(`Skipped ${result.skippedUntracked.length} untracked file(s); shelves store tracked changes only.`);
    }
  };

  const createSelectedStash = async (input: unknown, selected: unknown[] | undefined) => {
    const changes = commandChanges(input, selected);
    if (changes.length === 0) {
      void vscode.window.showInformationMessage('No local change selected.');
      return;
    }

    const message = await vscode.window.showInputBox({
      title: 'Stash Selected Changes',
      prompt: 'Stash message',
      value: `WIP ${new Date().toLocaleString()}`,
      ignoreFocusOut: true
    });
    if (!message) {
      return;
    }

    await git.createStashForChanges(changes, message, readSettings().stashIncludeUntracked);
    await refreshChangedRepos(changes);
    await refreshStash();
  };

  const resolveShelfOrPick = async (input: unknown): Promise<ShelfEntry | undefined> =>
    resolveShelf(input) ?? pickShelf(await shelfService.listShelves());
  const resolveStashOrPick = async (input: unknown): Promise<StashEntry | undefined> =>
    resolveStash(input) ?? pickStash(await git.listStashes(workspaceState.repositories));

  const manualRefresh = async (): Promise<void> => {
    git.clearRepositoryCache();
    const state = await refresh({ forceDiscover: true, concurrency: 8 });
    await refreshCoordinator.rebuildWatchersForState(state);
    await delay(100);
    refreshShelfAndStashInBackground();
  };

  const startupRefresh = async (): Promise<void> => {
    git.clearRepositoryCache();
    const state = await refresh({ forceDiscover: true, concurrency: 8 });
    rebuildWatchersInBackground(state);
    refreshShelfAndStashInBackground();
  };

  const refreshFromUris = (uris: readonly vscode.Uri[]): void => {
    let scheduledFullRefresh = false;
    for (const uri of uris) {
      if (uri.scheme !== 'file') {
        continue;
      }

      diffController.refreshForFile(uri.fsPath);
      const repo = repositoryForPath(uri.fsPath);
      if (repo) {
        scheduleRepoRefresh(repo.root);
      } else if (!scheduledFullRefresh) {
        scheduledFullRefresh = true;
        scheduleRefresh();
      }
    }
  };

  context.subscriptions.push(
    output,
    tree,
    selectedTree,
    shelfTree,
    stashTree,
    refreshCoordinator,
    { dispose: () => disposeRepoTimers(repoTimers) },
    vscode.window.registerFileDecorationProvider(decorationProvider),
    tree.onDidChangeSelection((event) => {
      updateSelectedChanges(resolveChanges(undefined, [...event.selection]));
    }),
    command('golandVersionControl.refresh', manualRefresh),
    command('golandVersionControl.openDiff', async (input?: unknown) => {
      const change = resolveSingleChange(input);
      if (!change) {
        void vscode.window.showInformationMessage('No local change selected.');
        return;
      }
      await openChangeDiff(change);
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
        await openChangeDiff(change);
      }
    }),
    command('golandVersionControl.previousFile', async () => {
      const change = reviewSession.previous();
      if (change) {
        await openChangeDiff(change);
      }
    }),
    command('golandVersionControl.stage', async (input?: unknown, selected?: unknown[]) => {
      const changes = commandChanges(input, selected).filter((change) => change.area === 'workingTree' || change.area === 'untracked');
      if (changes.length === 0) {
        return;
      }
      await git.stage(changes);
      await refreshChangedRepos(changes);
    }),
    command('golandVersionControl.unstage', async (input?: unknown, selected?: unknown[]) => {
      const changes = commandChanges(input, selected).filter((change) => change.area === 'index');
      if (changes.length === 0) {
        return;
      }
      await git.unstage(changes);
      await refreshChangedRepos(changes);
    }),
    command('golandVersionControl.discard', revertChanges),
    command('golandVersionControl.revert', revertChanges),
    command('golandVersionControl.shelve', async (input?: unknown, selected?: unknown[]) => {
      await createShelf(input, selected, true);
    }),
    command('golandVersionControl.saveToShelf', async (input?: unknown, selected?: unknown[]) => {
      await createShelf(input, selected, false);
    }),
    command('golandVersionControl.stashSelected', async (input?: unknown, selected?: unknown[]) => {
      await createSelectedStash(input, selected);
    }),
    command('golandVersionControl.refreshShelf', refreshShelf),
    command('golandVersionControl.unshelve', async (input?: unknown) => {
      const shelf = await resolveShelfOrPick(input);
      if (!shelf) {
        return;
      }
      await shelfService.restoreShelf(shelf, false);
      await refreshShelf();
      await refreshRepoNow(shelf.repoRoot);
    }),
    command('golandVersionControl.restoreShelf', async (input?: unknown) => {
      const shelf = await resolveShelfOrPick(input);
      if (!shelf) {
        return;
      }
      await shelfService.restoreShelf(shelf, false);
      await refreshRepoNow(shelf.repoRoot);
    }),
    command('golandVersionControl.deleteShelf', async (input?: unknown) => {
      const shelf = await resolveShelfOrPick(input);
      if (!shelf) {
        return;
      }
      await shelfService.deleteShelf(shelf);
      await refreshShelf();
    }),
    command('golandVersionControl.openShelfDiff', async (input?: unknown) => {
      const shelf = await resolveShelfOrPick(input);
      if (!shelf) {
        return;
      }
      await openPatchDocument(`Shelf: ${shelf.name}`, await shelfService.readShelfPatch(shelf));
    }),
    command('golandVersionControl.refreshStash', refreshStash),
    command('golandVersionControl.createStash', async () => {
      const repoRoot = await pickRepositoryRoot();
      if (!repoRoot) {
        return;
      }
      const message = await vscode.window.showInputBox({
        title: 'Create Stash',
        prompt: 'Stash message',
        value: `WIP ${new Date().toLocaleString()}`,
        ignoreFocusOut: true
      });
      if (!message) {
        return;
      }
      await git.createStash(repoRoot, message, readSettings().stashIncludeUntracked);
      await refreshRepoNow(repoRoot);
      await refreshStash();
    }),
    command('golandVersionControl.applyStash', async (input?: unknown) => {
      const stash = await resolveStashOrPick(input);
      if (!stash) {
        return;
      }
      await git.applyStash(stash);
      await refreshRepoNow(stash.repoRoot);
    }),
    command('golandVersionControl.popStash', async (input?: unknown) => {
      const stash = await resolveStashOrPick(input);
      if (!stash) {
        return;
      }
      await git.popStash(stash);
      await refreshRepoNow(stash.repoRoot);
      await refreshStash();
    }),
    command('golandVersionControl.dropStash', async (input?: unknown) => {
      const stash = await resolveStashOrPick(input);
      if (!stash) {
        return;
      }
      await git.dropStash(stash);
      await refreshStash();
    }),
    command('golandVersionControl.openStashDiff', async (input?: unknown) => {
      const stash = await resolveStashOrPick(input);
      if (!stash) {
        return;
      }
      await openPatchDocument(`Stash: ${stash.repoName} ${stash.ref}`, await git.showStashPatch(stash));
    }),
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
    vscode.workspace.onDidSaveTextDocument((document) => refreshFromUris([document.uri])),
    vscode.workspace.onDidCreateFiles((event) => refreshFromUris(event.files)),
    vscode.workspace.onDidDeleteFiles((event) => refreshFromUris(event.files)),
    vscode.workspace.onDidRenameFiles((event) => refreshFromUris(event.files.flatMap((file) => [file.oldUri, file.newUri]))),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      git.clearRepositoryCache();
      void manualRefresh();
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        scheduleRefresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('golandVersionControl')) {
        void manualRefresh();
      }
    })
  );

  void startupRefresh();

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
    confirmDiscard: config.get('confirmDiscard', false),
    debug: config.get('debug', false),
    openDiffAtFirstChange: config.get('openDiffAtFirstChange', true),
    shelfLocation: config.get('shelfLocation', ''),
    stashIncludeUntracked: config.get('stashIncludeUntracked', true),
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

function repositoryForPath(fsPath: string): { root: string } | undefined {
  const normalized = path.resolve(fsPath);
  return workspaceState.repositories
    .filter((repo) => isInside(repo.root, normalized))
    .sort((left, right) => right.root.length - left.root.length)[0];
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveShelf(input: unknown): ShelfEntry | undefined {
  if (input && typeof input === 'object' && 'shelf' in input) {
    return (input as { shelf?: ShelfEntry }).shelf;
  }
  return undefined;
}

function resolveStash(input: unknown): StashEntry | undefined {
  if (input && typeof input === 'object' && 'stash' in input) {
    return (input as { stash?: StashEntry }).stash;
  }
  return undefined;
}

async function pickShelf(shelves: ShelfEntry[]): Promise<ShelfEntry | undefined> {
  if (shelves.length === 0) {
    void vscode.window.showInformationMessage('No shelves found.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    shelves.map((shelf) => ({
      label: shelf.name,
      description: `${shelf.repoName} ${shelf.fileCount === 1 ? '1 file' : `${shelf.fileCount} files`}`,
      detail: shelf.repoRoot,
      shelf
    })),
    { title: 'Select Shelf' }
  );
  return picked?.shelf;
}

async function pickStash(stashes: StashEntry[]): Promise<StashEntry | undefined> {
  if (stashes.length === 0) {
    void vscode.window.showInformationMessage('No Git stashes found.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    stashes.map((stash) => ({
      label: stash.message || stash.ref,
      description: `${stash.repoName} ${stash.ref}`,
      detail: stash.repoRoot,
      stash
    })),
    { title: 'Select Stash' }
  );
  return picked?.stash;
}

async function openPatchDocument(title: string, content: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({ language: 'diff', content });
  await vscode.window.showTextDocument(document, { preview: false });
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    await vscode.commands.executeCommand('workbench.action.keepEditor');
  }
  void title;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function disposeRepoTimers(timers: Map<string, ReturnType<typeof setTimeout>>): void {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function sameWorkspaceState(left: WorkspaceState, right: WorkspaceState): boolean {
  if (left.repositories.length !== right.repositories.length || left.changes.length !== right.changes.length) {
    return false;
  }

  for (let index = 0; index < left.repositories.length; index += 1) {
    if (left.repositories[index].root !== right.repositories[index].root || left.repositories[index].name !== right.repositories[index].name) {
      return false;
    }
  }

  for (let index = 0; index < left.changes.length; index += 1) {
    if (!sameChange(left.changes[index], right.changes[index])) {
      return false;
    }
  }

  return true;
}

function sameChange(left: GitChange, right: GitChange): boolean {
  return left.repoRoot === right.repoRoot
    && left.repoName === right.repoName
    && left.path === right.path
    && left.originalPath === right.originalPath
    && left.area === right.area
    && left.category === right.category
    && left.kind === right.kind
    && left.statusText === right.statusText;
}

function isCrossRepoSelection(changes: GitChange[]): boolean {
  return new Set(changes.map((change) => change.repoRoot)).size > 1;
}

function createGitWatcher(basePath: string, pattern: string, onEvent: () => void): DisposableLike {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(basePath), pattern)
  );
  const nodeWatcher = createNodeWatcher(basePath, pattern, onEvent);
  const subscriptions = [
    watcher.onDidChange(onEvent),
    watcher.onDidCreate(onEvent),
    watcher.onDidDelete(onEvent),
    watcher,
    nodeWatcher
  ];

  return {
    dispose: () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    }
  };
}

function createNodeWatcher(basePath: string, pattern: string, onEvent: () => void): DisposableLike {
  const recursive = pattern.endsWith('/**');
  const target = recursive
    ? path.join(basePath, pattern.slice(0, -3))
    : path.join(basePath, pattern);

  try {
    if (!recursive) {
      const parent = path.dirname(target);
      const name = path.basename(target);
      const watcher = fs.watch(parent, { persistent: false }, (_eventType, filename) => {
        if (!filename || filename.toString() === name) {
          onEvent();
        }
      });
      return { dispose: () => watcher.close() };
    }

    const watcher = fs.watch(target, { persistent: false, recursive }, onEvent);
    return { dispose: () => watcher.close() };
  } catch {
    return { dispose: () => undefined };
  }
}
