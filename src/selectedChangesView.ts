import * as vscode from 'vscode';
import { GitChange } from './model';
import { decorationUri } from './treeView';

export interface SelectedChangeNode {
  type: 'selectedChange';
  id: string;
  change: GitChange;
}

export class SelectedChangesTreeProvider implements vscode.TreeDataProvider<SelectedChangeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<SelectedChangeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private changes: GitChange[] = [];

  update(changes: GitChange[]): void {
    this.changes = changes;
    this.onDidChangeTreeDataEmitter.fire();
  }

  getChanges(): GitChange[] {
    return this.changes;
  }

  getTreeItem(node: SelectedChangeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.change.path, vscode.TreeItemCollapsibleState.None);
    item.description = `${node.change.repoName} ${node.change.statusText.toLowerCase()}`;
    item.tooltip = node.change.originalPath
      ? `${node.change.originalPath} -> ${node.change.path}`
      : node.change.path;
    item.resourceUri = decorationUri(node.change);
    item.contextValue = 'selectedChange';
    item.iconPath = new vscode.ThemeIcon('file');
    item.command = {
      command: 'golandVersionControl.openDiff',
      title: 'Open Diff',
      arguments: [node.change]
    };
    return item;
  }

  getChildren(): SelectedChangeNode[] {
    return this.changes.map((change) => ({
      type: 'selectedChange',
      id: `${change.repoRoot}:${change.area}:${change.path}`,
      change
    }));
  }
}
