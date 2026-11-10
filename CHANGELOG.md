# Changelog

## [0.2.1] - 2026-11-10

### Changed
- On overleaf.com, Set Overleaf Session Cookie takes the bare value of the `overleaf_session2` cookie; `name=value` still works, and a self-hosted server still asks for `name=value`

## [0.2.0] - 2026-11-10

### Added
- An Overleaf panel in the Activity Bar: each connected folder with its sync state, last sync, files waiting to go to Overleaf, conflicts and the newest Overleaf commits, with per-folder Sync, Pause and Resume
- Explorer badges: ↑ for files Overleaf does not have yet, ⚠ for conflicts
- Conflicts are resolved from the panel: Compare with Overleaf, Take Overleaf's Version, Keep My Version, Edit Conflict by Hand, Mark as Resolved and Abort Merge. After the last file the merge is committed and pushed
- After a sync brings changes from Overleaf, a notification names the files and their authors, and Show Changes opens the diff. The `overleafconnect.notifications.remoteChanges` setting picks a notification, a status bar message or nothing
- Open in Overleaf, for a folder row or from the Command Palette
- Upload Folder to Overleaf Project: turns a local folder into a clone of an existing project, keeping your files on top of Overleaf's version
- With an Overleaf session cookie saved (Set Overleaf Session Cookie): Clone Overleaf Project lists your projects (shared ones are marked), Show Overleaf Comments shows open comment threads on the lines they quote, and Compile on Overleaf syncs, compiles there and opens the PDF. The cookie is kept in SecretStorage and is sent only to Overleaf

### Changed
- Each workspace folder has its own Overleaf project, read from its `.overleafconnect` file or its git remote. Cloning a second project no longer re-points the open one. The project URL saved by 0.1.x is moved to the folder it belongs to
- Saving a file syncs only its own folder, and the status bar follows the active editor's folder
- Pasting a project page URL (`overleaf.com/project/…`) works where a Git URL is asked for
- The Git token is no longer written into `.git/config`. Git gets it only while a command runs. Clones made by 0.1.x are cleaned the first time they sync
- Overtex is now a required dependency and is installed with this extension. It handles compile, PDF preview, SyncTeX and clean; Overleaf Connect handles only Git sync

### Fixed
- A merge stopped on conflicts no longer leaves sync stuck: a merge left by a reload is picked up again, and local commits Overleaf lacks are pushed on the next sync

### Removed
- The built-in LaTeX compiler, BibTeX/Biber step, log parser, PDF viewer and SyncTeX
- LaTeX Workshop mode
- The Compile, View PDF, SyncTeX Forward and Clean commands and their keybindings (Overtex has its own)
- The `overleafconnect.latex.*` and `overleafconnect.viewer.*` settings

## [0.1.8] - 2026-11-09

### Changed
- When Overtex is installed, it handles compile, PDF preview, SyncTeX and clean, and Overleaf Connect handles only Git sync. If LaTeX Workshop is also installed, Overtex is the one used
- Sync waits while an Overtex build runs, then syncs. A pause you set yourself stays in place
- With Overtex, its output (`*-arxiv.zip`, `overtex-diff-*/`, `*.bcf`, `*.run.xml`, `*.xdv`) is added to `.gitignore` so it is not pushed to Overleaf

## [0.1.0] - 2026-02-25

### Added
- Overleaf Git sync with configurable interval (default 10 seconds)
- Clone Overleaf projects directly from VS Code
- Automatic two-way synchronization (pull/push)
- Merge conflict detection and guided resolution
- Sync on save for .tex and .bib files
- Secure credential storage via VS Code SecretStorage
- LaTeX compilation (latexmk, pdflatex, xelatex, lualatex)
- BibTeX/Biber bibliography compilation
- Log file parsing with VS Code Diagnostics integration
- Built-in PDF preview with PDF.js
- SyncTeX forward/inverse search
- LaTeX Workshop compatibility mode
- Status bar sync indicator
- Keyboard shortcuts for common actions
- Self-hosted Overleaf support
