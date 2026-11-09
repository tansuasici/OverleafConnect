import * as assert from 'assert';
import {
  badgeFor,
  changedBadgePaths,
  commitTitle,
  folderDescription,
  LOG_FORMAT,
  parseLog,
  pendingFromStatus,
  SyncSnapshot,
  timeAgo,
} from '../../src/ui/syncModel';
import { SyncGroup, FolderSync } from '../../src/sync/syncGroup';
import { SyncState } from '../../src/types';

function snap(over: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return { state: SyncState.Idle, projectUrl: '', pendingFiles: [], conflictedFiles: [], recentRemoteCommits: [], ...over };
}

suite('Sync panel model', () => {
  test('says how long ago in rough units', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    assert.strictEqual(timeAgo(new Date('2026-11-10T11:59:50Z'), now), 'just now');
    assert.strictEqual(timeAgo(new Date('2026-11-10T11:55:00Z'), now), '5 min ago');
    assert.strictEqual(timeAgo(new Date('2026-11-10T09:00:00Z'), now), '3 h ago');
    assert.strictEqual(timeAgo(new Date('2026-11-08T12:00:00Z'), now), '2 d ago');
  });

  test('describes a folder by state, pending files and last sync', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    assert.strictEqual(folderDescription(snap(), now), 'Synced');
    assert.strictEqual(
      folderDescription(snap({ state: SyncState.Disabled, pendingFiles: ['a.tex', 'b.tex'], lastSyncAt: new Date('2026-11-10T11:50:00Z') }), now),
      'Paused · 2 pending · 10 min ago'
    );
    assert.strictEqual(folderDescription(snap({ pendingFiles: ['a.tex', 'b.tex'], conflictedFiles: ['b.tex'] }), now), 'Synced · 1 pending · 1 conflicts');
  });

  test('reads git status paths, keeping the new side of a rename and dropping .git', () => {
    assert.deepStrictEqual(
      pendingFromStatus([{ path: 'b.tex' }, { path: 'old.tex -> new.tex' }, { path: 'a\\c.bib' }, { path: '.git/index' }, { path: 'b.tex' }]),
      ['a/c.bib', 'b.tex', 'new.tex']
    );
  });

  test('parses the remote log even when a subject has odd characters', () => {
    const line = ['abc123', 'Ada Lovelace', '2026-11-10T10:00:00+00:00', 'Fix | typo; in "intro"'].join('\x1f');
    const [c] = parseLog(`${line}\n\n`);
    assert.strictEqual(c.hash, 'abc123');
    assert.strictEqual(c.author, 'Ada Lovelace');
    assert.strictEqual(c.message, 'Fix | typo; in "intro"');
    assert.strictEqual(c.date.toISOString(), '2026-11-10T10:00:00.000Z');
    assert.ok(LOG_FORMAT.includes('%x1f'));
    assert.strictEqual(commitTitle('x'.repeat(80), 10), `${'x'.repeat(9)}…`);
  });

  test('badges conflicts over pending files and reports only badges that changed', () => {
    const before = snap({ pendingFiles: ['a.tex', 'b.tex'] });
    const after = snap({ pendingFiles: ['b.tex', 'c.tex'], conflictedFiles: ['b.tex'] });
    assert.strictEqual(badgeFor('a.tex', before)?.kind, 'pending');
    assert.strictEqual(badgeFor('b.tex', after)?.kind, 'conflict');
    assert.strictEqual(badgeFor('z.tex', after), undefined);
    assert.deepStrictEqual(changedBadgePaths(before, after).sort(), ['a.tex', 'b.tex', 'c.tex']);
    assert.deepStrictEqual(changedBadgePaths(after, after), []);
    assert.deepStrictEqual(changedBadgePaths(before, undefined).sort(), ['a.tex', 'b.tex']);
  });
});

suite('SyncGroup change events', () => {
  test('fires when folders come and go, not for no-ops', () => {
    const group = new SyncGroup();
    const fake = (): FolderSync => ({ paused: false, pause() {}, resume() {}, async syncNow() {}, start() {}, stop() {}, dispose() {} });
    let fired = 0;
    const sub = group.onDidChange(() => fired++);
    group.set('/a', fake());
    group.remove('/missing');
    group.remove('/a');
    group.clear();
    assert.strictEqual(fired, 2);
    sub.dispose();
    group.set('/b', fake());
    assert.strictEqual(fired, 2);
  });
});
