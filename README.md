<p align="center">
  <img src="resources/icon.png" alt="Overleaf Connect Logo" width="150">
</p>

<h1 align="center">Overleaf Connect</h1>

<p align="center">
  <strong>Sync Overleaf projects via Git and compile LaTeX locally with full VS Code integration.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=tansuasici.overleaf-connect"><img src="https://img.shields.io/visual-studio-marketplace/v/tansuasici.overleaf-connect?label=VS%20Code%20Marketplace" alt="VS Code Marketplace"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=tansuasici.overleaf-connect"><img src="https://img.shields.io/visual-studio-marketplace/i/tansuasici.overleaf-connect" alt="Installs"></a>
  <a href="https://github.com/tansuasici/OverleafConnect/blob/main/LICENSE"><img src="https://img.shields.io/github/license/tansuasici/OverleafConnect" alt="License"></a>
</p>

Overleaf Connect bridges Overleaf and VS Code, letting you edit LaTeX projects locally while keeping everything synchronized with your Overleaf collaborators. Use the full power of VS Code extensions, AI assistants, and local tools while your team continues working on Overleaf.

## Features

### Overleaf Git Sync
- **Automatic two-way sync** with Overleaf via Git (configurable interval, default 10s)
- **Clone Overleaf projects** directly from VS Code
- **Conflict detection** with guided resolution
- **Sync on save** for near-real-time collaboration
- Secure credential storage using VS Code's built-in SecretStorage API

### LaTeX Compilation
- **Multiple compilers**: latexmk, pdflatex, xelatex, lualatex
- **BibTeX/Biber** support for bibliography compilation
- **Error diagnostics** in VS Code's Problems panel (parsed from .log files)
- **Compile on save** (auto or manual)

### PDF Preview
- **Built-in PDF viewer** powered by PDF.js
- **SyncTeX** forward/inverse search (click in editor to jump to PDF and vice versa)
- **Auto-refresh** after compilation

### LaTeX Workshop Compatible
- When LaTeX Workshop is installed, Overleaf Connect handles only Git sync
- When LaTeX Workshop is not installed, Overleaf Connect provides full LaTeX compilation and PDF preview

## Getting Started

### Prerequisites
- An [Overleaf](https://www.overleaf.com) account (free or premium)
- Git installed on your system
- A Git authentication token from Overleaf (Account Settings > Git Integration)

### Setup

1. Install Overleaf Connect from the VS Code Marketplace
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Run **Overleaf Connect: Clone Overleaf Project**
4. Enter your Overleaf project ID or URL
5. Enter your Git authentication token (from Overleaf Account Settings)
6. Choose a local folder - done!

Your project will be cloned and auto-sync will start immediately.

### Finding Your Project ID

You can enter any of these formats:
- **Project ID**: `682abc123def` (from the URL bar on Overleaf)
- **Overleaf URL**: `https://www.overleaf.com/project/682abc123def`
- **Git URL**: `https://git.overleaf.com/682abc123def`

### Getting Your Git Token

1. Go to [Overleaf Account Settings](https://www.overleaf.com/user/settings)
2. Scroll to **Git Integration**
3. Generate a personal access token

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| Overleaf Connect: Clone Overleaf Project | - | Clone a project from Overleaf |
| Overleaf Connect: Configure Overleaf Connection | - | Set up credentials for current workspace |
| Overleaf Connect: Sync Now | `Ctrl+Alt+S` | Trigger immediate sync |
| Overleaf Connect: Pause Auto-Sync | - | Pause automatic synchronization |
| Overleaf Connect: Resume Auto-Sync | - | Resume automatic synchronization |
| Overleaf Connect: Compile LaTeX | `Ctrl+Alt+B` | Compile the LaTeX project |
| Overleaf Connect: View PDF | `Ctrl+Alt+V` | Open PDF preview |
| Overleaf Connect: SyncTeX Forward Search | `Ctrl+Alt+J` | Jump from editor to PDF |
| Overleaf Connect: Clean Auxiliary Files | - | Remove .aux, .log, etc. |
| Overleaf Connect: Clear Overleaf Credentials | - | Remove stored credentials |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `overleafconnect.sync.enabled` | `true` | Enable automatic sync |
| `overleafconnect.sync.intervalSeconds` | `10` | Sync interval in seconds (5-600) |
| `overleafconnect.sync.commitMessage` | `Overleaf Connect auto-sync` | Commit message for auto-sync |
| `overleafconnect.sync.pullOnOpen` | `true` | Pull latest on workspace open |
| `overleafconnect.sync.pushOnSave` | `false` | Push immediately on save |
| `overleafconnect.latex.compiler` | `latexmk` | LaTeX compiler |
| `overleafconnect.latex.compileOnSave` | `true` | Compile on save |
| `overleafconnect.latex.mainFile` | (auto-detect) | Main .tex file path |
| `overleafconnect.overleaf.serverUrl` | `https://git.overleaf.com` | Git server URL (for self-hosted) |

## How It Works

Overleaf Connect uses Overleaf's official Git integration to synchronize your project:

```
Overleaf Web  <-->  Overleaf Git Server  <-->  Overleaf Connect  <-->  Local Files
                         (fetch/push every 10s)
```

1. Every 10 seconds, Overleaf Connect checks for changes on both sides
2. Remote-only changes are pulled automatically
3. Local-only changes are committed and pushed
4. When both sides have changes, Overleaf Connect rebases local changes on top of remote
5. Merge conflicts are detected and presented for manual resolution

## Self-Hosted Overleaf

If you're using a self-hosted Overleaf instance, change the server URL:

```json
{
  "overleafconnect.overleaf.serverUrl": "https://git.your-overleaf-instance.com"
}
```

## Troubleshooting

### "Authentication failed"
- Verify your Git token in Overleaf Account Settings > Git Integration
- Make sure the token hasn't expired
- Run **Overleaf Connect: Clear Overleaf Credentials** and reconfigure

### Changes not syncing
- Check the status bar icon for sync status
- Run **Overleaf Connect: Sync Now** to force a sync
- Check the Output panel (Overleaf Connect) for error messages

### Merge conflicts
- Overleaf Connect will pause sync and open conflicted files
- Resolve conflicts manually, then save
- Run **Overleaf Connect: Sync Now** to resume

## License

MIT
