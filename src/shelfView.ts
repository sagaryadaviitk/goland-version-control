import * as path from 'path';
import * as vscode from 'vscode';
import { ShelfEntry, ShelfFile } from './model';

export type ShelfTreeNode = ShelfNode | ShelfFileNode;

export interface ShelfNode {
  type: 'shelf';
  id: string;
  shelf: ShelfEntry;
}

export interface ShelfFileNode {
  type: 'shelfFile';
  id: string;
  shelf: ShelfEntry;
  file: ShelfFile;
}

export class ShelfTreeProvider implements vscode.TreeDataProvider<ShelfTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ShelfTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private shelves: ShelfEntry[] = [];

  update(shelves: ShelfEntry[]): void {
    this.shelves = shelves;
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(node: ShelfTreeNode): vscode.TreeItem {
    if (node.type === 'shelf') {
      return shelfItem(node);
    }
    return shelfFileItem(node);
  }

  getChildren(node?: ShelfTreeNode): ShelfTreeNode[] {
    if (!node) {
      return this.shelves.map((shelf) => ({ type: 'shelf', id: `shelf:${shelf.id}`, shelf }));
    }

    if (node.type === 'shelf') {
      return node.shelf.files.map((file) => ({
        type: 'shelfFile',
        id: `shelf:${node.shelf.id}/file:${file.path}`,
        shelf: node.shelf,
        file
      }));
    }

    return [];
  }
}

export function isShelfNode(value: unknown): value is ShelfNode {
  return Boolean(value && typeof value === 'object' && (value as { type?: string }).type === 'shelf');
}

function shelfItem(node: ShelfNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.shelf.name, vscode.TreeItemCollapsibleState.Expanded);
  item.description = `${node.shelf.repoName} ${formatCount(node.shelf.fileCount)}`;
  item.tooltip = `${node.shelf.repoRoot}\n${node.shelf.createdAt}`;
  item.contextValue = 'shelf';
  item.iconPath = new vscode.ThemeIcon('archive');
  return item;
}

function shelfFileItem(node: ShelfFileNode): vscode.TreeItem {
  const label = node.file.originalPath ? `${node.file.originalPath} -> ${node.file.path}` : node.file.path;
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = node.file.statusText;
  item.tooltip = path.join(node.shelf.repoRoot, node.file.path);
  item.contextValue = 'shelfFile';
  item.iconPath = new vscode.ThemeIcon('file');
  item.command = {
    command: 'golandVersionControl.openShelfDiff',
    title: 'Open Shelf Diff',
    arguments: [node]
  };
  return item;
}

function formatCount(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}
