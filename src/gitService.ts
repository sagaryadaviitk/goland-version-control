import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildDiscardPlan } from './gitDiscard';
import { buildChangeRecords, parsePorcelainStatus } from './gitStatus';
import { GitChange, RepositoryRef, StashEntry, StashFile, WorkspaceState } from './model';
import { GitWatchRoot } from './refreshCoordinator';
import { discoverWorkspaceRepositoryRoots, uniqueRepositories } from './repositoryDiscovery';

interface GitExtension {
  getAPI(version: 1): GitApi;
}

interface GitApi {
  repositories: Array<{ rootUri: vscode.Uri }>;
}

export class GitService {
  private repositoryCache: RepositoryRef[] | undefined;

  constructor(private readonly log?: (message: string) => void) {}

  clearRepositoryCache(): void {
    this.repositoryCache = undefined;
  }

  async loadWorkspaceState(
    showUntracked: boolean,
    options: { forceDiscover?: boolean; repoRoots?: string[]; previous?: WorkspaceState; concurrency?: number } = {}
  ): Promise<WorkspaceState> {
    const repositories = await this.discoverRepositories(options.forceDiscover);
    const repoRootSet = options.repoRoots ? new Set(options.repoRoots.map(normalizePath)) : undefined;
    const targetRepositories = repoRootSet
      ? repositories.filter((repo) => repoRootSet.has(normalizePath(repo.root)))
      : repositories;
    const changesByRepository = await mapLimit(
      targetRepositories,
      options.concurrency ?? 4,
      async (repo) => {
        try {
          return await this.getChanges(repo, showUntracked);
        } catch (error) {
          this.log?.(`git status failed for ${repo.root}: ${messageFrom(error)}`);
          return [];
        }
      }
    );

    if (repoRootSet && options.previous) {
      const updatedRoots = new Set(targetRepositories.map((repo) => repo.root));
      return {
        repositories,
        changes: [
          ...options.previous.changes.filter((change) => !updatedRoots.has(change.repoRoot)),
          ...changesByRepository.flat()
        ].sort(compareChanges)
      };
    }

    return { repositories, changes: changesByRepository.flat().sort(compareChanges) };
  }

  async getChanges(repo: RepositoryRef, showUntracked: boolean): Promise<GitChange[]> {
    const args = ['status', '--porcelain=v1', '-z', showUntracked ? '--untracked-files=all' : '--untracked-files=no'];
    const output = await runGit(repo.root, args, this.log, { noOptionalLocks: true });
    return buildChangeRecords(repo, parsePorcelainStatus(repo.root, output));
  }

  async stage(changes: GitChange[]): Promise<void> {
    await this.runPathCommand(changes, async (repoRoot, paths) => {
      await runGit(repoRoot, ['add', '--', ...paths], this.log);
    });
  }

  async unstage(changes: GitChange[]): Promise<void> {
    await this.runPathCommand(changes.filter((change) => change.area === 'index'), async (repoRoot, paths) => {
      await runGit(repoRoot, ['reset', '-q', 'HEAD', '--', ...paths], this.log);
    });
  }

  async discard(changes: GitChange[]): Promise<void> {
    const byRepo = groupPathsByRepo(changes);

    for (const [repoRoot, repoChanges] of byRepo) {
      const plan = buildDiscardPlan(repoChanges);

      if (plan.stagedAndWorktreePaths.length > 0) {
        await runGit(repoRoot, ['restore', '--staged', '--worktree', '--', ...plan.stagedAndWorktreePaths], this.log);
      }

      if (plan.worktreePaths.length > 0) {
        await runGit(repoRoot, ['restore', '--worktree', '--', ...plan.worktreePaths], this.log);
      }

      if (plan.cleanPaths.length > 0) {
        await runGit(repoRoot, ['clean', '-fd', '--', ...plan.cleanPaths], this.log);
      }
    }
  }

  async showFile(repoRoot: string, ref: 'HEAD' | 'INDEX', filePath: string): Promise<string> {
    if (ref === 'INDEX') {
      return runGit(repoRoot, ['show', `:${filePath}`], this.log);
    }

    return runGit(repoRoot, ['show', `HEAD:${filePath}`], this.log);
  }

  async getHeadCommit(repoRoot: string): Promise<string> {
    return (await runGit(repoRoot, ['rev-parse', 'HEAD'], this.log)).trim();
  }

  async diffAgainstHead(repoRoot: string, paths: string[]): Promise<string> {
    return runGit(repoRoot, ['diff', '--binary', 'HEAD', '--', ...paths], this.log);
  }

  async applyPatch(repoRoot: string, patchPath: string): Promise<void> {
    await runGit(repoRoot, ['apply', '--3way', '--whitespace=nowarn', patchPath], this.log);
  }

  async listStashes(repositories?: RepositoryRef[]): Promise<StashEntry[]> {
    const repos = repositories ?? await this.discoverRepositories();
    const entries = await mapLimit(repos, 4, async (repo) => this.listRepoStashes(repo));
    return entries.flat();
  }

  async createStash(repoRoot: string, message: string, includeUntracked: boolean): Promise<void> {
    const args = ['stash', 'push'];
    if (includeUntracked) {
      args.push('-u');
    }
    args.push('-m', message);
    await runGit(repoRoot, args, this.log);
  }

  async createStashForChanges(changes: GitChange[], message: string, includeUntracked: boolean): Promise<void> {
    const byRepo = groupPathsByRepo(changes);

    for (const [repoRoot, repoChanges] of byRepo) {
      const paths = uniquePaths(repoChanges.flatMap(pathsKnownToGit));
      if (paths.length === 0) {
        continue;
      }

      const args = ['stash', 'push'];
      if (includeUntracked) {
        args.push('-u');
      }
      args.push('-m', message, '--', ...paths);
      await runGit(repoRoot, args, this.log);
    }
  }

  async applyStash(stash: StashEntry): Promise<void> {
    await runGit(stash.repoRoot, ['stash', 'apply', stash.ref], this.log);
  }

  async popStash(stash: StashEntry): Promise<void> {
    await runGit(stash.repoRoot, ['stash', 'pop', stash.ref], this.log);
  }

  async dropStash(stash: StashEntry): Promise<void> {
    await runGit(stash.repoRoot, ['stash', 'drop', stash.ref], this.log);
  }

  async showStashPatch(stash: StashEntry): Promise<string> {
    return runGit(stash.repoRoot, ['stash', 'show', '-p', '--binary', stash.ref], this.log);
  }

  async discoverRepositories(force = false): Promise<RepositoryRef[]> {
    if (!force && this.repositoryCache) {
      return this.repositoryCache;
    }

    const [workspaceRepos, gitApiRepos] = await Promise.all([
      this.discoverViaWorkspaceFolders(),
      withTimeout(
        this.discoverViaGitExtension(),
        300,
        [],
        () => this.log?.('Git extension repository discovery timed out; using workspace folder discovery for this refresh')
      )
    ]);

    this.repositoryCache = uniqueRepositories([
      ...workspaceRepos.map((repo) => repo.root),
      ...gitApiRepos.map((repo) => repo.root)
    ]);
    return this.repositoryCache;
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
        runGit(repo.root, ['rev-parse', '--git-dir'], this.log),
        runGit(repo.root, ['rev-parse', '--git-common-dir'], this.log)
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
    try {
      const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
      if (!extension) {
        return [];
      }

      const api = extension.isActive ? extension.exports.getAPI(1) : (await extension.activate()).getAPI(1);
      return uniqueRepositories(
        api.repositories.map((repo) => repo.rootUri.fsPath)
      );
    } catch {
      return [];
    }
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

  private async listRepoStashes(repo: RepositoryRef): Promise<StashEntry[]> {
    const output = await runGit(repo.root, ['stash', 'list', '--format=%gd%x1f%H%x1f%ct%x1f%s'], this.log);
    const lines = output.split(/\r?\n/).filter(Boolean);
    return Promise.all(lines.map(async (line) => {
      const [ref, hash, createdAtSeconds, ...messageParts] = line.split('\x1f');
      const message = messageParts.join('\x1f');
      return {
        repoRoot: repo.root,
        repoName: repo.name,
        ref,
        hash,
        createdAt: new Date(Number(createdAtSeconds) * 1000).toISOString(),
        message,
        files: await this.listStashFiles(repo.root, ref)
      };
    }));
  }

  private async listStashFiles(repoRoot: string, ref: string): Promise<StashFile[]> {
    const output = await runGit(repoRoot, ['stash', 'show', '--name-status', ref], this.log);
    return output.split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [status, ...pathParts] = line.split(/\s+/);
        return { status, path: pathParts.join(' ') };
      });
  }
}

interface RunGitOptions {
  noOptionalLocks?: boolean;
}

export function runGit(
  repoRoot: string,
  args: string[],
  log?: (message: string) => void,
  options: RunGitOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    cp.execFile('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      maxBuffer: 25 * 1024 * 1024,
      env: options.noOptionalLocks
        ? { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
        : process.env
    }, (error, stdout, stderr) => {
      log?.(`git -C ${repoRoot} ${args.join(' ')} (${Date.now() - start}ms)`);
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

function pathsKnownToGit(change: GitChange): string[] {
  return [change.path, change.originalPath].filter(isDefined);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
  onTimeout: () => void
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeout = setTimeout(() => {
      onTimeout();
      resolve(fallback);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizePath(value: string): string {
  return path.resolve(value);
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
