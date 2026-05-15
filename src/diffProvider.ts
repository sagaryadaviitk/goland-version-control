import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from './gitService';
import { parseGofmtDiagnostics } from './goSyntaxDiagnostics';
import { GitChange } from './model';

interface VirtualGitDocument {
  repoRoot: string;
  filePath: string;
  ref: 'HEAD' | 'INDEX' | 'WORKTREE' | 'EMPTY';
}

export interface OpenDiffOptions {
  openAtFirstChange?: boolean;
}

const SCHEME = 'goland-version-control';
const FIRST_CHANGE_DELAY_MS = 125;

export class DiffController implements vscode.Disposable {
  private readonly contentProvider: GitDiffContentProvider;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('goland-version-control');

  constructor(private readonly git: GitService) {
    this.contentProvider = new GitDiffContentProvider(git);
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this,
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this.contentProvider)
    );
  }

  dispose(): void {
    this.contentProvider.dispose();
    this.diagnostics.dispose();
  }

  async openDiff(change: GitChange, options: OpenDiffOptions = {}): Promise<void> {
    const left = this.trackVirtualUri(leftUri(change));
    const right = this.trackVirtualUri(rightUri(change));
    const title = diffTitle(change);
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: false });
    await this.updateDiffDiagnostics(left, right);

    if (shouldRevealFirstChange(change, options.openAtFirstChange ?? false)) {
      setTimeout(() => {
        void vscode.commands.executeCommand('workbench.action.editor.nextChange');
      }, FIRST_CHANGE_DELAY_MS);
    }
  }

  refreshForFile(fsPath: string): void {
    this.contentProvider.refreshForFile(fsPath);
    void this.updateGoSyntaxDiagnostics(vscode.Uri.file(fsPath));
  }

  private trackVirtualUri(uri: vscode.Uri): vscode.Uri {
    if (uri.scheme === SCHEME) {
      this.contentProvider.track(uri);
    }
    return uri;
  }

  private async updateDiffDiagnostics(...uris: vscode.Uri[]): Promise<void> {
    await Promise.all(uris.map((uri) => this.updateGoSyntaxDiagnostics(uri)));
  }

  private async updateGoSyntaxDiagnostics(uri: vscode.Uri): Promise<void> {
    if (!isGoUri(uri)) {
      this.diagnostics.delete(uri);
      return;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();
    if (!text.trim()) {
      this.diagnostics.delete(uri);
      return;
    }

    try {
      await runGofmtCheck(text);
      this.diagnostics.delete(uri);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnostics = parseGofmtDiagnostics(message).map((diagnostic) => {
        const position = new vscode.Position(diagnostic.line, diagnostic.character);
        const range = document.validateRange(new vscode.Range(position, position.translate(0, 1)));
        return new vscode.Diagnostic(range, diagnostic.message, vscode.DiagnosticSeverity.Error);
      });

      for (const diagnostic of diagnostics) {
        diagnostic.source = 'gofmt';
      }

      this.diagnostics.set(uri, diagnostics);
    }
  }
}

export class GitDiffContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  private readonly virtualUrisByFile = new Map<string, Set<vscode.Uri>>();

  constructor(private readonly git: GitService) {}

  track(uri: vscode.Uri): void {
    const request = parseVirtualUri(uri);
    const key = fileKey(request.repoRoot, request.filePath);
    const existing = this.virtualUrisByFile.get(key) ?? new Set<vscode.Uri>();
    existing.add(uri);
    this.virtualUrisByFile.set(key, existing);
  }

  refreshForFile(fsPath: string): void {
    const uris = this.virtualUrisByFile.get(path.resolve(fsPath));
    if (!uris) {
      return;
    }

    for (const uri of uris) {
      this.onDidChangeEmitter.fire(uri);
    }
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const request = parseVirtualUri(uri);
    if (request.ref === 'EMPTY') {
      return '';
    }

    if (request.ref === 'WORKTREE') {
      try {
        return await fs.readFile(path.join(request.repoRoot, request.filePath), 'utf8');
      } catch {
        return '';
      }
    }

    try {
      return await this.git.showFile(request.repoRoot, request.ref, request.filePath);
    } catch {
      return '';
    }
  }
}

export function registerDiffProvider(context: vscode.ExtensionContext, git: GitService): DiffController {
  const controller = new DiffController(git);
  controller.register(context);
  return controller;
}

export async function openWorkingFile(change: GitChange): Promise<void> {
  const uri = vscode.Uri.file(path.join(change.repoRoot, change.path));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
}

export function shouldRevealFirstChange(change: GitChange, enabled: boolean): boolean {
  return enabled && change.area !== 'untracked' && change.kind !== 'deleted';
}

function leftUri(change: GitChange): vscode.Uri {
  if (change.area === 'untracked') {
    return virtualUri(change.repoRoot, change.path, 'EMPTY');
  }

  return virtualUri(change.repoRoot, change.originalPath ?? change.path, 'HEAD');
}

function rightUri(change: GitChange): vscode.Uri {
  if (change.kind === 'deleted') {
    return virtualUri(change.repoRoot, change.path, 'EMPTY');
  }

  if (change.area === 'index') {
    return virtualUri(change.repoRoot, change.path, 'INDEX');
  }

  return vscode.Uri.file(path.join(change.repoRoot, change.path));
}

function diffTitle(change: GitChange): string {
  const base = change.originalPath ? `${change.originalPath} -> ${change.path}` : change.path;
  return `${base} (${change.statusText.toLowerCase()})`;
}

function virtualUri(repoRoot: string, filePath: string, ref: VirtualGitDocument['ref']): vscode.Uri {
  const request: VirtualGitDocument = { repoRoot, filePath, ref };
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `/${ref.toLowerCase()}/${filePath}`,
    query: encodeURIComponent(JSON.stringify(request))
  });
}

function parseVirtualUri(uri: vscode.Uri): VirtualGitDocument {
  return JSON.parse(decodeURIComponent(uri.query)) as VirtualGitDocument;
}

function fileKey(repoRoot: string, filePath: string): string {
  return path.resolve(repoRoot, filePath);
}

function isGoUri(uri: vscode.Uri): boolean {
  if (uri.scheme === 'file') {
    return uri.fsPath.endsWith('.go');
  }

  if (uri.scheme === SCHEME) {
    try {
      return parseVirtualUri(uri).filePath.endsWith('.go');
    } catch {
      return false;
    }
  }

  return false;
}

function runGofmtCheck(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = cp.execFile('gofmt', [], { encoding: 'utf8' }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }

      resolve();
    });

    child.stdin?.end(text);
  });
}
