import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import simpleGit, { SimpleGit, PullResult, StatusResult } from 'simple-git';
import { GitEngineOptions } from '../types';
import { buildAuthenticatedUrl } from '../auth/credentialHelper';
import { LOG_FORMAT, parseLog, RemoteCommit } from '../ui/syncModel';
import { ConflictSide, stageOf } from './conflictModel';
import { EMPTY_TREE, RemoteUpdate } from './remoteModel';

export class GitEngine implements vscode.Disposable {
  private git: SimpleGit;
  private authenticatedUrl: string;
  private workspacePath: string;
  private branch: string | null = null;

  constructor(options: GitEngineOptions) {
    this.workspacePath = options.workspacePath;
    this.authenticatedUrl = buildAuthenticatedUrl(
      options.remoteUrl,
      options.username,
      options.token
    );

    this.git = simpleGit({
      baseDir: options.workspacePath,
      binary: 'git',
      maxConcurrentProcesses: 1,
      trimmed: true,
    });
  }

  async clone(destPath: string): Promise<void> {
    const git = simpleGit();
    await git.clone(this.authenticatedUrl, destPath);
  }

  /**
   * Detect the default branch (master or main) from remote.
   * Cached after first successful call.
   */
  async getBranch(): Promise<string> {
    if (this.branch) {
      return this.branch;
    }
    try {
      const refs = await this.git.branch(['-r']);
      if (refs.all.some((r) => r === 'origin/main')) {
        this.branch = 'main';
      } else {
        this.branch = 'master';
      }
    } catch {
      this.branch = 'master';
    }
    return this.branch;
  }

  async pull(): Promise<PullResult> {
    const branch = await this.getBranch();
    return this.git.pull('origin', branch, ['--ff-only']);
  }

  async pullRebase(): Promise<PullResult> {
    const branch = await this.getBranch();
    return this.git.pull('origin', branch, ['--rebase']);
  }

  async pullMerge(): Promise<PullResult> {
    const branch = await this.getBranch();
    return this.git.pull('origin', branch, ['--no-rebase']);
  }

  async push(): Promise<void> {
    const branch = await this.getBranch();
    await this.git.push('origin', branch);
  }

  async fetch(): Promise<void> {
    await this.git.fetch('origin');
  }

  async status(): Promise<StatusResult> {
    return this.git.status();
  }

  /** Status listing each untracked file, not just its new folder. */
  async statusAllFiles(): Promise<StatusResult> {
    return this.git.status(['-uall']);
  }

  async addAll(): Promise<void> {
    await this.git.add('-A');
  }

  async commit(message: string): Promise<void> {
    await this.git.commit(message);
  }

  async hasUncommittedChanges(): Promise<boolean> {
    const st = await this.status();
    return !st.isClean();
  }

  /**
   * Compare HEAD vs FETCH_HEAD after a fetch has already been done.
   * Does NOT fetch again - caller must ensure fetch() was called first.
   */
  async hasRemoteChanges(): Promise<boolean> {
    try {
      const local = await this.git.revparse(['HEAD']);
      const remote = await this.git.revparse(['FETCH_HEAD']);
      return local !== remote;
    } catch {
      return false;
    }
  }

  async isGitRepo(): Promise<boolean> {
    try {
      return await this.git.checkIsRepo();
    } catch {
      return false;
    }
  }

  async abortRebase(): Promise<void> {
    await this.git.rebase(['--abort']);
  }

  async abortMerge(): Promise<void> {
    await this.git.raw(['merge', '--abort']);
  }

  async getConflictedFiles(): Promise<string[]> {
    const st = await this.status();
    return st.conflicted;
  }

  /** True while a merge waits to be committed (MERGE_HEAD exists). */
  async isMerging(): Promise<boolean> {
    return this.gitPathExists('MERGE_HEAD');
  }

  /** True while a rebase is stopped; then stage 2 is Overleaf's side, not yours. */
  async isRebasing(): Promise<boolean> {
    return (await this.gitPathExists('rebase-merge')) || (await this.gitPathExists('rebase-apply'));
  }

  // Checked on disk: simple-git does not reject on a non-zero exit with empty stderr, so `rev-parse -q --verify` cannot tell.
  private async gitPathExists(name: string): Promise<boolean> {
    try {
      const p = await this.git.raw(['rev-parse', '--git-path', name]);
      return fs.existsSync(path.resolve(this.workspacePath, p.trim()));
    } catch {
      return false;
    }
  }

  /** Paths git still marks unmerged, whatever kind of conflict (content, modify/delete, add/add). */
  async unmergedFiles(): Promise<string[]> {
    const out = await this.git.raw(['diff', '--name-only', '--diff-filter=U']);
    return [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))];
  }

  async hasStage(stage: 2 | 3, relativePath: string): Promise<boolean> {
    try {
      await this.git.raw(['cat-file', '-e', `:${stage}:${relativePath}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** One side of a conflicted file, exactly as stored, or undefined when that side deleted it. */
  async showStage(side: ConflictSide, relativePath: string): Promise<string | undefined> {
    const stage = stageOf(side);
    if (!(await this.hasStage(stage, relativePath))) {
      return undefined;
    }
    // A separate instance: the shared one trims output, which would change the file's first and last lines.
    return simpleGit({ baseDir: this.workspacePath, trimmed: false }).raw(['show', `:${stage}:${relativePath}`]);
  }

  /** Resolves a conflicted file with one side's version, deleting it when that side deleted it. */
  async resolveWith(side: ConflictSide, relativePath: string): Promise<void> {
    if (await this.hasStage(stageOf(side), relativePath)) {
      await this.git.raw(['checkout', `--${side}`, '--', relativePath]);
      await this.git.raw(['add', '--', relativePath]);
    } else {
      await this.git.raw(['rm', '-q', '--', relativePath]);
    }
  }

  /** Records the file as it is on disk (or its deletion) as the resolution. */
  async markResolved(relativePath: string): Promise<void> {
    if (fs.existsSync(path.join(this.workspacePath, relativePath))) {
      await this.git.raw(['add', '--', relativePath]);
    } else {
      await this.git.raw(['rm', '-q', '--cached', '--', relativePath]);
    }
  }

  /** Commits the merge once nothing is unmerged, with a fixed message so no remote URL lands in Overleaf's history. */
  async commitMerge(): Promise<void> {
    await this.git.raw(['commit', '-m', 'Merge changes from Overleaf']);
  }

  /** The newest commits on the Overleaf branch as of the last fetch. */
  async remoteLog(count: number): Promise<RemoteCommit[]> {
    const branch = await this.getBranch();
    try {
      return parseLog(await this.git.raw(['log', `origin/${branch}`, `-n${count}`, `--format=${LOG_FORMAT}`]));
    } catch {
      return [];
    }
  }

  /** What the next pull brings from Overleaf, as of the last fetch: its commits and the files they change from the merge base. */
  async incomingUpdate(): Promise<RemoteUpdate | undefined> {
    const branch = await this.getBranch();
    try {
      const head = (await this.git.raw(['rev-parse', `origin/${branch}`])).trim();
      const base = (await this.git.raw(['merge-base', 'HEAD', head])).trim();
      if (!base || base === head) {
        return undefined;
      }
      const commits = parseLog(await this.git.raw(['log', `${base}..${head}`, `--format=${LOG_FORMAT}`]));
      return { base, head, commits, files: await this.changedFiles(base, head) };
    } catch {
      return undefined;
    }
  }

  /** One commit as an update: its parent (or an empty tree for the first commit) against it. */
  async commitUpdate(hash: string): Promise<RemoteUpdate | undefined> {
    try {
      const head = (await this.git.raw(['rev-parse', '--verify', `${hash}^{commit}`])).trim();
      const parents = (await this.git.raw(['rev-list', '--parents', '-n1', head])).trim().split(/\s+/);
      const base = parents[1] ?? EMPTY_TREE;
      const commits = parseLog(await this.git.raw(['log', '-n1', head, `--format=${LOG_FORMAT}`]));
      return { base, head, commits, files: await this.changedFiles(base, head) };
    } catch {
      return undefined;
    }
  }

  private async changedFiles(from: string, to: string): Promise<string[]> {
    const out = await this.git.raw(['diff', '--name-only', '--no-renames', from, to]);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  /** A file as it was at a commit, exactly as stored, or undefined when it did not exist there. */
  async showAt(ref: string, relativePath: string): Promise<string | undefined> {
    if (ref === EMPTY_TREE) {
      return undefined;
    }
    try {
      await this.git.raw(['cat-file', '-e', `${ref}:${relativePath}`]);
    } catch {
      return undefined;
    }
    return simpleGit({ baseDir: this.workspacePath, trimmed: false }).raw(['show', `${ref}:${relativePath}`]);
  }

  /** Files in local commits that Overleaf does not have yet (three dots: from the merge base, so Overleaf's own new commits are not counted). */
  async unpushedFiles(): Promise<string[]> {
    const branch = await this.getBranch();
    try {
      const out = await this.git.raw(['diff', '--name-only', `origin/${branch}...HEAD`]);
      return out.split('\n').map((l) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  dispose(): void {
    // simple-git doesn't hold resources
  }
}
