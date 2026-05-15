import * as path from 'path';
import * as fs from 'fs/promises';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import { GitService } from './gitService';
import { GitChange } from './model';
import { parseGofmtDiagnostics } from './goSyntaxDiagnostics';

interface VirtualGitDocument {
  repoRoot: string;
  filePath: string;
  ref: 'HEAD' | 'INDEX' | 'WORKTREE' | 'EMPTY';
}

const SCHEME = 'goland-version-control';
let diffDiagnostics: vscode.DiagnosticCollection | undefined;

export class GitDiffContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly git: GitService) {}

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

export function registerDiffProvider(context: vscode.ExtensionContext, git: GitService): void {
  diffDiagnostics = vscode.languages.createDiagnosticCollection('goland-version-control');
  context.subscriptions.push(
    diffDiagnostics,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitDiffContentProvider(git))
  );
}

export async function openDiff(change: GitChange): Promise<void> {
  const left = leftUri(change);
  const right = rightUri(change);
  const title = diffTitle(change);
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: false });
  await updateDiffDiagnostics(left, right);
}

export async function openWorkingFile(change: GitChange): Promise<void> {
  const uri = vscode.Uri.file(path.join(change.repoRoot, change.path));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
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

function virtualUri(repoRoot: string, filePath: string, ref: 'HEAD' | 'INDEX' | 'WORKTREE' | 'EMPTY'): vscode.Uri {
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

async function updateDiffDiagnostics(...uris: vscode.Uri[]): Promise<void> {
  if (!diffDiagnostics) {
    return;
  }

  await Promise.all(uris.map((uri) => updateGoSyntaxDiagnostics(uri)));
}

async function updateGoSyntaxDiagnostics(uri: vscode.Uri): Promise<void> {
  if (!diffDiagnostics) {
    return;
  }

  if (!isGoUri(uri)) {
    diffDiagnostics.delete(uri);
    return;
  }

  const document = await vscode.workspace.openTextDocument(uri);
  const text = document.getText();
  if (!text.trim()) {
    diffDiagnostics.delete(uri);
    return;
  }

  try {
    await runGofmtCheck(text);
    diffDiagnostics.delete(uri);
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

    diffDiagnostics.set(uri, diagnostics);
  }
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
