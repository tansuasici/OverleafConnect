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
    overleaf: {
      serverUrl: cfg.get<string>('overleaf.serverUrl', 'https://git.overleaf.com'),
    },
    notifications: {
      remoteChanges: cfg.get<'notification' | 'statusBar' | 'off'>('notifications.remoteChanges', 'notification'),
    },
  };
}
