import { ChangelistStore } from './changelists';
import { ChangeCategory, GitChange, RepositoryRef, WorkspaceState } from './model';

export type ChangeTreeNode =
  | RepositoryNode
  | GroupNode
  | FileNode;

export interface RepositoryNode {
  type: 'repository';
  id: string;
  label: string;
  repo: RepositoryRef;
  count: number;
  children: ChangeTreeNode[];
}

export interface GroupNode {
  type: 'group';
  id: string;
  label: string;
  category?: ChangeCategory;
  count: number;
  children: ChangeTreeNode[];
}

export interface FileNode {
  type: 'file';
  id: string;
  label: string;
  description?: string;
  change: GitChange;
}

export function buildTree(state: WorkspaceState, changelists: ChangelistStore, groupBy: string): RepositoryNode[] {
  const repos = new Map<string, RepositoryNode>();

  for (const repo of state.repositories) {
    repos.set(repo.root, {
      type: 'repository',
      id: `repo:${repo.root}`,
      label: repo.name,
      repo,
      count: 0,
      children: []
    });
  }

  for (const change of state.changes) {
    const repoNode = repos.get(change.repoRoot);
    if (!repoNode) {
      continue;
    }

    repoNode.count += 1;
    const groups = groupLabels(change, changelists, groupBy);
    let children = repoNode.children;
    let currentId = repoNode.id;

    for (const group of groups) {
      currentId = `${currentId}/group:${group}`;
      const node = findOrCreateGroup(children, currentId, group, change.category);
      node.count += 1;
      children = node.children;
    }

    insertFile(children, currentId, change);
  }

  return [...repos.values()].filter((repo) => repo.children.length > 0);
}

function groupLabels(change: GitChange, changelists: ChangelistStore, groupBy: string): string[] {
  if (groupBy === 'status') {
    return [change.statusText];
  }

  if (groupBy === 'folder') {
    return [change.category];
  }

  return [displayGroupLabel(changelists.getChangelist(change))];
}

function findOrCreateGroup(children: ChangeTreeNode[], id: string, label: string, category: ChangeCategory): GroupNode {
  const existing = children.find((node): node is GroupNode => node.type === 'group' && node.id === id);
  if (existing) {
    return existing;
  }

  const node: GroupNode = { type: 'group', id, label, category, count: 0, children: [] };
  children.push(node);
  children.sort(compareNodes);
  return node;
}

function insertFile(children: ChangeTreeNode[], parentId: string, change: GitChange): void {
  children.push({
    type: 'file',
    id: `${parentId}/file:${change.area}:${change.path}`,
    label: change.path,
    description: descriptionFor(change),
    change
  });
  children.sort(compareNodes);
}

function descriptionFor(change: GitChange): string | undefined {
  if (change.originalPath) {
    return `from ${change.originalPath}`;
  }

  if (change.area === 'index') {
    return 'staged';
  }

  return undefined;
}

function compareNodes(left: ChangeTreeNode, right: ChangeTreeNode): number {
  return nodeRank(left) - nodeRank(right) || left.label.localeCompare(right.label);
}

function nodeRank(node: ChangeTreeNode): number {
  switch (node.type) {
    case 'group':
      return groupRank(node.label);
    case 'file':
      return 20;
    case 'repository':
      return 0;
  }
}

function groupRank(label: string): number {
  switch (label) {
    case 'Conflicts':
      return 0;
    case 'Staged':
      return 1;
    case 'Changes':
      return 2;
    case 'Unversioned':
    case 'Unversioned Files':
      return 3;
    default:
      return 10;
  }
}

function displayGroupLabel(label: string): string {
  switch (label) {
    case 'Unversioned':
      return 'Unversioned Files';
    case 'Conflicts':
      return 'Merge Conflicts';
    default:
      return label;
  }
}
