// Turns a folder's sync snapshot into what the panel, the explorer badges and the status bar show.
// No vscode import, so it is tested with plain mocha.

import { SyncState } from '../types';

export interface RemoteCommit {
  hash: string;
  message: string;
  author: string;
  date: Date;
}

export interface SyncSnapshot {
  state: SyncState;
  projectUrl: string;
  lastSyncAt?: Date;
  lastError?: string;
  /** Paths relative to the folder, with forward slashes, that Overleaf does not have yet. */
  pendingFiles: string[];
  conflictedFiles: string[];
  recentRemoteCommits: RemoteCommit[];
}

export interface StateView {
  label: string;
  /** A codicon id. */
  icon: string;
}

const STATE_VIEWS: Record<SyncState, StateView> = {
  [SyncState.Idle]: { label: 'Synced', icon: 'cloud' },
  [SyncState.Pulling]: { label: 'Pulling', icon: 'sync~spin' },
  [SyncState.Pushing]: { label: 'Pushing', icon: 'sync~spin' },
  [SyncState.Conflict]: { label: 'Conflict', icon: 'warning' },
  [SyncState.Error]: { label: 'Error', icon: 'error' },
  [SyncState.Disabled]: { label: 'Paused', icon: 'debug-pause' },
  [SyncState.NotConfigured]: { label: 'Not configured', icon: 'plug' },
};

export function stateView(state: SyncState): StateView {
  return STATE_VIEWS[state];
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function timeAgo(date: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 45) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  return `${Math.round(hours / 24)} d ago`;
}

/** The folder row's description: state, plus when it last synced or how many files wait. */
export function folderDescription(snapshot: SyncSnapshot, now: Date = new Date()): string {
  const parts = [stateView(snapshot.state).label];
  const pending = snapshot.pendingFiles.filter((f) => !snapshot.conflictedFiles.includes(f)).length;
  if (pending) {
    parts.push(`${pending} pending`);
  }
  if (snapshot.conflictedFiles.length) {
    parts.push(`${snapshot.conflictedFiles.length} conflicts`);
  }
  if (snapshot.lastSyncAt) {
    parts.push(timeAgo(snapshot.lastSyncAt, now));
  }
  return parts.join(' · ');
}

/** `git log --format` fields, separated by the unit separator so no message text can split them. */
export const LOG_FORMAT = '%H%x1f%an%x1f%aI%x1f%s';

export function parseLog(output: string): RemoteCommit[] {
  return output
    .split('\n')
    .map((line) => line.split('\x1f'))
    .filter((f) => f.length >= 4 && f[0])
    .map(([hash, author, date, ...rest]) => ({ hash, author, date: new Date(date), message: rest.join('\x1f') }));
}

/** The first line of a commit message, shortened for a tree row. */
export function commitTitle(message: string, max = 60): string {
  const first = message.split('\n')[0].trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** Changed paths in a git status, relative and with forward slashes, without the .git folder. */
export function pendingFromStatus(files: { path: string }[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    // simple-git reports a rename as "old -> new"; the new path is the one on disk.
    const p = (f.path.includes(' -> ') ? f.path.split(' -> ')[1] : f.path).replace(/\\/g, '/').replace(/^"|"$/g, '');
    if (p && !p.startsWith('.git/')) {
      out.add(p);
    }
  }
  return [...out].sort();
}

export interface Badge {
  badge: string;
  tooltip: string;
  kind: 'pending' | 'conflict';
}

/** The explorer badge for one file, or undefined when Overleaf already has it. */
export function badgeFor(relativePath: string, snapshot: SyncSnapshot): Badge | undefined {
  if (snapshot.conflictedFiles.includes(relativePath)) {
    return { badge: '⚠', tooltip: 'Conflicts with Overleaf', kind: 'conflict' };
  }
  if (snapshot.pendingFiles.includes(relativePath)) {
    return { badge: '↑', tooltip: 'Not on Overleaf yet', kind: 'pending' };
  }
  return undefined;
}

/** Every path whose badge may have changed between two snapshots of a folder. */
export function changedBadgePaths(before: SyncSnapshot | undefined, after: SyncSnapshot | undefined): string[] {
  const all = new Set<string>([
    ...(before?.pendingFiles ?? []),
    ...(before?.conflictedFiles ?? []),
    ...(after?.pendingFiles ?? []),
    ...(after?.conflictedFiles ?? []),
  ]);
  return [...all].filter((p) => {
    const a = before && badgeFor(p, before);
    const b = after && badgeFor(p, after);
    return a?.kind !== b?.kind;
  });
}
