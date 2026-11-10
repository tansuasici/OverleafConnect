import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isOverleafGitUrl,
  pickProjectUrl,
  projectIdFromUrl,
  projectUrlFromRemote,
  projectWebUrl,
  readMarker,
  resolveProjectUrl,
  writeMarker,
} from '../../src/auth/projectUrl';
import { SyncGroup, FolderSync } from '../../src/sync/syncGroup';

const ID = '682abc123def456789abcdef';
const URL_A = `https://git.overleaf.com/${ID}`;
const URL_B = 'https://git.overleaf.com/aaaaaaaaaaaaaaaaaaaaaaaa';

suite('Per-folder project URL', () => {
  test('resolves IDs, project pages and Git URLs', () => {
    assert.strictEqual(resolveProjectUrl(ID, 'https://git.overleaf.com/'), URL_A);
    assert.strictEqual(resolveProjectUrl(`https://www.overleaf.com/project/${ID}`, 'https://git.overleaf.com'), URL_A);
    assert.strictEqual(resolveProjectUrl(URL_A, 'https://git.overleaf.com'), URL_A);
    assert.strictEqual(resolveProjectUrl('not a project', 'https://git.overleaf.com'), null);
  });

  test('reads the origin remote without the token a clone left in it', () => {
    assert.strictEqual(projectUrlFromRemote(`https://git:olp_secret@git.overleaf.com/${ID}\n`), URL_A);
    assert.strictEqual(projectUrlFromRemote('git@github.com:me/repo.git'), undefined);
    assert.strictEqual(projectUrlFromRemote(undefined), undefined);
    assert.strictEqual(projectIdFromUrl(URL_A), ID);
  });

  test('recognizes only Overleaf project remotes', () => {
    assert.ok(isOverleafGitUrl(URL_A));
    assert.ok(!isOverleafGitUrl('https://github.com/me/repo'));
    assert.ok(isOverleafGitUrl(`https://latex.example.edu/${ID}`, 'https://latex.example.edu'));
  });

  test('prefers the marker, then origin, and keeps the old global URL to its own project', () => {
    assert.deepStrictEqual(pickProjectUrl({ marker: { projectUrl: URL_B }, originUrl: URL_A, legacyUrl: URL_A }), {
      url: URL_B,
      source: 'marker',
    });
    assert.deepStrictEqual(pickProjectUrl({ originUrl: `https://git:t@git.overleaf.com/${ID}`, legacyUrl: URL_A }), {
      url: URL_A,
      source: 'legacy',
    });
    assert.deepStrictEqual(pickProjectUrl({ originUrl: URL_B, legacyUrl: URL_A }), { url: URL_B, source: 'origin' });
    // A folder that is some other repository never inherits the old global URL.
    assert.strictEqual(pickProjectUrl({ originUrl: 'https://github.com/me/repo', legacyUrl: URL_A }), undefined);
    assert.strictEqual(pickProjectUrl({ legacyUrl: URL_A }), undefined);
  });

  test('writes and reads the marker, keeping fields it does not know', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-marker-'));
    try {
      assert.strictEqual(readMarker(dir), undefined);
      fs.writeFileSync(path.join(dir, '.overleafconnect'), '{broken');
      assert.strictEqual(readMarker(dir), undefined);
      fs.writeFileSync(path.join(dir, '.overleafconnect'), JSON.stringify({ projectUrl: URL_A, extra: 1 }));
      writeMarker(dir, URL_B);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.overleafconnect'), 'utf8')), {
        projectUrl: URL_B,
        extra: 1,
        configured: true,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fakeFolderSync(): FolderSync & { log: string[] } {
  return {
    log: [],
    paused: false,
    pause() {
      (this as { paused: boolean }).paused = true;
    },
    resume() {
      (this as { paused: boolean }).paused = false;
    },
    async syncNow() {
      this.log.push('sync');
    },
    start() {
      this.log.push('start');
    },
    stop() {
      this.log.push('stop');
    },
    dispose() {
      this.log.push('dispose');
    },
  };
}

suite('projectWebUrl', () => {
  test('maps the Git bridge to the project page', () => {
    assert.strictEqual(projectWebUrl('https://git.overleaf.com/0123456789abcdef01234567'), 'https://www.overleaf.com/project/0123456789abcdef01234567');
    assert.strictEqual(projectWebUrl('https://git:tok@git.overleaf.com/0123456789abcdef01234567/'), 'https://www.overleaf.com/project/0123456789abcdef01234567');
  });

  test('keeps a self-hosted server and drops its git. prefix', () => {
    assert.strictEqual(projectWebUrl('https://git.latex.example.edu/0123456789ab'), 'https://latex.example.edu/project/0123456789ab');
    assert.strictEqual(projectWebUrl('http://overleaf.local:8080/0123456789ab'), 'http://overleaf.local:8080/project/0123456789ab');
  });

  test('returns undefined without a project id', () => {
    assert.strictEqual(projectWebUrl('https://git.overleaf.com/'), undefined);
    assert.strictEqual(projectWebUrl('not a url'), undefined);
  });
});

suite('SyncGroup', () => {
  test('drives every folder and counts as paused only when all are', async () => {
    const group = new SyncGroup();
    const a = fakeFolderSync();
    const b = fakeFolderSync();
    assert.strictEqual(group.paused, false);
    group.set('/a', a);
    group.set('/b', b);
    await group.syncNow();
    assert.deepStrictEqual([a.log, b.log], [['sync'], ['sync']]);
    a.pause();
    assert.strictEqual(group.paused, false);
    group.pause();
    assert.strictEqual(group.paused, true);
    group.resume();
    assert.strictEqual(b.paused, false);
  });

  test('disposes a folder sync when it is replaced or removed', () => {
    const group = new SyncGroup();
    const first = fakeFolderSync();
    group.set('/a', first);
    group.set('/a', fakeFolderSync());
    assert.deepStrictEqual(first.log, ['dispose']);
    group.remove('/a');
    assert.strictEqual(group.size, 0);
  });
});
