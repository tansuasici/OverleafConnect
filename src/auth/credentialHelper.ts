import simpleGit, { SimpleGit } from 'simple-git';

/** The environment variable that carries the token to the credential helper; its value never reaches argv or disk. */
export const TOKEN_ENV = 'OVERLEAFCONNECT_TOKEN';

/**
 * `-c` settings that make git ask us, and only us, for the Overleaf credentials. The empty entry clears helpers from
 * the user's config first, so a keychain helper neither answers with a stale token nor stores ours. The helper reads
 * the token from the environment, so argv holds only the variable's name.
 */
export function credentialConfig(username = 'git'): string[] {
  return [
    'credential.helper=',
    `credential.helper=!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' '${username}' "$${TOKEN_ENV}"; }; f`,
  ];
}

/** The process environment plus the token, with terminal prompts off so a rejected token fails instead of hanging. */
export function credentialEnv(token: string): NodeJS.ProcessEnv {
  return { ...process.env, [TOKEN_ENV]: token, GIT_TERMINAL_PROMPT: '0' };
}

/** A git client that authenticates to Overleaf with `token` without writing it into a URL or `.git/config`. */
export function createAuthenticatedGit(options: { token: string; baseDir?: string; username?: string }): SimpleGit {
  return simpleGit({
    ...(options.baseDir ? { baseDir: options.baseDir } : {}),
    binary: 'git',
    maxConcurrentProcesses: 1,
    trimmed: true,
    config: credentialConfig(options.username),
  }).env(credentialEnv(options.token));
}

export function stripCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Removes credentials that older versions embedded in the remote URLs of `remote`. Returns true when something was
 * rewritten. FETCH_HEAD is cleared too, since git may have recorded the old URL there.
 */
export async function scrubRemoteCredentials(git: SimpleGit, remote = 'origin'): Promise<boolean> {
  let changed = false;
  for (const key of [`remote.${remote}.url`, `remote.${remote}.pushurl`]) {
    const value = (await git.raw(['config', '--get', key]).catch(() => '')).trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(value)) {
      continue;
    }
    const clean = stripCredentials(value);
    if (clean !== value) {
      await git.raw(['config', key, clean]);
      changed = true;
    }
  }
  if (changed) {
    const fs = await import('fs');
    const path = await import('path');
    const gitDir = (await git.raw(['rev-parse', '--absolute-git-dir'])).trim();
    const fetchHead = path.join(gitDir, 'FETCH_HEAD');
    if (fs.existsSync(fetchHead)) {
      fs.writeFileSync(fetchHead, '');
    }
  }
  return changed;
}
