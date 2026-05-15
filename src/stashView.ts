import * as path from 'path';
import * as vscode from 'vscode';
import { StashEntry, StashFile } from './model';

export type StashTreeNode = StashRepositoryNode | StashNode | StashFileNode;

export interface StashRepositoryNode {
  type: 'repository';
  id: string;
  repoRoot: string;
  repoName: string;
  stashes: StashEntry[];
}

export interface StashNode {
  type: 'stash';
  id: string;
  stash: StashEntry;
}

export interface StashFileNode {
  type: 'stashFile';
  id: string;
  stash: StashEntry;
  file: StashFile;
}

export class StashTreeProvider implements vscode.TreeDataProvider<StashTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<StashTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private repositories: StashRepositoryNode[] = [];

  update(stashes: StashEntry[]): void {
    this.repositories = groupStashesByRepository(stashes);
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(node: StashTreeNode): vscode.TreeItem {
    if (node.type === 'repository') {
      return repositoryItem(node);
    }
    if (node.type === 'stash') {
      return stashItem(node);
    }
    return stashFileItem(node);
  }

  getChildren(node?: StashTreeNode): StashTreeNode[] {
    if (!node) {
      return this.repositories;
    }

    if (node.type === 'repository') {
      return node.stashes.map((stash) => ({ type: 'stash', id: `stash:${stash.repoRoot}:${stash.ref}`, stash }));
    }

    if (node.type === 'stash') {
      return node.stash.files.map((file) => ({
        type: 'stashFile',
        id: `stash:${node.stash.repoRoot}:${node.stash.ref}/file:${file.path}`,
        stash: node.stash,
        file
      }));
    }

    return [];
  }
}

export function isStashNode(value: unknown): value is StashNode {
  return Boolean(value && typeof value === 'object' && (value as { type?: string }).type === 'stash');
}

function repositoryItem(node: StashRepositoryNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.repoName, vscode.TreeItemCollapsibleState.Expanded);
  item.description = formatCount(node.stashes.length);
  item.tooltip = node.repoRoot;
  item.contextValue = 'repository';
  item.iconPath = new vscode.ThemeIcon('repo');
  return item;
}

function stashItem(node: StashNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.stash.message || node.stash.ref, vscode.TreeItemCollapsibleState.Collapsed);
  item.description = node.stash.ref;
  item.tooltip = `${node.stash.repoRoot}\n${node.stash.createdAt}`;
  item.contextValue = 'stash';
  item.iconPath = new vscode.ThemeIcon('repo-push');
  return item;
}

function stashFileItem(node: StashFileNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.file.path, vscode.TreeItemCollapsibleState.None);
  item.description = node.file.status;
  item.tooltip = path.join(node.stash.repoRoot, node.file.path);
  item.contextValue = 'stashFile';
  item.iconPath = new vscode.ThemeIcon('file');
  item.command = {
    command: 'golandVersionControl.openStashDiff',
    title: 'Open Stash Diff',
    arguments: [node]
  };
  return item;
}

function groupStashesByRepository(stashes: StashEntry[]): StashRepositoryNode[] {
  const repositories = new Map<string, StashRepositoryNode>();
  for (const stash of stashes) {
    const existing = repositories.get(stash.repoRoot);
    if (existing) {
      existing.stashes.push(stash);
      continue;
    }

    repositories.set(stash.repoRoot, {
      type: 'repository',
      id: `repo:${stash.repoRoot}`,
      repoRoot: stash.repoRoot,
      repoName: stash.repoName,
      stashes: [stash]
    });
  }

  return [...repositories.values()].sort((left, right) => left.repoName.localeCompare(right.repoName));
}

function formatCount(count: number): string {
  return count === 1 ? '1 stash' : `${count} stashes`;
}
