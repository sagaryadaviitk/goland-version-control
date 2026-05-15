# Changelog

## 0.2.4

- Prevented cross-repository multi-selection actions; batch actions now require selected files from one repository.
- Hid Local Changes row action buttons while multiple files are selected so batch actions move to the Selected Changes panel.
- Changed file-row status markers to appear only on selected files, with stable blank spacing on unselected rows.
- Avoided repainting the Local Changes tree when refresh results are unchanged, keeping inline buttons stable while background refresh runs.
- Moved local file status badges out of the right-side decoration lane so inline actions no longer push or hide the `M`/status marker.
- Time-boxed built-in Git extension repository discovery during reload so workspace-folder changes can appear sooner.
- Made Git status refresh more resilient and less noisy by skipping failed repos and running status with optional locks disabled.

## 0.2.3

- Stopped running Go diff syntax diagnostics on every file save; saved files now only refresh open diff virtual documents and schedule Git status refresh.
- Made Local Changes inline actions use a stable button set and order so actions do not shift during refreshes.

## 0.2.2

- Fixed Shelf file rows so Unshelve, Restore Shelf, and Open Shelf Diff are available directly from selected files.
- Fixed Stash file rows so Apply Stash, Pop Stash, and Open Stash Diff are available directly from selected files.

## 0.2.1

- Removed the redundant inline Open Diff button from local change rows.
- Added visible inline Shelve Selected and Stash Selected actions for file, group, and repository rows.
- Added selected-path Git stash creation so individual files can be moved to a native Git stash.
- Added a Selected Changes panel that appears for multi-selection with Stage, Unstage, Shelve, Stash, and Discard actions.

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
