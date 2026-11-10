import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import { credentialConfig, credentialEnv, scrubRemoteCredentials, stripCredentials } from '../../src/auth/credentialHelper';

const TOKEN = 'olp_fakeTOKEN123';
const URL_CLEAN = 'https://git.overleaf.com/682abc123def456789abcdef';
const URL_WITH_TOKEN = `https://git:${TOKEN}@git.overleaf.com/682abc123def456789abcdef`;

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cred-'));
  spawnSync('git', ['init', '-q', dir]);
  return dir;
}

suite('Credential helper', () => {
  test('the helper hands git the token from the environment', () => {
    const args = credentialConfig().flatMap((c) => ['-c', c]);
    const out = spawnSync('git', [...args, 'credential', 'fill'], {
      input: 'protocol=https\nhost=git.overleaf.com\n\n',
      env: credentialEnv(TOKEN),
      encoding: 'utf8',
    });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /^username=git$/m);
    assert.match(out.stdout, new RegExp(`^password=${TOKEN}$`, 'm'));
  });

  test('the token never appears in the git arguments, and other helpers are cleared first', () => {
    const config = credentialConfig();
    assert.strictEqual(config[0], 'credential.helper=');
    assert.ok(config.every((c) => !c.includes(TOKEN)));
    assert.ok(!JSON.stringify(credentialConfig()).includes(TOKEN));
  });

  test('stripCredentials removes user and token', () => {
    assert.strictEqual(stripCredentials(URL_WITH_TOKEN), URL_CLEAN);
  });

  test('an origin URL holding the token is rewritten, and FETCH_HEAD is emptied', async () => {
    const dir = tempRepo();
    try {
      const git = simpleGit(dir);
      await git.raw(['remote', 'add', 'origin', URL_WITH_TOKEN]);
      await git.raw(['config', 'remote.origin.pushurl', URL_WITH_TOKEN]);
      fs.writeFileSync(path.join(dir, '.git', 'FETCH_HEAD'), `abc\t\tbranch 'master' of ${URL_WITH_TOKEN}\n`);

      assert.strictEqual(await scrubRemoteCredentials(git), true);

      assert.strictEqual((await git.remote(['get-url', 'origin']))?.trim(), URL_CLEAN);
      const config = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
      assert.ok(!config.includes(TOKEN), config);
      assert.strictEqual(fs.readFileSync(path.join(dir, '.git', 'FETCH_HEAD'), 'utf8'), '');
      assert.strictEqual(await scrubRemoteCredentials(git), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a clean origin is left alone', async () => {
    const dir = tempRepo();
    try {
      const git = simpleGit(dir);
      await git.raw(['remote', 'add', 'origin', URL_CLEAN]);
      assert.strictEqual(await scrubRemoteCredentials(git), false);
      assert.strictEqual((await git.remote(['get-url', 'origin']))?.trim(), URL_CLEAN);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
