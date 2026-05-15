import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from './gitService';
import { ExtensionSettings, GitChange, ShelfEntry, ShelfFile, ShelfIndex } from './model';

export interface ShelfCreateResult {
  shelves: ShelfEntry[];
  skippedUntracked: GitChange[];
}

const INDEX_FILE = 'index.json';

export class ShelfService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly git: GitService,
    private readonly readSettings: () => ExtensionSettings
  ) {}

  async listShelves(): Promise<ShelfEntry[]> {
    const index = await this.readIndex();
    return index.shelves;
  }

  async createShelf(changes: GitChange[], name: string, removeAfterSave: boolean): Promise<ShelfCreateResult> {
    const skippedUntracked = changes.filter((change) => change.area === 'untracked');
    const tracked = uniqueRepoPathChanges(changes.filter((change) => change.area !== 'untracked'));
    const shelves: ShelfEntry[] = [];

    for (const [repoRoot, repoChanges] of groupByRepo(tracked)) {
      const paths = repoChanges.map((change) => change.path);
      const patch = await this.git.diffAgainstHead(repoRoot, paths);
      if (!patch.trim()) {
        continue;
      }

      const root = await this.shelfRoot();
      const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const patchPath = path.join(root, `${id}.patch`);
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(patchPath, patch, 'utf8');

      const firstChange = repoChanges[0];
      const now = new Date().toISOString();
      shelves.push({
        id,
        name,
        repoRoot,
        repoName: firstChange.repoName,
        baseCommit: await this.safeHeadCommit(repoRoot),
        createdAt: now,
        updatedAt: now,
        fileCount: repoChanges.length,
        patchPath,
        files: repoChanges.map(toShelfFile)
      });
    }

    if (shelves.length > 0) {
      const index = await this.readIndex();
      index.shelves = [...shelves, ...index.shelves].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      await this.writeIndex(index);
    }

    if (removeAfterSave && shelves.length > 0) {
      await this.git.discard(tracked);
    }

    return { shelves, skippedUntracked };
  }

  async restoreShelf(shelf: ShelfEntry, removeAfterRestore: boolean): Promise<void> {
    await this.git.applyPatch(shelf.repoRoot, shelf.patchPath, shelfPaths(shelf));
    if (removeAfterRestore) {
      await this.deleteShelf(shelf);
    }
  }

  async deleteShelf(shelf: ShelfEntry): Promise<void> {
    const index = await this.readIndex();
    index.shelves = index.shelves.filter((candidate) => candidate.id !== shelf.id);
    await this.writeIndex(index);
    await fs.rm(shelf.patchPath, { force: true });
  }

  async readShelfPatch(shelf: ShelfEntry): Promise<string> {
    return fs.readFile(shelf.patchPath, 'utf8');
  }

  private async readIndex(): Promise<ShelfIndex> {
    const indexPath = await this.indexPath();
    try {
      const raw = await fs.readFile(indexPath, 'utf8');
      const parsed = JSON.parse(raw) as ShelfIndex;
      return {
        version: 1,
        shelves: Array.isArray(parsed.shelves) ? parsed.shelves : []
      };
    } catch {
      return { version: 1, shelves: [] };
    }
  }

  private async writeIndex(index: ShelfIndex): Promise<void> {
    const indexPath = await this.indexPath();
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  }

  private async indexPath(): Promise<string> {
    return path.join(await this.shelfRoot(), INDEX_FILE);
  }

  private async shelfRoot(): Promise<string> {
    const configured = this.readSettings().shelfLocation.trim();
    if (configured) {
      if (path.isAbsolute(configured)) {
        return configured;
      }
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      return path.resolve(workspaceRoot ?? process.cwd(), configured);
    }

    const storageUri = this.context.storageUri ?? this.context.globalStorageUri;
    return path.join(storageUri.fsPath, 'shelf');
  }

  private async safeHeadCommit(repoRoot: string): Promise<string> {
    try {
      return await this.git.getHeadCommit(repoRoot);
    } catch {
      return '';
    }
  }
}

function toShelfFile(change: GitChange): ShelfFile {
  return {
    path: change.path,
    originalPath: change.originalPath,
    statusText: change.statusText
  };
}

function uniqueRepoPathChanges(changes: GitChange[]): GitChange[] {
  const seen = new Set<string>();
  const unique: GitChange[] = [];
  for (const change of changes) {
    const key = `${change.repoRoot}\0${change.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(change);
  }
  return unique;
}

function groupByRepo(changes: GitChange[]): Map<string, GitChange[]> {
  const byRepo = new Map<string, GitChange[]>();
  for (const change of changes) {
    const existing = byRepo.get(change.repoRoot) ?? [];
    existing.push(change);
    byRepo.set(change.repoRoot, existing);
  }
  return byRepo;
}

function shelfPaths(shelf: ShelfEntry): string[] {
  return [...new Set(shelf.files.flatMap((file) => [file.path, file.originalPath].filter(isDefined)))];
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
