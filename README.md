# GoLand Version Control

GoLand Version Control is a VS Code extension that adds a GoLand-inspired local changes workflow for Git repositories.

## Features

- Dedicated Activity Bar view with no built-in Git commit box clutter
- Repository and changelist grouping with flat relative file paths
- Colored Git status badges for unstaged, staged, untracked, deleted, renamed, and conflicted files
- Auto-refresh when files are saved or Git metadata changes
- Staged, unstaged, unversioned, renamed, deleted, and conflicted file states
- Native VS Code side-by-side diff editor integration
- Stage, unstage, inline revert, open file, open diff, refresh, and change navigation commands
- Workspace-backed custom changelists for organizing local work without changing Git metadata

## Usage

1. Open a folder or workspace containing one or more Git repositories.
2. Open `GoLand Version Control` from the Activity Bar.
3. Expand `Local Changes`.
4. Select changed files to open diffs, or use inline/context actions to stage, unstage, discard, or move files to changelists.

## Settings

- `golandVersionControl.showUntracked` defaults to `false` to keep large workspaces clean
- `golandVersionControl.groupBy`
- `golandVersionControl.autoRefresh`
- `golandVersionControl.confirmDiscard`
- `golandVersionControl.compareBase`

## Development

```bash
npm install
npm run compile
npm test
npm run test:integration
npx @vscode/vsce package
```

## Notes

- This extension is GoLand-inspired and is not affiliated with JetBrains.
- VS Code's native diff editor is used intentionally for stable editing and staging behavior.
- VS Code Web is not targeted because the extension uses the local Git binary.
