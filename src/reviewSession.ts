import { GitChange, WorkspaceState, changeKey } from './model';

export class ReviewSession {
  private changes: GitChange[] = [];
  private currentIndex = -1;

  update(state: WorkspaceState): void {
    const current = this.currentChange();
    this.changes = state.changes.filter((change) => change.area !== 'conflict');
    if (!current) {
      this.currentIndex = this.changes.length > 0 ? 0 : -1;
      return;
    }

    const index = this.changes.findIndex((change) => changeKey(change) === changeKey(current));
    this.currentIndex = index >= 0 ? index : (this.changes.length > 0 ? 0 : -1);
  }

  currentChange(): GitChange | undefined {
    if (this.currentIndex < 0) {
      return undefined;
    }
    return this.changes[this.currentIndex];
  }

  next(): GitChange | undefined {
    if (this.changes.length === 0) {
      return undefined;
    }

    this.currentIndex = (this.currentIndex + 1 + this.changes.length) % this.changes.length;
    return this.currentChange();
  }

  previous(): GitChange | undefined {
    if (this.changes.length === 0) {
      return undefined;
    }

    this.currentIndex = (this.currentIndex - 1 + this.changes.length) % this.changes.length;
    return this.currentChange();
  }

  setCurrent(change: GitChange): void {
    const index = this.changes.findIndex((candidate) => changeKey(candidate) === changeKey(change));
    if (index >= 0) {
      this.currentIndex = index;
    }
  }
}
