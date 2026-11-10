import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SyncGroup } from '../sync/syncGroup';
import { SyncManager } from '../sync/syncManager';
import { SyncState } from '../types';
import { badgeFor, changedBadgePaths, commitTitle, folderDescription, stateView, SyncSnapshot, timeAgo } from './syncModel';

type Node =
  | { kind: 'folder'; folderPath: string }
  | { kind: 'error'; folderPath: string; message: string }
  | { kind: 'group'; folderPath: string; group: 'pending' | 'conflicts' | 'remote' }
  | { kind: 'file'; folderPath: string; relativePath: string; conflict: boolean }
  | { kind: 'commit'; folderPath: string; hash: string };

/** The Overleaf panel: one row per connected folder, with its pending files and the newest Overleaf commits. */
export class SyncTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly syncs: SyncGroup<SyncManager>) {}

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.syncs
        .folders()
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
        .map((folderPath) => ({ kind: 'folder', folderPath }));
    }
    const snap = this.syncs.get(node.folderPath)?.snapshot;
    if (!snap) {
      return [];
    }
    const { folderPath } = node;
    if (node.kind === 'folder') {
      const rows: Node[] = [];
      if (snap.state === SyncState.Error && snap.lastError) {
        rows.push({ kind: 'error', folderPath, message: snap.lastError });
      }
      if (snap.conflictedFiles.length) {
        rows.push({ kind: 'group', folderPath, group: 'conflicts' });
      }
      rows.push({ kind: 'group', folderPath, group: 'pending' }, { kind: 'group', folderPath, group: 'remote' });
      return rows;
    }
    if (node.kind === 'group') {
      if (node.group === 'remote') {
        return snap.recentRemoteCommits.map((c) => ({ kind: 'commit', folderPath, hash: c.hash }));
      }
      const conflict = node.group === 'conflicts';
      const files = conflict ? snap.conflictedFiles : snap.pendingFiles.filter((f) => !snap.conflictedFiles.includes(f));
      return files.map((relativePath) => ({ kind: 'file', folderPath, relativePath, conflict }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const sync = this.syncs.get(node.folderPath);
    const snap = sync?.snapshot;
    switch (node.kind) {
      case 'folder':
        return folderItem(node.folderPath, snap, sync?.paused ?? false);
      case 'error': {
        const item = new vscode.TreeItem(firstLine(node.message));
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
        item.tooltip = node.message;
        item.command = { command: 'overleafconnect.showLog', title: 'Show Sync Log' };
        return item;
      }
      case 'group':
        return groupItem(node.group, snap);
      case 'file': {
        const uri = vscode.Uri.file(path.join(node.folderPath, node.relativePath));
        const item = new vscode.TreeItem(uri);
        const dir = path.posix.dirname(node.relativePath);
        const exists = fs.existsSync(uri.fsPath);
        item.description = [dir === '.' ? '' : dir, exists ? '' : 'deleted'].filter(Boolean).join(' · ') || undefined;
        item.tooltip = node.conflict
          ? `${node.relativePath} — conflicts with Overleaf`
          : `${node.relativePath} — ${exists ? 'not on Overleaf yet' : 'deletion not on Overleaf yet'}`;
        if (node.conflict) {
          item.tooltip += '\nClick to compare. Inline: take Overleaf\'s, keep yours, edit by hand, mark resolved.';
        }
        if (node.conflict) {
          item.command = { command: 'overleafconnect.showConflict', title: 'Compare with Overleaf', arguments: [node] };
          item.contextValue = 'overleafConflict';
        } else {
          if (exists) {
            item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
          }
          item.contextValue = 'overleafFile';
        }
        return item;
      }
      case 'commit': {
        const c = snap?.recentRemoteCommits.find((x) => x.hash === node.hash);
        const item = new vscode.TreeItem(c ? commitTitle(c.message) || '(no message)' : node.hash.slice(0, 7));
        if (c) {
          item.description = `${c.author} · ${timeAgo(c.date)}`;
          const tip = new vscode.MarkdownString();
          tip.appendText(`${c.message}\n\n${c.author} — ${c.date.toLocaleString()}\n${c.hash.slice(0, 10)}`);
          item.tooltip = tip;
        }
        item.iconPath = new vscode.ThemeIcon('git-commit');
        item.command = { command: 'overleafconnect.showRemoteCommit', title: 'Show Changes', arguments: [node] };
        return item;
      }
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

function folderItem(folderPath: string, snap: SyncSnapshot | undefined, paused: boolean): vscode.TreeItem {
  const item = new vscode.TreeItem(path.basename(folderPath), vscode.TreeItemCollapsibleState.Expanded);
  if (!snap) {
    return item;
  }
  const view = stateView(snap.state);
  item.id = `folder:${folderPath}`;
  item.description = folderDescription(snap);
  item.iconPath = new vscode.ThemeIcon(view.icon);
  const tip = new vscode.MarkdownString();
  tip.appendText(`${path.basename(folderPath)} — ${view.label}\n\n`);
  if (snap.projectUrl) {
    tip.appendText(`Project: ${snap.projectUrl}\n`);
  }
  tip.appendText(`Folder: ${folderPath}\n`);
  tip.appendText(snap.lastSyncAt ? `Last sync: ${snap.lastSyncAt.toLocaleString()}` : 'Not synced yet in this session');
  item.tooltip = tip;
  item.contextValue = snap.state === SyncState.Conflict ? 'overleafFolder.conflict' : paused ? 'overleafFolder.paused' : 'overleafFolder';
  return item;
}

function groupItem(group: 'pending' | 'conflicts' | 'remote', snap: SyncSnapshot | undefined): vscode.TreeItem {
  const pending = snap ? snap.pendingFiles.filter((f) => !snap.conflictedFiles.includes(f)).length : 0;
  const count = group === 'pending' ? pending : group === 'conflicts' ? snap?.conflictedFiles.length ?? 0 : snap?.recentRemoteCommits.length ?? 0;
  const labels = { pending: 'Not on Overleaf yet', conflicts: 'Conflicts', remote: 'Recent Overleaf changes' };
  const icons = { pending: 'cloud-upload', conflicts: 'warning', remote: 'history' };
  const item = new vscode.TreeItem(
    labels[group],
    count ? (group === 'remote' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded) : vscode.TreeItemCollapsibleState.None
  );
  item.description = group === 'remote' ? (count ? undefined : 'none') : String(count);
  item.iconPath = new vscode.ThemeIcon(icons[group]);
  return item;
}

function firstLine(text: string): string {
  return text.split('\n')[0].slice(0, 120);
}

/** Explorer badges for files Overleaf does not have yet, and for conflicts. */
export class SyncDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private readonly shown = new Map<string, SyncSnapshot>();

  constructor(private readonly syncs: SyncGroup<SyncManager>) {}

  /** Updates one folder's badges, firing only for the files whose badge changed. */
  update(folderPath: string, snapshot: SyncSnapshot | undefined): void {
    const before = this.shown.get(folderPath);
    if (snapshot) {
      this.shown.set(folderPath, snapshot);
    } else {
      this.shown.delete(folderPath);
    }
    const changed = changedBadgePaths(before, snapshot).map((p) => vscode.Uri.file(path.join(folderPath, p)));
    if (changed.length) {
      this._onDidChange.fire(changed);
    }
  }

  /** Drops badges of folders that are no longer synced. */
  prune(): void {
    for (const folderPath of [...this.shown.keys()]) {
      if (!this.syncs.get(folderPath)) {
        this.update(folderPath, undefined);
      }
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    for (const [folderPath, snap] of this.shown) {
      const rel = path.relative(folderPath, uri.fsPath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        continue;
      }
      const badge = badgeFor(rel.split(path.sep).join('/'), snap);
      if (badge) {
        return new vscode.FileDecoration(
          badge.badge,
          badge.tooltip,
          new vscode.ThemeColor(
            badge.kind === 'conflict' ? 'gitDecoration.conflictingResourceForeground' : 'overleafconnect.pendingResourceForeground'
          )
        );
      }
    }
    return undefined;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
