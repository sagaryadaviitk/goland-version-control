import { GitChange, changeKey } from './model';
import { ChangeTreeNode, FileNode, collectChanges } from './treeModel';

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
  const primaryChanges = changesFromCandidate(input);
  const selectedChanges = uniqueChanges((selected ?? []).flatMap(changesFromCandidate));

  if (selectedChanges.length === 0) {
    return primaryChanges;
  }

  if (primaryChanges.length === 0) {
    return selectedChanges;
  }

  const primaryKeys = new Set(primaryChanges.map(changeKey));
  if (selectedChanges.some((change) => primaryKeys.has(changeKey(change)))) {
    return selectedChanges;
  }

  return primaryChanges;
}

export function isFileNode(value: unknown): value is FileNode {
  return Boolean(value && typeof value === 'object' && (value as { type?: string }).type === 'file');
}

function isGitChange(value: unknown): value is GitChange {
  return Boolean(value && typeof value === 'object' && typeof (value as { path?: unknown }).path === 'string');
}

function changesFromCandidate(candidate: unknown): GitChange[] {
  const change = resolveSingleChange(candidate);
  if (change) {
    return [change];
  }

  if (isChangeTreeNode(candidate)) {
    return collectChanges(candidate);
  }

  return [];
}

function isChangeTreeNode(value: unknown): value is ChangeTreeNode {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  if (type === 'file') {
    return isFileNode(value);
  }

  return (type === 'group' || type === 'repository') && Array.isArray((value as { children?: unknown }).children);
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
