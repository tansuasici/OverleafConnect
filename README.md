<p align="center">
  <img src="resources/icon.png" alt="Overleaf Connect Logo" width="150">
</p>

<h1 align="center">Overleaf Connect</h1>

<p align="center">
  <em>Use Overleaf without leaving VS Code.</em>
</p>

<p align="center">
  <strong>Sync Overleaf projects via Git and compile LaTeX locally with full VS Code integration.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=tansuasici.overleaf-connect"><img src="https://img.shields.io/visual-studio-marketplace/v/tansuasici.overleaf-connect?label=VS%20Code%20Marketplace" alt="VS Code Marketplace"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=tansuasici.overleaf-connect"><img src="https://img.shields.io/visual-studio-marketplace/i/tansuasici.overleaf-connect" alt="Installs"></a>
  <a href="https://github.com/tansuasici/OverleafConnect/blob/main/LICENSE"><img src="https://img.shields.io/github/license/tansuasici/OverleafConnect" alt="License"></a>
</p>

## Features

- **Automatic two-way sync** with Overleaf via Git
- **Clone Overleaf projects** directly from VS Code
- **Conflict detection** with guided resolution
- **LaTeX compilation** (latexmk, pdflatex, xelatex, lualatex) with BibTeX/Biber
- **Built-in PDF viewer** with SyncTeX forward/inverse search
- **LaTeX Workshop compatible** - handles only Git sync when LaTeX Workshop is installed
- **Smart .gitignore** - auto-generates `.gitignore` for build artifacts (`.aux`, `.log`, `.pdf`, etc.) and detects already-tracked files
- **Self-hosted Overleaf** support

## Setup

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=tansuasici.overleaf-connect)
2. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Run **Overleaf Connect: Clone Overleaf Project**
4. Enter your Overleaf project URL or ID
5. Enter your [Git token](https://www.overleaf.com/user/settings) (Account Settings > Git Integration)
6. Choose a local folder

Auto-sync starts immediately.

## Self-Hosted Overleaf

```json
{
  "overleafconnect.overleaf.serverUrl": "https://git.your-overleaf-instance.com"
}
```

## License

MIT
