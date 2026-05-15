import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildChangeRecords, parsePorcelainStatus } from './gitStatus';
import { GitChange, RepositoryRef, WorkspaceState } from './model';
import { GitWatchRoot } from './refreshCoordinator';
import { discoverWorkspaceRepositoryRoots, uniqueRepositories } from './repositoryDiscovery';

interface GitExtension {
  getAPI(version: 1): GitApi;
}

interface GitApi {
  repositories: Array<{ rootUri: vscode.Uri }>;
}

export class GitService {
  async loadWorkspaceState(showUntracked: boolean): Promise<WorkspaceState> {
    const repositories = await this.discoverRepositories();
    const changesByRepository = await Promise.all(
      repositories.map(async (repo) => this.getChanges(repo, showUntracked))
    );

    return {
      repositories,
      changes: changesByRepository.flat().sort(compareChanges)
    };
  }

  async getChanges(repo: RepositoryRef, showUntracked: boolean): Promise<GitChange[]> {
    const args = ['status', '--porcelain=v1', '-z', showUntracked ? '--untracked-files=all' : '--untracked-files=no'];
    const output = await runGit(repo.root, args);
    return buildChangeRecords(repo, parsePorcelainStatus(repo.root, output));
  }

  async stage(changes: GitChange[]): Promise<void> {
    await this.runPathCommand(changes, async (repoRoot, paths) => {
      await runGit(repoRoot, ['add', '--', ...paths]);
    });
  }

  async unstage(changes: GitChange[]): Promise<void> {
    await this.runPathCommand(changes.filter((change) => change.area === 'index'), async (repoRoot, paths) => {
      await runGit(repoRoot, ['reset', '-q', 'HEAD', '--', ...paths]);
    });
  }

  async discard(changes: GitChange[]): Promise<void> {
    const byRepo = groupPathsByRepo(changes);

    for (const [repoRoot, repoChanges] of byRepo) {
      const resetPaths = uniquePaths(repoChanges
        .filter((change) => change.area !== 'untracked')
        .flatMap((change) => [change.path, change.originalPath])
        .filter(isDefined));
      const checkoutPaths = uniquePaths(repoChanges.flatMap((change) => pathsToCheckout(change)));
      const cleanPaths = uniquePaths(repoChanges.flatMap((change) => pathsToClean(change)));

      if (resetPaths.length > 0) {
        await runGit(repoRoot, ['reset', '-q', 'HEAD', '--', ...resetPaths]);
      }

      if (checkoutPaths.length > 0) {
        await runGit(repoRoot, ['checkout', '--', ...checkoutPaths]);
      }

      if (cleanPaths.length > 0) {
        await runGit(repoRoot, ['clean', '-f', '--', ...cleanPaths]);
      }
    }
  }

  async showFile(repoRoot: string, ref: 'HEAD' | 'INDEX', filePath: string): Promise<string> {
    if (ref === 'INDEX') {
      return runGit(repoRoot, ['show', `:${filePath}`]);
    }

    return runGit(repoRoot, ['show', `HEAD:${filePath}`]);
  }

  async discoverRepositories(): Promise<RepositoryRef[]> {
    const [gitApiRepos, workspaceRepos] = await Promise.all([
      this.discoverViaGitExtension(),
      this.discoverViaWorkspaceFolders()
    ]);

    return uniqueRepositories([
      ...gitApiRepos.map((repo) => repo.root),
      ...workspaceRepos.map((repo) => repo.root)
    ]);
  }

  async getGitWatchRoots(repositories: RepositoryRef[]): Promise<GitWatchRoot[]> {
    const roots = await Promise.all(
      repositories.map(async (repo) => this.getGitWatchRoot(repo))
    );
    return roots.filter(isDefined);
  }

  private async getGitWatchRoot(repo: RepositoryRef): Promise<GitWatchRoot | undefined> {
    try {
      const [gitDir, commonDir] = await Promise.all([
        runGit(repo.root, ['rev-parse', '--git-dir']),
        runGit(repo.root, ['rev-parse', '--git-common-dir'])
      ]);

      return {
        gitDir: resolveGitPath(repo.root, gitDir),
        commonDir: resolveGitPath(repo.root, commonDir)
      };
    } catch {
      return undefined;
    }
  }

  private async discoverViaGitExtension(): Promise<RepositoryRef[]> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) {
      return [];
    }

    const api = extension.isActive ? extension.exports.getAPI(1) : (await extension.activate()).getAPI(1);
    return uniqueRepositories(
      api.repositories.map((repo) => repo.rootUri.fsPath)
    );
  }

  private async discoverViaWorkspaceFolders(): Promise<RepositoryRef[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = await discoverWorkspaceRepositoryRoots(
      folders.map((folder) => folder.uri.fsPath),
      tryGitRoot,
      immediateChildren
    );
    return uniqueRepositories(roots);
  }

  private async runPathCommand(
    changes: GitChange[],
    execute: (repoRoot: string, paths: string[]) => Promise<void>
  ): Promise<void> {
    const byRepo = groupPathsByRepo(changes);
    for (const [repoRoot, repoChanges] of byRepo) {
      await execute(repoRoot, repoChanges.map((change) => change.path));
    }
  }
}

export function runGit(repoRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile('git', ['-C', repoRoot, ...args], { encoding: 'utf8', maxBuffer: 25 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }

      resolve(stdout);
    });
  });
}

function compareChanges(left: GitChange, right: GitChange): number {
  return left.repoName.localeCompare(right.repoName)
    || categoryRank(left.category) - categoryRank(right.category)
    || left.path.localeCompare(right.path)
    || left.area.localeCompare(right.area);
}

function categoryRank(category: string): number {
  switch (category) {
    case 'Conflicts':
      return 0;
    case 'Staged':
      return 1;
    case 'Changes':
      return 2;
    case 'Unversioned':
      return 3;
    default:
      return 4;
  }
}

function groupPathsByRepo(changes: GitChange[]): Map<string, GitChange[]> {
  const byRepo = new Map<string, GitChange[]>();
  for (const change of changes) {
    const existing = byRepo.get(change.repoRoot) ?? [];
    existing.push(change);
    byRepo.set(change.repoRoot, existing);
  }
  return byRepo;
}

function pathsToCheckout(change: GitChange): string[] {
  if (change.area === 'untracked') {
    return [];
  }

  if (change.kind === 'added' || change.kind === 'copied') {
    return [];
  }

  if (change.kind === 'renamed') {
    return change.originalPath ? [change.originalPath] : [];
  }

  return [change.path];
}

function pathsToClean(change: GitChange): string[] {
  if (change.area === 'untracked') {
    return [change.path];
  }

  if (change.kind === 'added' || change.kind === 'copied' || change.kind === 'renamed') {
    return [change.path];
  }

  return [];
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function resolveGitPath(repoRoot: string, value: string): string {
  const trimmed = value.trim();
  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }
  return path.resolve(repoRoot, trimmed);
}

async function tryGitRoot(candidate: string): Promise<string | undefined> {
  try {
    return (await runGit(candidate, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return undefined;
  }
}

async function immediateChildren(folder: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(folder, entry.name));
  } catch {
    return [];
  }
}
