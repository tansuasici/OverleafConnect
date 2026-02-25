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
- **Self-hosted Overleaf** support

## Development

```bash
git clone https://github.com/tansuasici/OverleafConnect.git
cd OverleafConnect
npm install
npm run watch
```

Press `F5` in VS Code to launch the extension in debug mode.

### Scripts

| Command | Description |
|---------|-------------|
| `npm run compile` | Compile TypeScript |
| `npm run watch` | Watch mode |
| `npm run package` | Production build (webpack) |
| `npm run lint` | ESLint |
| `npm run test` | Run tests |

### Project Structure

```
src/
  extension.ts        # Entry point, activation, command registration
  auth/               # Overleaf authentication & credential storage
  sync/               # Git sync engine, file watcher, conflict handling
  latex/              # LaTeX/BibTeX compiler, log parser
  viewer/             # PDF preview panel, SyncTeX
  ui/                 # Status bar, output channel
  utils/              # Config, logger
```

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes and run `npm run lint && npm run test`
4. Commit and push
5. Open a pull request

Bug reports and feature requests are welcome via [Issues](https://github.com/tansuasici/OverleafConnect/issues).

## License

MIT
