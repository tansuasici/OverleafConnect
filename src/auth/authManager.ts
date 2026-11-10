import * as vscode from 'vscode';
import simpleGit from 'simple-git';
import { getConfig } from '../utils/config';
import { pickProjectUrl, readMarker, resolveProjectUrl, writeMarker } from './projectUrl';
import { normalizeCookie } from '../web/webModel';

const SECRET_KEY_TOKEN = 'overleafconnect.overleaf.token';
/** The browser session cookie ("name=value") for the web features; never logged or shown. */
const SECRET_KEY_SESSION_COOKIE = 'overleafconnect.overleaf.sessionCookie';
/** Older versions kept one project URL for every workspace; it is only read now, to migrate it. */
const SECRET_KEY_LEGACY_PROJECT_URL = 'overleafconnect.overleaf.projectUrl';

export class AuthManager implements vscode.Disposable {
  private secretStorage: vscode.SecretStorage;

  constructor(context: vscode.ExtensionContext) {
    this.secretStorage = context.secrets;
  }

  async getToken(): Promise<string | undefined> {
    return this.secretStorage.get(SECRET_KEY_TOKEN);
  }

  async setToken(token: string): Promise<void> {
    await this.secretStorage.store(SECRET_KEY_TOKEN, token);
  }

  async deleteToken(): Promise<void> {
    await this.secretStorage.delete(SECRET_KEY_TOKEN);
    await this.secretStorage.delete(SECRET_KEY_LEGACY_PROJECT_URL);
    await this.secretStorage.delete(SECRET_KEY_SESSION_COOKIE);
    vscode.window.showInformationMessage('Overleaf Connect: Overleaf credentials cleared.');
  }

  async getSessionCookie(): Promise<string | undefined> {
    return this.secretStorage.get(SECRET_KEY_SESSION_COOKIE);
  }

  async deleteSessionCookie(): Promise<void> {
    await this.secretStorage.delete(SECRET_KEY_SESSION_COOKIE);
  }

  /** Asks for the session cookie in a password box and stores it; undefined when cancelled. */
  async promptForSessionCookie(): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
      title: 'Overleaf Connect: Overleaf Session Cookie',
      prompt:
        'For the project list, comments and compiling on Overleaf. In your browser, signed in to Overleaf, copy the session cookie as name=value (on overleaf.com it is overleaf_session2).',
      placeHolder: 'overleaf_session2=...',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (normalizeCookie(v) ? null : 'Paste the cookie as name=value'),
    });
    const cookie = input && normalizeCookie(input);
    if (!cookie) {
      return undefined;
    }
    await this.secretStorage.store(SECRET_KEY_SESSION_COOKIE, cookie);
    return cookie;
  }

  /**
   * The project a folder syncs with: its .overleafconnect marker, else its origin remote. A URL saved
   * globally by an older version is moved into the marker of the folder whose origin it matches.
   */
  async getProjectUrl(folderPath: string): Promise<string | undefined> {
    const legacyUrl = await this.secretStorage.get(SECRET_KEY_LEGACY_PROJECT_URL);
    let originUrl: string | undefined;
    try {
      originUrl = await simpleGit({ baseDir: folderPath }).remote(['get-url', 'origin']) || undefined;
    } catch {
      originUrl = undefined;
    }
    const resolved = pickProjectUrl({
      marker: readMarker(folderPath),
      originUrl,
      legacyUrl,
      serverUrl: getConfig().overleaf.serverUrl,
    });
    if (resolved?.source === 'legacy') {
      try {
        writeMarker(folderPath, resolved.url);
        await this.secretStorage.delete(SECRET_KEY_LEGACY_PROJECT_URL);
      } catch {
        // Keep the old key; the folder still resolves through it next time.
      }
    }
    return resolved?.url;
  }

  async isAuthenticated(folderPath: string): Promise<boolean> {
    const token = await this.getToken();
    return !!token && !!(await this.getProjectUrl(folderPath));
  }

  private resolveProjectUrl(input: string): string | null {
    return resolveProjectUrl(input, getConfig().overleaf.serverUrl);
  }

  async promptForCredentials(folderPath: string): Promise<{ token: string; projectUrl: string } | undefined> {
    const rawInput = await vscode.window.showInputBox({
      title: 'Overleaf Connect: Overleaf Project',
      prompt: 'Enter project ID, Overleaf URL, or Git URL',
      placeHolder: 'abc123def456 veya https://www.overleaf.com/project/abc123def456',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value) {
          return 'Project ID or URL is required';
        }
        if (!this.resolveProjectUrl(value)) {
          return 'Enter a project ID (e.g. abc123def456) or an Overleaf URL';
        }
        return null;
      },
    });

    if (!rawInput) {
      return undefined;
    }

    const projectUrl = this.resolveProjectUrl(rawInput)!;

    const token = await vscode.window.showInputBox({
      title: 'Overleaf Connect: Overleaf Authentication Token',
      prompt: 'Enter your Overleaf Git authentication token (from Account Settings)',
      placeHolder: 'olp_...',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value) {
          return 'Token is required';
        }
        return null;
      },
    });

    if (!token) {
      return undefined;
    }

    const valid = await this.validateToken(token, projectUrl);
    if (!valid) {
      vscode.window.showErrorMessage(
        'Overleaf Connect: Authentication failed. Please check your URL and token.'
      );
      return undefined;
    }

    await this.setToken(token);
    writeMarker(folderPath, projectUrl);

    vscode.window.showInformationMessage('Overleaf Connect: Successfully connected to Overleaf!');
    return { token, projectUrl };
  }

  /**
   * For clone: always asks project ID, reuses existing token if available. The caller writes the
   * project URL into the new folder's marker, so the open workspace keeps its own project.
   * No pre-validation - clone itself serves as validation.
   */
  async promptForClone(projectId?: string): Promise<{ token: string; projectUrl: string } | undefined> {
    const rawInput = projectId ?? await vscode.window.showInputBox({
      title: 'Overleaf Connect: Overleaf Project',
      prompt: 'Enter project ID, Overleaf URL, or Git URL',
      placeHolder: 'abc123def456',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value) {
          return 'Project ID or URL is required';
        }
        if (!this.resolveProjectUrl(value)) {
          return 'Enter a project ID (e.g. abc123def456) or an Overleaf URL';
        }
        return null;
      },
    });

    if (!rawInput) {
      return undefined;
    }

    const projectUrl = this.resolveProjectUrl(rawInput)!;

    // Reuse stored token, otherwise ask
    let token = await this.getToken();
    if (!token) {
      token = await vscode.window.showInputBox({
        title: 'Overleaf Connect: Overleaf Authentication Token',
        prompt: 'Enter your Overleaf Git authentication token',
        placeHolder: 'olp_...',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => v ? null : 'Token is required',
      }) ?? undefined;

      if (!token) {
        return undefined;
      }
      await this.setToken(token);
    }

    return { token, projectUrl };
  }

  async validateToken(token: string, projectUrl: string): Promise<boolean> {
    try {
      const { createAuthenticatedGit, stripCredentials } = await import('./credentialHelper');
      await createAuthenticatedGit({ token }).listRemote([stripCredentials(projectUrl)]);
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    // No resources to clean up
  }
}
