# Changelog

## 0.2.0

- Added separate Shelf and Stash views.
- Added shelve, save to shelf, unshelve, restore shelf, delete shelf, and shelf diff commands.
- Added native Git stash create, apply, pop, drop, and diff commands.
- Split cached repository discovery from targeted repo status refreshes for faster multi-repo workspaces.
- Added first-change diff navigation after opening local changes.
- Changed discard confirmation to default off while keeping the setting available.
- Added multi-file stage, unstage, discard, and shelve support from selected group and repository nodes.
- Added debug timing output for refreshes and Git commands.

## 0.1.1

- Fixed inline revert/discard targeting when the tree has a stale multi-selection.
- Reworked discard operations to preserve staged changes when reverting only unstaged changes.
- Improved staged, untracked, renamed, and conflict revert behavior.

## 0.1.0

- Initial GoLand-inspired local changes view.
- Added grouped local Git changes, native diff opening, staging, unstaging, discard, and workspace-backed changelists.
