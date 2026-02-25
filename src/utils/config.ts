import * as vscode from 'vscode';
import { ExtensionConfig } from '../types';

export function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration('overleafconnect');
  return {
    sync: {
      enabled: cfg.get<boolean>('sync.enabled', true),
      intervalSeconds: cfg.get<number>('sync.intervalSeconds', 10),
      commitMessage: cfg.get<string>('sync.commitMessage', 'Overleaf Connect auto-sync'),
      pullOnOpen: cfg.get<boolean>('sync.pullOnOpen', true),
      pushOnSave: cfg.get<boolean>('sync.pushOnSave', false),
      excludePatterns: cfg.get<string[]>('sync.excludePatterns', [
        '*.aux', '*.log', '*.synctex.gz', '*.fls',
        '*.fdb_latexmk', '*.bbl', '*.blg', '*.out', '*.toc',
      ]),
    },
    latex: {
      compiler: cfg.get<'latexmk' | 'pdflatex' | 'xelatex' | 'lualatex'>('latex.compiler', 'latexmk'),
      args: cfg.get<string[]>('latex.args', ['-pdf', '-interaction=nonstopmode', '-synctex=1']),
      outputDir: cfg.get<string>('latex.outputDir', '.'),
      compileOnSave: cfg.get<boolean>('latex.compileOnSave', true),
      mainFile: cfg.get<string>('latex.mainFile', ''),
      bibCompiler: cfg.get<'bibtex' | 'biber'>('latex.bibCompiler', 'bibtex'),
    },
    viewer: {
      autoOpen: cfg.get<boolean>('viewer.autoOpen', true),
      zoomLevel: cfg.get<number>('viewer.zoomLevel', 1.0),
    },
    overleaf: {
      serverUrl: cfg.get<string>('overleaf.serverUrl', 'https://git.overleaf.com'),
    },
  };
}
