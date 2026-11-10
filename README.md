<p align="center">
  <img src="resources/icon.png" alt="Overleaf Connect Logo" width="150">
</p>

<h1 align="center">Overleaf Connect</h1>

<p align="center">
  <em>Use Overleaf without leaving VS Code.</em>
</p>

<p align="center">
  <strong>Sync Overleaf projects via Git. <a href="https://marketplace.visualstudio.com/items?itemName=tansuasici.overtex">Overtex</a> builds and previews them.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=tansuasici.overleaf-connect"><img src="https://img.shields.io/visual-studio-marketplace/v/tansuasici.overleaf-connect?label=VS%20Code%20Marketplace" alt="VS Code Marketplace"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=tansuasici.overleaf-connect"><img src="https://img.shields.io/visual-studio-marketplace/i/tansuasici.overleaf-connect" alt="Installs"></a>
  <a href="https://github.com/tansuasici/OverleafConnect/blob/main/LICENSE"><img src="https://img.shields.io/github/license/tansuasici/OverleafConnect" alt="License"></a>
</p>

## Features

- **Automatic two-way sync** with Overleaf via Git, one Overleaf project per workspace folder
- **Overleaf panel** - sync state, files waiting to go to Overleaf and recent Overleaf commits for each folder; ↑ and ⚠ badges in the explorer
- **Clone or upload** - clone an Overleaf project, or send an existing local folder to one
- **Conflict resolution** - compare with Overleaf's version and take theirs, keep yours or edit by hand, from the panel
- **See what changed** - a notification names the files and authors a sync brought, with a diff one click away
- **Overleaf web features** (optional, with your session cookie) - pick a project from a list, read comments on their lines, compile on Overleaf
- **Works with [Overtex](https://marketplace.visualstudio.com/items?itemName=tansuasici.overtex)** - Overtex builds, previews and handles SyncTeX; it is installed with this extension. Sync waits for each build to finish
- **Smart .gitignore** - auto-excludes build artifacts from sync
- **Self-hosted Overleaf** support

## Setup

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=tansuasici.overleaf-connect)
2. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Run **Overleaf Connect: Clone Overleaf Project**
4. Enter your Overleaf project URL or ID
5. Enter your [Git token](https://www.overleaf.com/user/settings) (Account Settings > Git Integration)
6. Choose a local folder

Auto-sync starts immediately. Your Git token is kept in VS Code's secret storage and is never written into the repository.

## Overleaf Web Features (optional)

Run **Overleaf Connect: Set Overleaf Session Cookie** and paste the `overleaf_session2` cookie from your browser. Then:

- **Clone Overleaf Project** lists your projects instead of asking for a URL
- **Show Overleaf Comments** shows open comment threads on the lines they refer to (read-only)
- **Compile on Overleaf** syncs, compiles on Overleaf and opens the PDF

These use Overleaf's website, not a public API, so they may break when Overleaf changes. The cookie is stored in VS Code's secret storage and sent only to Overleaf.

## Self-Hosted Overleaf

```json
{
  "overleafconnect.overleaf.serverUrl": "https://git.your-overleaf-instance.com"
}
```

## License

MIT
