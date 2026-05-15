import { RepositoryRef } from './model';

export interface DisposableLike {
  dispose(): void;
}

export interface GitWatchRoot {
  gitDir: string;
  commonDir: string;
}

export interface RefreshCoordinatorOptions<TState> {
  debounceMs?: number;
  isAutoRefreshEnabled: () => boolean;
  refresh: () => Promise<TState>;
  getWatchRoots: (state: TState) => Promise<GitWatchRoot[]>;
  createWatcher: (basePath: string, pattern: string, onEvent: () => void) => DisposableLike;
  onError?: (error: unknown) => void;
}

export interface RepositoryState {
  repositories: RepositoryRef[];
}

export const GIT_WATCH_PATTERNS = [
  'index',
  'HEAD',
  'packed-refs',
  'refs/**',
  'MERGE_HEAD',
  'MERGE_MSG',
  'REBASE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
  'rebase-merge/**',
  'rebase-apply/**'
] as const;

export class RefreshCoordinator<TState> implements DisposableLike {
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refreshInFlight: Promise<void> | undefined;
  private refreshAgain = false;
  private disposed = false;
  private watchSignature = '';
  private watchers: DisposableLike[] = [];

  constructor(private readonly options: RefreshCoordinatorOptions<TState>) {
    this.debounceMs = options.debounceMs ?? 350;
  }

  scheduleAutoRefresh(): void {
    if (this.disposed || !this.options.isAutoRefreshEnabled()) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refreshNow();
    }, this.debounceMs);
  }

  async refreshNow(): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (this.refreshInFlight) {
      this.refreshAgain = true;
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.refreshLoop();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.replaceWatchers([]);
  }

  async rebuildWatchersForState(state: TState): Promise<void> {
    if (!this.disposed) {
      await this.rebuildWatchers(state);
    }
  }

  private async refreshLoop(): Promise<void> {
    while (!this.disposed) {
      this.refreshAgain = false;

      try {
        const state = await this.options.refresh();
        await this.rebuildWatchers(state);
      } catch (error) {
        this.options.onError?.(error);
      }

      if (!this.refreshAgain) {
        break;
      }
    }
  }

  private async rebuildWatchers(state: TState): Promise<void> {
    if (!this.options.isAutoRefreshEnabled()) {
      this.watchSignature = '';
      this.replaceWatchers([]);
      return;
    }

    const roots = await this.options.getWatchRoots(state);
    const bases = gitWatchBases(roots);
    const signature = bases.join('\0');
    if (signature === this.watchSignature) {
      return;
    }

    this.watchSignature = signature;
    this.replaceWatchers([]);
    this.watchers = bases.flatMap((base) =>
      GIT_WATCH_PATTERNS.map((pattern) =>
        this.options.createWatcher(base, pattern, () => this.scheduleAutoRefresh())
      )
    );
  }

  private replaceWatchers(nextWatchers: DisposableLike[]): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = nextWatchers;
  }
}

export function gitWatchBases(roots: GitWatchRoot[]): string[] {
  const bases = new Set<string>();
  for (const root of roots) {
    bases.add(root.gitDir);
    bases.add(root.commonDir);
  }
  return [...bases].sort((left, right) => left.localeCompare(right));
}
