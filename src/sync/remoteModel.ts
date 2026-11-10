// What a pull brought from Overleaf and how it is announced. No vscode import, so it is tested with plain mocha.

import { RemoteCommit } from '../ui/syncModel';

/** Overleaf's changes in one pull: compare `base` (where the two sides split) with `head` (Overleaf's tip). */
export interface RemoteUpdate {
  base: string;
  head: string;
  commits: RemoteCommit[];
  files: string[];
}

/** The tree of a repository with no files, used as the "before" of a root commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** URI scheme of the read-only documents that hold a file at one commit. */
export const REV_SCHEME = 'overleafconnect-rev';

export function encodeRevQuery(folderPath: string, ref: string): string {
  return new URLSearchParams({ folder: folderPath, ref }).toString();
}

export function decodeRevQuery(query: string): { folderPath: string; ref: string } | undefined {
  const params = new URLSearchParams(query);
  const folderPath = params.get('folder');
  const ref = params.get('ref');
  return folderPath && ref && /^[0-9a-f]{4,64}$/i.test(ref) ? { folderPath, ref } : undefined;
}

/** Authors in the order they first appear, newest commit first. */
export function authorsOf(commits: RemoteCommit[]): string[] {
  return [...new Set(commits.map((c) => c.author).filter(Boolean))];
}

function joinAuthors(authors: string[]): string {
  if (authors.length <= 2) {
    return authors.join(' and ');
  }
  return `${authors[0]} and ${authors.length - 1} others`;
}

/** "main.tex updated on Overleaf by Ayşe", or undefined when the pull changed no files. */
export function summarizeRemoteUpdate(update: RemoteUpdate): string | undefined {
  if (!update.files.length) {
    return undefined;
  }
  const what = update.files.length === 1 ? update.files[0].split('/').pop() : `${update.files.length} files`;
  const verb = update.files.length === 1 ? 'was' : 'were';
  const who = joinAuthors(authorsOf(update.commits));
  return `${what} ${verb} updated on Overleaf${who ? ` by ${who}` : ''}.`;
}

/** The diff editor's title for one file of an update. */
export function revDiffTitle(relativePath: string, before: boolean, after: boolean): string {
  const name = relativePath.split('/').pop() || relativePath;
  const note = !before ? ' (new)' : !after ? ' (deleted)' : '';
  return `${name} — before ↔ Overleaf${note}`;
}

/** Two pulls in a row as one: from the first one's base to the second one's head. */
export function mergeUpdates(first: RemoteUpdate, next: RemoteUpdate): RemoteUpdate {
  return {
    base: first.base,
    head: next.head,
    commits: [...next.commits, ...first.commits],
    files: [...new Set([...first.files, ...next.files])],
  };
}
