import * as vscode from 'vscode';
import simpleGit, { SimpleGit, PullResult, StatusResult } from 'simple-git';
import { GitEngineOptions } from '../types';
import { buildAuthenticatedUrl } from '../auth/credentialHelper';

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

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  dispose(): void {
    // simple-git doesn't hold resources
  }
}
