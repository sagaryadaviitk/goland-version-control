import { GitChange, changeKey } from './model';
import { FileNode } from './treeModel';

export function resolveSingleChange(input?: unknown): GitChange | undefined {
  if (isFileNode(input)) {
    return input.change;
  }

  if (isGitChange(input)) {
    return input;
  }

  return undefined;
}

export function resolveChanges(input?: unknown, selected?: unknown[]): GitChange[] {
  const primary = resolveSingleChange(input);
  const selectedChanges = uniqueChanges((selected ?? []).flatMap((candidate) => {
    const change = resolveSingleChange(candidate);
    return change ? [change] : [];
  }));

  if (selectedChanges.length === 0) {
    return primary ? [primary] : [];
  }

  if (!primary) {
    return selectedChanges;
  }

  const primaryKey = changeKey(primary);
  if (selectedChanges.some((change) => changeKey(change) === primaryKey)) {
    return selectedChanges;
  }

  return [primary];
}

export function isFileNode(value: unknown): value is FileNode {
  return Boolean(value && typeof value === 'object' && (value as { type?: string }).type === 'file');
}

function isGitChange(value: unknown): value is GitChange {
  return Boolean(value && typeof value === 'object' && typeof (value as { path?: unknown }).path === 'string');
}

function uniqueChanges(changes: GitChange[]): GitChange[] {
  const seen = new Set<string>();
  const unique: GitChange[] = [];
  for (const change of changes) {
    const key = changeKey(change);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(change);
  }
  return unique;
}
