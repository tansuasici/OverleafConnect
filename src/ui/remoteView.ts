import * as vscode from 'vscode';
import * as path from 'path';
import { SyncGroup } from '../sync/syncGroup';
import { SyncManager } from '../sync/syncManager';
import { decodeRevQuery, encodeRevQuery, mergeUpdates, RemoteUpdate, REV_SCHEME, revDiffTitle, summarizeRemoteUpdate } from '../sync/remoteModel';

export type RemoteNotificationMode = 'notification' | 'statusBar' | 'off';

/** Serves a file at one commit as a read-only document; empty when it did not exist there. */
export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly syncs: SyncGroup<SyncManager>) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = decodeRevQuery(uri.query);
    const sync = q && this.syncs.get(q.folderPath);
    if (!q || !sync) {
      return '';
    }
    return (await sync.revisionContent(q.ref, uri.path.replace(/^\//, ''))) ?? '';
  }
}

function revUri(folderPath: string, relativePath: string, ref: string): vscode.Uri {
  return vscode.Uri.from({ scheme: REV_SCHEME, path: `/${relativePath}`, query: encodeRevQuery(folderPath, ref) });
}

/** Tells the user what a sync brought from Overleaf, as the setting asks. */
export async function announceRemoteUpdate(
  sync: SyncManager,
  folderPath: string,
  update: RemoteUpdate,
  mode: RemoteNotificationMode
): Promise<void> {
  const summary = summarizeRemoteUpdate(update);
  if (!summary || mode === 'off') {
    return;
  }
  const where = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1 ? `${path.basename(folderPath)}: ` : '';
  if (mode === 'statusBar') {
    vscode.window.setStatusBarMessage(`$(cloud-download) ${where}${summary}`, 8000);
    return;
  }
  // While a toast is open, later pulls join it instead of stacking a new toast per poll.
  const open = openToasts.get(folderPath);
  if (open) {
    openToasts.set(folderPath, mergeUpdates(open, update));
    return;
  }
  openToasts.set(folderPath, update);
  let choice: string | undefined;
  try {
    choice = await vscode.window.showInformationMessage(`Overleaf Connect: ${where}${summary}`, 'Show Changes');
  } finally {
    const latest = openToasts.get(folderPath) ?? update;
    openToasts.delete(folderPath);
    if (choice === 'Show Changes') {
      await showRemoteUpdate(sync, folderPath, latest);
    }
  }
}

const openToasts = new Map<string, RemoteUpdate>();

/** Opens the diff of one changed file, or lets the user pick one when several changed. */
export async function showRemoteUpdate(sync: SyncManager, folderPath: string, update: RemoteUpdate): Promise<void> {
  let file: string | undefined = update.files[0];
  if (update.files.length > 1) {
    const picked = await vscode.window.showQuickPick(
      update.files.map((f) => ({ label: path.basename(f), description: path.dirname(f) === '.' ? '' : path.dirname(f), file: f })),
      { placeHolder: 'File to compare with its version before the change' }
    );
    file = picked?.file;
  }
  if (!file) {
    return;
  }
  const [before, after] = await Promise.all([
    sync.revisionContent(update.base, file),
    sync.revisionContent(update.head, file),
  ]);
  await vscode.commands.executeCommand(
    'vscode.diff',
    revUri(folderPath, file, update.base),
    revUri(folderPath, file, update.head),
    revDiffTitle(file, before !== undefined, after !== undefined),
    { preview: true }
  );
}
