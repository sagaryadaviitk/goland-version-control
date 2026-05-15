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

  for (const folder of workspaceFolders) {
    const root = await resolveGitRoot(folder);
    if (root) {
      roots.add(root);
    }

    for (const child of await listChildren(folder)) {
      const childRoot = await resolveGitRoot(child);
      if (childRoot) {
        roots.add(childRoot);
      }
    }
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
