import * as vscode from 'vscode';
import { assignmentKey, GitChange } from './model';

interface StoredChangelists {
  lists: Record<string, string[]>;
  assignments: Record<string, string>;
}

const STORAGE_KEY = 'golandVersionControl.changelists';
const DEFAULT_LIST = 'Changes';

export class ChangelistStore {
  constructor(private readonly state: vscode.Memento) {}

  getChangelist(change: GitChange): string {
    if (change.category !== 'Changes') {
      return change.category;
    }

    return this.read().assignments[assignmentKey(change)] ?? DEFAULT_LIST;
  }

  getChangelists(repoRoot: string): string[] {
    const stored = this.read().lists[repoRoot] ?? [];
    return [DEFAULT_LIST, ...stored.filter((name) => name !== DEFAULT_LIST)].sort((left, right) => {
      if (left === DEFAULT_LIST) {
        return -1;
      }
      if (right === DEFAULT_LIST) {
        return 1;
      }
      return left.localeCompare(right);
    });
  }

  async create(repoRoot: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    const stored = this.read();
    const existing = new Set(stored.lists[repoRoot] ?? []);
    existing.add(trimmed);
    stored.lists[repoRoot] = [...existing].sort((left, right) => left.localeCompare(right));
    await this.write(stored);
  }

  async move(change: GitChange, changelistName: string): Promise<void> {
    const trimmed = changelistName.trim();
    if (!trimmed) {
      return;
    }

    const stored = this.read();
    const lists = new Set(stored.lists[change.repoRoot] ?? []);
    lists.add(trimmed);
    stored.lists[change.repoRoot] = [...lists].sort((left, right) => left.localeCompare(right));

    const key = assignmentKey(change);
    if (trimmed === DEFAULT_LIST) {
      delete stored.assignments[key];
    } else {
      stored.assignments[key] = trimmed;
    }

    await this.write(stored);
  }

  private read(): StoredChangelists {
    return this.state.get<StoredChangelists>(STORAGE_KEY, { lists: {}, assignments: {} });
  }

  private async write(value: StoredChangelists): Promise<void> {
    await this.state.update(STORAGE_KEY, value);
  }
}
