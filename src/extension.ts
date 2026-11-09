import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import simpleGit from 'simple-git';

import { AuthManager } from './auth/authManager';
import { GitEngine } from './sync/gitEngine';
import { FileWatcher } from './sync/fileWatcher';
import { SyncManager } from './sync/syncManager';
import { StatusBarManager } from './ui/statusBar';
import { BuildSyncGate, OVERTEX_ID, OVERTEX_SYNC_EXCLUDES, OvertexBuildEvents } from './latex/overtex';
import { SyncState } from './types';
import { getConfig } from './utils/config';
import { getOutputChannel } from './ui/outputChannel';
import { ensureGitignore } from './utils/gitignore';

let syncManager: SyncManager | undefined;
let statusBar: StatusBarManager | undefined;
const buildSyncGate = new BuildSyncGate(() => syncManager);

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = getOutputChannel();
  const config = getConfig();

  // Initialize auth
  const authManager = new AuthManager(context);

  // Initialize status bar
  statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  // Overtex (a dependency) builds and previews; its output must not be pushed to Overleaf.
  const syncExcludes = () => [...config.sync.excludePatterns, ...OVERTEX_SYNC_EXCLUDES];

  // ---- Register Sync Commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.configure', async () => {
      const creds = await authManager.promptForCredentials();
      if (creds && vscode.workspace.workspaceFolders?.length) {
        await initializeSync(context, authManager, config, syncExcludes());
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.cloneProject', async () => {
      // Always ask for project ID/URL
      const creds = await authManager.promptForClone();

      if (!creds) {
        return;
      }

      const targetFolder = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Select Destination Folder',
      });

      if (!targetFolder || targetFolder.length === 0) {
        return;
      }

      const projectName = await vscode.window.showInputBox({
        prompt: 'Enter a folder name for the project',
        value: 'overleaf-project',
        ignoreFocusOut: true,
      });

      if (!projectName) {
        return;
      }

      const destPath = path.join(targetFolder[0].fsPath, projectName);

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Cloning Overleaf project...' },
          async () => {
            const { buildAuthenticatedUrl } = await import('./auth/credentialHelper');
            const authUrl = buildAuthenticatedUrl(creds.projectUrl, 'git', creds.token);
            await simpleGit().clone(authUrl, destPath);
          }
        );

        // Create .overleafconnect marker
        const markerPath = path.join(destPath, '.overleafconnect');
        fs.writeFileSync(markerPath, JSON.stringify({
          projectUrl: creds.projectUrl,
          configured: true,
        }, null, 2));

        // Create .gitignore with exclude patterns
        await ensureGitignore(destPath, syncExcludes());

        const openChoice = await vscode.window.showInformationMessage(
          'Overleaf Connect: Project cloned successfully!',
          'Open in New Window',
          'Open in Current Window'
        );

        if (openChoice === 'Open in New Window') {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destPath), true);
        } else if (openChoice === 'Open in Current Window') {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destPath), false);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Overleaf Connect: Clone failed - ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.syncNow', async () => {
      if (syncManager) {
        await syncManager.syncNow();
      } else {
        vscode.window.showWarningMessage('Overleaf Connect: Not connected to Overleaf. Please configure first.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.pauseSync', () => {
      buildSyncGate.release();
      syncManager?.pause();
      statusBar?.update(SyncState.Disabled);
      vscode.window.showInformationMessage('Overleaf Connect: Auto-sync paused.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.resumeSync', () => {
      buildSyncGate.release();
      syncManager?.resume();
      statusBar?.update(SyncState.Idle);
      vscode.window.showInformationMessage('Overleaf Connect: Auto-sync resumed.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.logout', async () => {
      await authManager.deleteToken();
      syncManager?.stop();
      syncManager = undefined;
      statusBar?.update(SyncState.NotConfigured);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.showLog', () => {
      outputChannel.show();
    })
  );

  // ---- Follow Overtex builds ----
  // Not awaited: sync must start even if Overtex is slow to activate or fails to.
  void followOvertexBuilds(context, outputChannel);

  // ---- Sync on save ----
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (syncManager && (doc.languageId === 'latex' || doc.fileName.endsWith('.bib'))) {
        outputChannel.appendLine('[Overleaf Connect] File saved, triggering sync...');
        await syncManager.syncNow();
      }
    })
  );

  // ---- Initialize Sync if already configured ----
  if (await authManager.isAuthenticated() && vscode.workspace.workspaceFolders?.length) {
    await initializeSync(context, authManager, config, syncExcludes());
  } else {
    statusBar.update(SyncState.NotConfigured);
  }

  // ---- React to config changes ----
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('overleafconnect')) {
        if (syncManager && e.affectsConfiguration('overleafconnect.sync.intervalSeconds')) {
          syncManager.stop();
          syncManager.start();
        }
        outputChannel.appendLine('[Overleaf Connect] Configuration updated');
      }
    })
  );

  outputChannel.appendLine('[Overleaf Connect] Extension activated');
}

async function initializeSync(
  context: vscode.ExtensionContext,
  authManager: AuthManager,
  config: ReturnType<typeof getConfig>,
  excludePatterns: string[]
): Promise<void> {
  // Dispose previous sync instance if reconfiguring
  if (syncManager) {
    syncManager.dispose();
    syncManager = undefined;
  }

  const workspacePath = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const token = (await authManager.getToken())!;
  const projectUrl = (await authManager.getProjectUrl())!;

  const gitEngine = new GitEngine({
    workspacePath,
    remoteUrl: projectUrl,
    username: 'git',
    token,
  });

  // Check if it's a git repo
  const isRepo = await gitEngine.isGitRepo();
  if (!isRepo) {
    const outputChannel = getOutputChannel();
    outputChannel.appendLine('[Overleaf Connect] Workspace is not a git repository. Use "Clone Overleaf Project" first.');
    statusBar?.update(SyncState.NotConfigured);
    gitEngine.dispose();
    return;
  }

  // Ensure .gitignore has exclude patterns
  await ensureGitignore(workspacePath, excludePatterns);

  const fileWatcher = new FileWatcher(workspacePath);
  syncManager = new SyncManager(gitEngine, fileWatcher, config);

  // Wire up status bar
  syncManager.onDidChangeState((state) => statusBar!.update(state));

  // Pull on open
  if (config.sync.pullOnOpen) {
    await syncManager.syncNow();
  }

  // Start auto-sync
  if (config.sync.enabled) {
    syncManager.start();
  }

  context.subscriptions.push(gitEngine, fileWatcher, syncManager);
}

/** Holds sync back during every Overtex build, including the ones it starts on save. */
async function followOvertexBuilds(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  try {
    const api = await vscode.extensions.getExtension<OvertexBuildEvents>(OVERTEX_ID)?.activate();
    if (!api?.onDidStartBuild || !api.onDidEndBuild) {
      outputChannel.appendLine('[Overleaf Connect] This Overtex version has no build events; sync continues during builds');
      return;
    }
    context.subscriptions.push(
      api.onDidStartBuild(() => buildSyncGate.buildStarted()),
      api.onDidEndBuild(() => void buildSyncGate.buildEnded())
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Overleaf Connect] Could not connect to Overtex: ${msg}`);
  }
}

export function deactivate(): void {
  syncManager?.stop();
}
