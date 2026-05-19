import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildChangeRecords, parsePorcelainStatus } from './gitStatus';
import { buildAreaAwareDiscardPlan, buildDiffRequests, buildStashPlans } from './gitOperationPlans';
import { GitChange, RepositoryRef, StashEntry, StashFile, WorkspaceState } from './model';
import { GitWatchRoot } from './refreshCoordinator';
import { discoverWorkspaceRepositoryRoots, uniqueRepositories } from './repositoryDiscovery';
import { RepositoryChanges, mergeRepositoryChanges } from './workspaceStateMerge';

const STATUS_TIMEOUT_MS = 6000;

interface GitExtension {
  getAPI(version: 1): GitApi;
}

interface GitApi {
  repositories: Array<{ rootUri: vscode.Uri }>;
}

export class GitService {
  private repositoryCache: RepositoryRef[] | undefined;
  private readonly gitWatchRootCache = new Map<string, GitWatchRoot>();

  constructor(private readonly log?: (message: string) => void) {}

  clearRepositoryCache(): void {
    this.repositoryCache = undefined;
    this.gitWatchRootCache.clear();
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
      async (repo): Promise<RepositoryChanges> => {
        try {
          return { repo, changes: await this.getChanges(repo, showUntracked), failed: false };
        } catch (error) {
          this.log?.(`git status failed for ${repo.root}: ${messageFrom(error)}`);
          return { repo, changes: [], failed: true };
        }
      }
    );

    return {
      repositories,
      changes: mergeRepositoryChanges(repositories, targetRepositories, changesByRepository, options.previous).sort(compareChanges)
    };
  }

  async getChanges(repo: RepositoryRef, showUntracked: boolean): Promise<GitChange[]> {
    const args = ['status', '--porcelain=v1', '-z', showUntracked ? '--untracked-files=all' : '--untracked-files=no'];
    const output = await runGit(repo.root, args, this.log, { noOptionalLocks: true, timeoutMs: STATUS_TIMEOUT_MS });
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
      const plan = buildAreaAwareDiscardPlan(repoChanges);

      if (plan.resetPaths.length > 0) {
        await runGit(repoRoot, ['restore', '--staged', '--worktree', '--', ...plan.resetPaths], this.log);
      }

      if (plan.indexOnlyPaths.length > 0) {
        await this.discardIndexOnlyPaths(repoRoot, plan.indexOnlyPaths);
      }

      if (plan.worktreeOnlyPaths.length > 0) {
        await runGit(repoRoot, ['restore', '--worktree', '--', ...plan.worktreeOnlyPaths], this.log);
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

  async diffForChanges(repoRoot: string, changes: GitChange[]): Promise<string> {
    const patches: string[] = [];
    for (const request of buildDiffRequests(changes)) {
      const args = request.area === 'cached'
        ? ['diff', '--cached', '--binary', 'HEAD', '--', ...request.paths]
        : ['diff', '--binary', '--', ...request.paths];
      const patch = await runGit(repoRoot, args, this.log, { noOptionalLocks: true });
      if (patch.trim()) {
        patches.push(patch);
      }
    }
    return patches.join('\n');
  }

  async applyPatch(repoRoot: string, patchPath: string, paths: string[] = []): Promise<void> {
    try {
      await runGit(repoRoot, ['apply', '--whitespace=nowarn', patchPath], this.log);
      return;
    } catch (error) {
      this.log?.(`git apply working-tree failed for ${repoRoot}: ${messageFrom(error)}`);
    }

    await runGit(repoRoot, ['apply', '--3way', '--whitespace=nowarn', patchPath], this.log);
    await this.unstageAppliedPatchPaths(repoRoot, paths);
  }

  async listStashes(repositories?: RepositoryRef[]): Promise<StashEntry[]> {
    const repos = repositories ?? await this.discoverRepositories();
    const entries = await mapLimit(repos, 4, async (repo) => {
      try {
        return await this.listRepoStashes(repo);
      } catch (error) {
        this.log?.(`git stash list failed for ${repo.root}: ${messageFrom(error)}`);
        return [];
      }
    });
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
      for (const plan of buildStashPlans(repoChanges, includeUntracked)) {
        if (plan.mode === 'worktree') {
          await this.createWorktreeOnlyStash(repoRoot, plan.paths, message);
          continue;
        }

        const args = ['stash', 'push'];
        if (plan.mode === 'staged') {
          args.push('--staged');
        }
        if (plan.includeUntracked) {
          args.push('-u');
        }
        args.push('-m', message, '--', ...plan.paths);
        await runGit(repoRoot, args, this.log);
      }
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

  async listStashFiles(stash: Pick<StashEntry, 'repoRoot' | 'ref'>): Promise<StashFile[]> {
    return this.readStashFiles(stash.repoRoot, stash.ref);
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
    const roots = await mapLimit(repositories, 8, async (repo) => this.getGitWatchRoot(repo));
    return roots.filter(isDefined);
  }

  private async getGitWatchRoot(repo: RepositoryRef): Promise<GitWatchRoot | undefined> {
    const cached = this.gitWatchRootCache.get(repo.root);
    if (cached) {
      return cached;
    }

    try {
      const [gitDir, commonDir] = await Promise.all([
        runGit(repo.root, ['rev-parse', '--git-dir'], this.log),
        runGit(repo.root, ['rev-parse', '--git-common-dir'], this.log)
      ]);

      const watchRoot = {
        gitDir: resolveGitPath(repo.root, gitDir),
        commonDir: resolveGitPath(repo.root, commonDir)
      };
      this.gitWatchRootCache.set(repo.root, watchRoot);
      return watchRoot;
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
    return lines.map((line) => {
      const [ref, hash, createdAtSeconds, ...messageParts] = line.split('\x1f');
      const message = messageParts.join('\x1f');
      return {
        repoRoot: repo.root,
        repoName: repo.name,
        ref,
        hash,
        createdAt: new Date(Number(createdAtSeconds) * 1000).toISOString(),
        message,
        files: []
      };
    });
  }

  private async readStashFiles(repoRoot: string, ref: string): Promise<StashFile[]> {
    const output = await runGit(repoRoot, ['stash', 'show', '--name-status', ref], this.log);
    return output.split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [status, ...pathParts] = line.split(/\s+/);
        return { status, path: pathParts.join(' ') };
      });
  }

  private async unstageAppliedPatchPaths(repoRoot: string, paths: string[]): Promise<void> {
    const unique = uniquePaths(paths);
    if (unique.length === 0) {
      return;
    }

    try {
      await runGit(repoRoot, ['reset', '-q', 'HEAD', '--', ...unique], this.log);
    } catch (error) {
      this.log?.(`git reset after patch apply failed for ${repoRoot}: ${messageFrom(error)}`);
    }
  }

  private async discardIndexOnlyPaths(repoRoot: string, paths: string[]): Promise<void> {
    const stagedPatch = await runGit(repoRoot, ['diff', '--cached', '--binary', 'HEAD', '--', ...paths], this.log, { noOptionalLocks: true });
    if (!stagedPatch.trim()) {
      await runGit(repoRoot, ['restore', '--staged', '--', ...paths], this.log);
      return;
    }

    await runGit(repoRoot, ['apply', '--reverse', '--cached', '--whitespace=nowarn'], this.log, { input: stagedPatch });
    try {
      await runGit(repoRoot, ['apply', '--reverse', '--whitespace=nowarn'], this.log, { input: stagedPatch });
    } catch (error) {
      this.log?.(`git apply reverse working-tree patch failed for ${repoRoot}: ${messageFrom(error)}`);
    }
  }

  private async createWorktreeOnlyStash(repoRoot: string, paths: string[], message: string): Promise<void> {
    const stagedPatch = await runGit(repoRoot, ['diff', '--cached', '--binary', 'HEAD', '--', ...paths], this.log, { noOptionalLocks: true });
    let indexPatchRemoved = false;
    let worktreePatchRemoved = false;

    try {
      if (stagedPatch.trim()) {
        await runGit(repoRoot, ['apply', '--reverse', '--cached', '--whitespace=nowarn'], this.log, { input: stagedPatch });
        indexPatchRemoved = true;
        await runGit(repoRoot, ['apply', '--reverse', '--whitespace=nowarn'], this.log, { input: stagedPatch });
        worktreePatchRemoved = true;
      }

      await runGit(repoRoot, ['stash', 'push', '-m', message, '--', ...paths], this.log);
    } finally {
      if (indexPatchRemoved) {
        await runGit(repoRoot, ['apply', '--cached', '--whitespace=nowarn'], this.log, { input: stagedPatch });
      }
      if (worktreePatchRemoved) {
        await runGit(repoRoot, ['apply', '--whitespace=nowarn'], this.log, { input: stagedPatch });
      }
    }
  }

  private async applyPatchText(repoRoot: string, patch: string, paths: string[] = []): Promise<void> {
    try {
      await runGit(repoRoot, ['apply', '--whitespace=nowarn'], this.log, { input: patch });
      return;
    } catch (error) {
      this.log?.(`git apply working-tree patch failed for ${repoRoot}: ${messageFrom(error)}`);
    }

    await runGit(repoRoot, ['apply', '--3way', '--whitespace=nowarn'], this.log, { input: patch });
    await this.unstageAppliedPatchPaths(repoRoot, paths);
  }
}

interface RunGitOptions {
  noOptionalLocks?: boolean;
  input?: string;
  timeoutMs?: number;
}

export function runGit(
  repoRoot: string,
  args: string[],
  log?: (message: string) => void,
  options: RunGitOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = cp.execFile('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      maxBuffer: 25 * 1024 * 1024,
      timeout: options.timeoutMs,
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
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
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
