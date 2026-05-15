import * as path from 'path';
import * as vscode from 'vscode';
import { ChangeTreeNode, buildTree, collectChanges, FileNode, RepositoryNode } from './treeModel';
import { ChangelistStore } from './changelists';
import { ChangeArea, ChangeKind, ExtensionSettings, GitChange, WorkspaceState } from './model';

export class LocalChangesTreeProvider implements vscode.TreeDataProvider<ChangeTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ChangeTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private roots: RepositoryNode[] = [];

  constructor(private readonly changelists: ChangelistStore) {}

  update(state: WorkspaceState, settings: ExtensionSettings): void {
    this.roots = buildTree(state, this.changelists, settings.groupBy);
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(node: ChangeTreeNode): vscode.TreeItem {
    switch (node.type) {
      case 'repository':
        return repositoryItem(node);
      case 'group':
        return groupItem(node);
      case 'file':
        return fileItem(node);
    }
  }

  getChildren(node?: ChangeTreeNode): ChangeTreeNode[] {
    if (!node) {
      return this.roots;
    }

    if ('children' in node) {
      return node.children;
    }

    return [];
  }
}

export function isFileNode(value: unknown): value is FileNode {
  return Boolean(value && typeof value === 'object' && (value as { type?: string }).type === 'file');
}

function repositoryItem(node: RepositoryNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
  item.description = formatCount(node.count);
  item.tooltip = node.repo.root;
  item.contextValue = contextForContainer('repository', node);
  item.iconPath = new vscode.ThemeIcon('repo');
  return item;
}

function groupItem(node: ChangeTreeNode & { type: 'group' }): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, groupCollapseState(node.label));
  item.description = formatCount(node.count);
  item.contextValue = contextForContainer('group', node);
  item.iconPath = groupIcon(node.label);
  return item;
}

function fileItem(node: FileNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  item.description = node.description;
  item.tooltip = tooltipFor(node);
  item.resourceUri = decorationUri(node.change);
  item.contextValue = contextFor(node);
  item.iconPath = fileIcon(node.change);
  item.command = {
    command: 'golandVersionControl.openDiff',
    title: 'Open Diff',
    arguments: [node]
  };
  return item;
}

export class ChangeDecorationProvider implements vscode.FileDecorationProvider {
  private readonly onDidChangeFileDecorationsEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.onDidChangeFileDecorationsEmitter.event;

  refresh(): void {
    this.onDidChangeFileDecorationsEmitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const status = parseDecorationStatus(uri);
    if (!status) {
      return undefined;
    }

    return new vscode.FileDecoration(
      statusBadge(status),
      statusTooltip(status),
      statusColor(status)
    );
  }
}

export function decorationUri(change: GitChange): vscode.Uri {
  return vscode.Uri.file(path.join(change.repoRoot, change.path)).with({
    query: new URLSearchParams({
      gvcArea: change.area,
      gvcKind: change.kind,
      gvcStatus: change.statusText
    }).toString()
  });
}

function tooltipFor(node: FileNode): string {
  if (node.change.originalPath) {
    return `${node.change.statusText}: ${node.change.originalPath} -> ${node.change.path}`;
  }
  return `${node.change.statusText}: ${node.change.path}`;
}

function contextFor(node: FileNode): string {
  const contexts = ['change', 'discardable'];
  if (node.change.area !== 'untracked') {
    contexts.push('shelvable');
  }
  if (node.change.area === 'index') {
    contexts.push('unstageable');
  }
  if (node.change.area === 'workingTree' || node.change.area === 'untracked') {
    contexts.push('stageable');
  }
  return contexts.join('.');
}

function contextForContainer(base: string, node: ChangeTreeNode): string {
  const changes = collectChanges(node);
  const contexts = [base];
  if (changes.length > 0) {
    contexts.push('change', 'discardable');
  }
  if (changes.some((change) => change.area === 'workingTree' || change.area === 'untracked')) {
    contexts.push('stageable');
  }
  if (changes.some((change) => change.area === 'index')) {
    contexts.push('unstageable');
  }
  if (changes.some((change) => change.area !== 'untracked')) {
    contexts.push('shelvable');
  }
  return contexts.join('.');
}

function groupIcon(label: string): vscode.ThemeIcon {
  switch (label) {
    case 'Conflicts':
    case 'Merge Conflicts':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.red'));
    case 'Staged':
      return new vscode.ThemeIcon('checklist', new vscode.ThemeColor('charts.green'));
    case 'Unversioned':
    case 'Unversioned Files':
      return new vscode.ThemeIcon('new-file', new vscode.ThemeColor('charts.green'));
    default:
      return new vscode.ThemeIcon('diff', new vscode.ThemeColor('charts.blue'));
  }
}

function groupCollapseState(label: string): vscode.TreeItemCollapsibleState {
  if (label === 'Unversioned Files') {
    return vscode.TreeItemCollapsibleState.Collapsed;
  }
  return vscode.TreeItemCollapsibleState.Expanded;
}

function formatCount(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

function fileIcon(change: GitChange): vscode.ThemeIcon {
  switch (change.kind) {
    case 'added':
    case 'untracked':
      return new vscode.ThemeIcon('diff-added', statusColor(change));
    case 'deleted':
      return new vscode.ThemeIcon('diff-removed', statusColor(change));
    case 'renamed':
    case 'copied':
      return new vscode.ThemeIcon('git-compare', statusColor(change));
    case 'conflict':
      return new vscode.ThemeIcon('warning', statusColor(change));
    default:
      return new vscode.ThemeIcon('diff-modified', statusColor(change));
  }
}

function parseDecorationStatus(uri: vscode.Uri): { area: ChangeArea; kind: ChangeKind; statusText: string } | undefined {
  if (!uri.query) {
    return undefined;
  }

  const params = new URLSearchParams(uri.query);
  const area = params.get('gvcArea') as ChangeArea | null;
  const kind = params.get('gvcKind') as ChangeKind | null;
  const statusText = params.get('gvcStatus') ?? '';
  if (!area || !kind) {
    return undefined;
  }

  return { area, kind, statusText };
}

function statusBadge(status: { area: ChangeArea; kind: ChangeKind }): string {
  if (status.area === 'conflict' || status.kind === 'conflict') {
    return '!';
  }

  if (status.area === 'index') {
    return stagedBadge(status.kind);
  }

  switch (status.kind) {
    case 'added':
      return 'A';
    case 'copied':
      return 'C';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'typechange':
      return 'T';
    case 'untracked':
      return '?';
    case 'modified':
    default:
      return 'M';
  }
}

function stagedBadge(kind: ChangeKind): string {
  if (kind === 'deleted') {
    return 'D';
  }
  if (kind === 'added') {
    return 'A';
  }
  if (kind === 'renamed') {
    return 'R';
  }
  return 'S';
}

function statusTooltip(status: { area: ChangeArea; kind: ChangeKind; statusText: string }): string {
  if (status.area === 'index') {
    return `Staged ${status.statusText.toLowerCase()}`;
  }
  if (status.area === 'conflict') {
    return 'Merge conflict';
  }
  return status.statusText;
}

function statusColor(status: { area: ChangeArea; kind: ChangeKind }): vscode.ThemeColor {
  if (status.area === 'conflict' || status.kind === 'conflict') {
    return new vscode.ThemeColor('charts.red');
  }

  if (status.area === 'index') {
    return new vscode.ThemeColor('charts.green');
  }

  switch (status.kind) {
    case 'added':
    case 'untracked':
      return new vscode.ThemeColor('charts.green');
    case 'deleted':
      return new vscode.ThemeColor('charts.red');
    case 'renamed':
    case 'copied':
      return new vscode.ThemeColor('charts.purple');
    default:
      return new vscode.ThemeColor('charts.blue');
  }
}
