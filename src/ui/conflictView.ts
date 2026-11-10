import * as vscode from 'vscode';
import { SyncGroup } from '../sync/syncGroup';
import { SyncManager } from '../sync/syncManager';
import { CONFLICT_SCHEME, ConflictSide, conflictTitle, decodeConflictQuery, encodeConflictQuery } from '../sync/conflictModel';

/** Serves each side of a conflicted file from the git index as a read-only document. */
export class ConflictContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly syncs: SyncGroup<SyncManager>) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = decodeConflictQuery(uri.query);
    const sync = q && this.syncs.get(q.folderPath);
    if (!q || !sync) {
      return '';
    }
    return (await sync.conflictVersion(uri.path.replace(/^\//, ''), q.side)) ?? '';
  }
}

export function conflictUri(folderPath: string, relativePath: string, side: ConflictSide): vscode.Uri {
  return vscode.Uri.from({ scheme: CONFLICT_SCHEME, path: `/${relativePath}`, query: encodeConflictQuery(folderPath, side) });
}

/** Opens Overleaf's version against yours side by side. */
export async function showConflictDiff(sync: SyncManager, folderPath: string, relativePath: string): Promise<void> {
  const [theirs, ours] = await Promise.all([
    sync.conflictVersion(relativePath, 'theirs'),
    sync.conflictVersion(relativePath, 'ours'),
  ]);
  await vscode.commands.executeCommand(
    'vscode.diff',
    conflictUri(folderPath, relativePath, 'theirs'),
    conflictUri(folderPath, relativePath, 'ours'),
    conflictTitle(relativePath, theirs !== undefined, ours !== undefined),
    { preview: true }
  );
}
