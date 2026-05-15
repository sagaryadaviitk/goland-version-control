import * as fs from 'fs';
import * as path from 'path';
import { RepositoryRef } from './model';

export type ResolveGitRoot = (candidate: string) => Promise<string | undefined>;
export type ListChildren = (folder: string) => Promise<string[]>;

export async function discoverWorkspaceRepositoryRoots(
  workspaceFolders: string[],
  resolveGitRoot: ResolveGitRoot,
  listChildren: ListChildren
): Promise<string[]> {
  const roots = new Set<string>();

  const discovered = await mapLimit(workspaceFolders, 4, async (folder) => {
    const folderRoots: string[] = [];
    const root = await resolveGitRoot(folder);
    if (root) {
      folderRoots.push(root);
    }

    const childRoots = await mapLimit(await listChildren(folder), 8, async (child) => {
      const childRoot = await resolveGitRoot(child);
      return childRoot ? [childRoot] : [];
    });

    return [...folderRoots, ...childRoots.flat()];
  });

  for (const root of discovered.flat()) {
    roots.add(root);
  }

  return [...roots];
}

export function uniqueRepositories(roots: string[]): RepositoryRef[] {
  const unique = [...new Set(roots.map(canonicalRoot))];
  return unique
    .sort((left, right) => left.localeCompare(right))
    .map((root) => ({ root, name: path.basename(root) }));
}

function canonicalRoot(root: string): string {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
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
