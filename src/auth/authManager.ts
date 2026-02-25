import * as vscode from 'vscode';
import simpleGit from 'simple-git';
import { getConfig } from '../utils/config';

const SECRET_KEY_TOKEN = 'overleafconnect.overleaf.token';
const SECRET_KEY_PROJECT_URL = 'overleafconnect.overleaf.projectUrl';

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
    await this.secretStorage.delete(SECRET_KEY_PROJECT_URL);
    vscode.window.showInformationMessage('Overleaf Connect: Overleaf credentials cleared.');
  }

  async getProjectUrl(): Promise<string | undefined> {
    return this.secretStorage.get(SECRET_KEY_PROJECT_URL);
  }

  async setProjectUrl(url: string): Promise<void> {
    await this.secretStorage.store(SECRET_KEY_PROJECT_URL, url);
  }

  async isAuthenticated(): Promise<boolean> {
    const token = await this.getToken();
    const url = await this.getProjectUrl();
    return !!token && !!url;
  }

  /**
   * Accepts project ID, Overleaf project URL, or full Git URL.
   * Examples:
   *   "682abc123def"
   *   "https://www.overleaf.com/project/682abc123def"
   *   "https://git.overleaf.com/682abc123def"
   */
  private resolveProjectUrl(input: string): string | null {
    const trimmed = input.trim();
    const serverUrl = getConfig().overleaf.serverUrl.replace(/\/$/, '');

    // Already a full git URL
    if (/^https:\/\/.+\/[a-f0-9]+$/i.test(trimmed)) {
      return trimmed;
    }

    // Overleaf web project URL: https://www.overleaf.com/project/<id>
    const webMatch = trimmed.match(/overleaf\.com\/project\/([a-f0-9]+)/i);
    if (webMatch) {
      return `${serverUrl}/${webMatch[1]}`;
    }

    // Bare project ID (hex string, typically 24 chars)
    if (/^[a-f0-9]+$/i.test(trimmed)) {
      return `${serverUrl}/${trimmed}`;
    }

    return null;
  }

  async promptForCredentials(): Promise<{ token: string; projectUrl: string } | undefined> {
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
    await this.setProjectUrl(projectUrl);

    vscode.window.showInformationMessage('Overleaf Connect: Successfully connected to Overleaf!');
    return { token, projectUrl };
  }

  /**
   * For clone: always asks project ID, reuses existing token if available.
   * No pre-validation - clone itself serves as validation.
   */
  async promptForClone(): Promise<{ token: string; projectUrl: string } | undefined> {
    const rawInput = await vscode.window.showInputBox({
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

    await this.setProjectUrl(projectUrl);
    return { token, projectUrl };
  }

  async validateToken(token: string, projectUrl: string): Promise<boolean> {
    try {
      const url = new URL(projectUrl);
      url.username = 'git';
      url.password = token;

      const git = simpleGit();
      await git.listRemote([url.toString()]);
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    // No resources to clean up
  }
}
