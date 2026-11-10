import * as vscode from 'vscode';
import * as path from 'path';
import simpleGit from 'simple-git';

import { AuthManager } from './auth/authManager';
import { GitEngine } from './sync/gitEngine';
import { FileWatcher } from './sync/fileWatcher';
import { SyncManager } from './sync/syncManager';
import { StatusBarManager } from './ui/statusBar';
import { BuildSyncGate, OVERTEX_ID, OVERTEX_SYNC_EXCLUDES, OvertexBuildEvents } from './latex/overtex';
import { SyncGroup } from './sync/syncGroup';
import { SyncDecorationProvider, SyncTreeProvider } from './ui/syncView';
import { ConflictContentProvider, showConflictDiff } from './ui/conflictView';
import { CONFLICT_SCHEME, ConflictSide } from './sync/conflictModel';
import { REV_SCHEME } from './sync/remoteModel';
import { announceRemoteUpdate, RevisionContentProvider, showRemoteUpdate } from './ui/remoteView';
import { projectWebUrl, writeMarker } from './auth/projectUrl';
import { SyncState } from './types';
import { getConfig } from './utils/config';
import { getOutputChannel } from './ui/outputChannel';
import { ensureGitignore } from './utils/gitignore';
import { compileOnOverleaf, OverleafComments, pickProjectToClone } from './ui/webFeatures';

const syncs = new SyncGroup<SyncManager>();
let statusBar: StatusBarManager | undefined;
const buildSyncGate = new BuildSyncGate(() => (syncs.size ? syncs : undefined));
let tree: SyncTreeProvider | undefined;
let decorations: SyncDecorationProvider | undefined;

/** The sync of the active editor's folder, else the first connected folder's. */
function currentSync(): SyncManager | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
  return (folder && syncs.get(folder.uri.fsPath)) ?? syncs.entries()[0]?.[1];
}

/** Brings the status bar, the panel and the menu context keys in line with the syncs. */
function refreshViews(): void {
  const sync = currentSync();
  statusBar?.update(sync ? sync.getState() : SyncState.NotConfigured);
  tree?.refresh();
  void vscode.commands.executeCommand('setContext', 'overleafconnect.connected', syncs.size > 0);
  void vscode.commands.executeCommand('setContext', 'overleafconnect.paused', syncs.paused);
}

/** The active editor's workspace folder, when it is connected. */
function currentFolderPath(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
  return folder && syncs.get(folder.uri.fsPath) ? folder.uri.fsPath : undefined;
}

/** The folder a panel row belongs to, or the current one when run from elsewhere. */
function syncFor(node?: { folderPath?: string }): SyncManager | undefined {
  return node?.folderPath ? syncs.get(node.folderPath) : currentSync();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = getOutputChannel();
  const config = getConfig();

  // Initialize auth
  const authManager = new AuthManager(context);

  // Initialize status bar
  statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar, syncs);

  // Initialize the Overleaf panel and explorer badges
  tree = new SyncTreeProvider(syncs);
  decorations = new SyncDecorationProvider(syncs);
  context.subscriptions.push(
    tree,
    decorations,
    vscode.window.createTreeView('overleafconnect.syncView', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.window.registerFileDecorationProvider(decorations),
    syncs.onDidChange(() => {
      decorations?.prune();
      refreshViews();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => refreshViews()),
    vscode.workspace.registerTextDocumentContentProvider(CONFLICT_SCHEME, new ConflictContentProvider(syncs)),
    vscode.workspace.registerTextDocumentContentProvider(REV_SCHEME, new RevisionContentProvider(syncs))
  );

  // Overtex (a dependency) builds and previews; its output must not be pushed to Overleaf.
  const syncExcludes = () => [...config.sync.excludePatterns, ...OVERTEX_SYNC_EXCLUDES];

  const comments = new OverleafComments(authManager);
  context.subscriptions.push(comments);

  // ---- Register Sync Commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.configure', async () => {
      const folder = await pickFolder();
      if (!folder) {
        return;
      }
      const creds = await authManager.promptForCredentials(folder.uri.fsPath);
      if (creds) {
        await initializeSync(folder, authManager, config, syncExcludes());
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.cloneProject', async () => {
      // From the project list when a session cookie is stored, else by ID or URL
      const picked = await pickProjectToClone(authManager, getConfig().overleaf.serverUrl);
      if (picked === undefined) {
        return;
      }
      const creds = await authManager.promptForClone(picked ?? undefined);

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
        validateInput: (v) => (v && !/[\\/]/.test(v) ? null : 'Enter a folder name without slashes'),
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
            const { createAuthenticatedGit } = await import('./auth/credentialHelper');
            await createAuthenticatedGit({ token: creds.token }).clone(creds.projectUrl, destPath);
          }
        );

        // Create .overleafconnect marker
        writeMarker(destPath, creds.projectUrl);

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
      if (syncs.size) {
        await syncs.syncNow();
      } else {
        vscode.window.showWarningMessage('Overleaf Connect: Not connected to Overleaf. Please configure first.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.pauseSync', () => {
      buildSyncGate.release();
      syncs.pause();
      refreshViews();
      vscode.window.showInformationMessage('Overleaf Connect: Auto-sync paused.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.resumeSync', () => {
      buildSyncGate.release();
      syncs.resume();
      refreshViews();
      vscode.window.showInformationMessage('Overleaf Connect: Auto-sync resumed.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.logout', async () => {
      await authManager.deleteToken();
      vscode.workspace.workspaceFolders?.forEach((f) => comments.clear(f.uri.fsPath));
      syncs.clear();
      refreshViews();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.syncFolder', async (node?: { folderPath?: string }) => {
      await syncFor(node)?.syncNow();
    }),
    vscode.commands.registerCommand('overleafconnect.pauseFolder', (node?: { folderPath?: string }) => {
      buildSyncGate.release();
      syncFor(node)?.pause();
      refreshViews();
    }),
    vscode.commands.registerCommand('overleafconnect.resumeFolder', (node?: { folderPath?: string }) => {
      buildSyncGate.release();
      syncFor(node)?.resume();
      refreshViews();
    }),
    vscode.commands.registerCommand('overleafconnect.showConflict', async (node?: ConflictNode) => {
      const sync = node?.folderPath && syncs.get(node.folderPath);
      if (sync && node?.relativePath) {
        await showConflictDiff(sync, node.folderPath!, node.relativePath);
      }
    }),
    vscode.commands.registerCommand('overleafconnect.takeOverleaf', (node?: ConflictNode) => resolveConflict(node, 'theirs')),
    vscode.commands.registerCommand('overleafconnect.keepMine', (node?: ConflictNode) => resolveConflict(node, 'ours')),
    vscode.commands.registerCommand('overleafconnect.openMerged', async (node?: ConflictNode) => {
      if (node?.folderPath && node.relativePath) {
        try {
          await vscode.window.showTextDocument(vscode.Uri.file(path.join(node.folderPath, node.relativePath)), { preview: false });
        } catch {
          vscode.window.showWarningMessage(`Overleaf Connect: ${node.relativePath} was deleted on one side; take a version instead.`);
        }
      }
    }),
    vscode.commands.registerCommand('overleafconnect.markResolved', async (node?: ConflictNode) => {
      const sync = node?.folderPath && syncs.get(node.folderPath);
      if (sync && node?.relativePath) {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path.join(node.folderPath!, node.relativePath!));
        await doc?.save();
        await reportConflictStep(() => sync.markResolved(node.relativePath!));
      }
    }),
    vscode.commands.registerCommand('overleafconnect.abortMerge', async (node?: { folderPath?: string }) => {
      const sync = syncFor(node);
      if (!sync) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        'Abort the merge with Overleaf? Files go back to your last synced version; resolutions made so far are lost.',
        { modal: true },
        'Abort Merge'
      );
      if (choice === 'Abort Merge') {
        await reportConflictStep(() => sync.abortMerge());
      }
    }),
    vscode.commands.registerCommand('overleafconnect.showRemoteCommit', async (node?: { folderPath?: string; hash?: string }) => {
      const sync = node?.folderPath && syncs.get(node.folderPath);
      const update = sync && node?.hash ? await sync.commitUpdate(node.hash) : undefined;
      if (!sync || !update) {
        return;
      }
      if (!update.files.length) {
        vscode.window.showInformationMessage('Overleaf Connect: This commit changed no files.');
        return;
      }
      await showRemoteUpdate(sync, node!.folderPath!, update);
    }),
    vscode.commands.registerCommand('overleafconnect.openInOverleaf', async (node?: { folderPath?: string }) => {
      const folderPath = node?.folderPath ?? (await pickFolder())?.uri.fsPath;
      const projectUrl = folderPath ? await authManager.getProjectUrl(folderPath) : undefined;
      const url = projectUrl && projectWebUrl(projectUrl);
      if (!url) {
        vscode.window.showWarningMessage('Overleaf Connect: This folder is not connected to an Overleaf project.');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand('overleafconnect.uploadFolder', async () => {
      const folder = await pickFolder();
      if (folder) {
        await uploadFolder(folder, authManager, config, syncExcludes());
      }
    }),
    vscode.commands.registerCommand('overleafconnect.setSessionCookie', async () => {
      if (await authManager.promptForSessionCookie()) {
        vscode.window.showInformationMessage('Overleaf Connect: Session cookie saved. The project list, comments and compiling on Overleaf can use it now.');
      }
    }),
    vscode.commands.registerCommand('overleafconnect.compileOnOverleaf', async (node?: { folderPath?: string }) => {
      const folderPath = node?.folderPath ?? currentFolderPath() ?? (await pickFolder())?.uri.fsPath;
      if (folderPath) {
        await compileOnOverleaf(authManager, folderPath, syncs.get(folderPath), context.globalStorageUri);
      }
    }),
    vscode.commands.registerCommand('overleafconnect.showComments', async (node?: { folderPath?: string }) => {
      const folderPath = node?.folderPath ?? currentFolderPath() ?? (await pickFolder())?.uri.fsPath;
      if (folderPath) {
        await comments.show(authManager, folderPath);
      }
    }),
    vscode.commands.registerCommand('overleafconnect.refreshView', async () => {
      await Promise.all(syncs.entries().map(([, s]) => s.refreshSnapshot()));
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
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      const sync = folder && syncs.get(folder.uri.fsPath);
      if (sync && (doc.languageId === 'latex' || doc.fileName.endsWith('.bib'))) {
        outputChannel.appendLine('[Overleaf Connect] File saved, triggering sync...');
        await sync.syncNow();
      }
    })
  );

  // ---- Initialize Sync if already configured ----
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (await authManager.isAuthenticated(folder.uri.fsPath)) {
      await initializeSync(folder, authManager, config, syncExcludes());
    }
  }
  refreshViews();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
      e.removed.forEach((folder) => {
        syncs.remove(folder.uri.fsPath);
        comments.clear(folder.uri.fsPath);
      });
      for (const folder of e.added) {
        if (await authManager.isAuthenticated(folder.uri.fsPath)) {
          await initializeSync(folder, authManager, config, syncExcludes());
        }
      }
      refreshViews();
    })
  );

  // ---- React to config changes ----
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('overleafconnect')) {
        if (e.affectsConfiguration('overleafconnect.sync.intervalSeconds')) {
          syncs.stop();
          syncs.start();
        }
        outputChannel.appendLine('[Overleaf Connect] Configuration updated');
      }
    })
  );

  outputChannel.appendLine('[Overleaf Connect] Extension activated');
}

type ConflictNode = { folderPath?: string; relativePath?: string };

async function resolveConflict(node: ConflictNode | undefined, side: ConflictSide): Promise<void> {
  const sync = node?.folderPath && syncs.get(node.folderPath);
  if (sync && node?.relativePath) {
    await reportConflictStep(() => sync.resolveConflict(node.relativePath!, side));
  }
}

async function reportConflictStep(step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    vscode.window.showErrorMessage(`Overleaf Connect: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The only folder, or the one the user picks when the workspace has several. */
async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) {
    if (!folders.length) {
      vscode.window.showWarningMessage('Overleaf Connect: Open a folder first.');
    }
    return folders[0];
  }
  return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder to connect to an Overleaf project' });
}

async function initializeSync(
  folder: vscode.WorkspaceFolder,
  authManager: AuthManager,
  config: ReturnType<typeof getConfig>,
  excludePatterns: string[]
): Promise<void> {
  const workspacePath = folder.uri.fsPath;
  syncs.remove(workspacePath);

  const token = await authManager.getToken();
  const projectUrl = await authManager.getProjectUrl(workspacePath);
  if (!token || !projectUrl) {
    return;
  }

  const gitEngine = new GitEngine({
    workspacePath,
    remoteUrl: projectUrl,
    username: 'git',
    token,
  });

  if (!(await gitEngine.isGitRepo())) {
    getOutputChannel().appendLine(`[Overleaf Connect] ${folder.name} is not a git repository yet.`);
    gitEngine.dispose();
    const choice = await vscode.window.showInformationMessage(
      `Overleaf Connect: ${folder.name} is linked to an Overleaf project but is not a clone of it yet.`,
      'Upload This Folder'
    );
    if (choice === 'Upload This Folder') {
      await uploadFolder(folder, authManager, config, excludePatterns);
    }
    return;
  }

  if (await gitEngine.scrubRemoteCredentials().catch(() => false)) {
    getOutputChannel().appendLine(`[Overleaf Connect] Removed the token from ${folder.name}'s git remote URL.`);
  }

  await ensureGitignore(workspacePath, excludePatterns);

  const fileWatcher = new FileWatcher(workspacePath);
  const syncManager = new SyncManager(gitEngine, fileWatcher, config, projectUrl);
  syncManager.onDidChangeState(() => refreshViews());
  syncManager.onDidReceiveRemoteUpdate((update) => {
    // Read now, not at activation, so a change to the setting applies at once.
    void announceRemoteUpdate(syncManager, workspacePath, update, getConfig().notifications.remoteChanges);
  });
  syncManager.onDidChangeSnapshot((snapshot) => {
    decorations?.update(workspacePath, snapshot);
    tree?.refresh();
  });
  syncs.set(workspacePath, syncManager);
  void syncManager.refreshSnapshot();

  // A merge left waiting by a reload or crash: show it instead of syncing over it.
  await syncManager.detectConflict();

  if (config.sync.pullOnOpen) {
    await syncManager.syncNow();
  }

  if (config.sync.enabled) {
    syncManager.start();
  }
}

/**
 * Sends a folder that is not a clone yet to its Overleaf project: the folder's files are committed on top of
 * Overleaf's latest version and pushed, then the folder syncs like a clone.
 */
async function uploadFolder(
  folder: vscode.WorkspaceFolder,
  authManager: AuthManager,
  config: ReturnType<typeof getConfig>,
  excludePatterns: string[]
): Promise<void> {
  const workspacePath = folder.uri.fsPath;
  if (await simpleGit(workspacePath).checkIsRepo().catch(() => false)) {
    vscode.window.showWarningMessage(`Overleaf Connect: ${folder.name} is already a git repository; use "Connect This Folder" instead.`);
    return;
  }
  let token = await authManager.getToken();
  let projectUrl = await authManager.getProjectUrl(workspacePath);
  if (!token || !projectUrl) {
    const creds = await authManager.promptForCredentials(workspacePath);
    if (!creds) {
      return;
    }
    ({ token, projectUrl } = creds);
  }

  const engine = new GitEngine({ workspacePath, remoteUrl: projectUrl, username: 'git', token });
  let pushed = false;
  try {
    const overleafOnly = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Overleaf Connect: Reading the Overleaf project...' },
      async () => {
        const only = await engine.adoptRemote();
        await ensureGitignore(workspacePath, excludePatterns);
        return only;
      }
    );
    const status = await engine.statusAllFiles();
    const replaced = status.modified.length;
    const added = status.not_added.length + status.created.length;
    const parts = [`${added} new file${added === 1 ? '' : 's'}`, `${replaced} replaced`];
    const listed = overleafOnly.slice(0, 5).join(', ') + (overleafOnly.length > 5 ? `, and ${overleafOnly.length - 5} more` : '');
    const detail = overleafOnly.length
      ? `${overleafOnly.length} file${overleafOnly.length === 1 ? ' is' : 's are'} only on Overleaf: ${listed}.`
      : 'Files with the same name are replaced by yours.';
    const KEEP = 'Upload and Keep Them';
    const DELETE = 'Upload and Delete Them';
    const UPLOAD = 'Upload';
    const choice = await vscode.window.showWarningMessage(
      `Upload ${folder.name} to the Overleaf project? ${parts.join(', ')}.`,
      { modal: true, detail },
      ...(overleafOnly.length ? [KEEP, DELETE] : [UPLOAD])
    );
    if (!choice) {
      engine.undoAdopt();
      return;
    }
    if (choice === KEEP) {
      await engine.restoreFiles(overleafOnly);
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Overleaf Connect: Uploading to Overleaf...' },
      async () => {
        await engine.addAll();
        if (await engine.hasUncommittedChanges()) {
          await engine.commit('Upload local folder from VS Code');
        }
        await engine.pushUpstream();
      }
    );
    pushed = true;
  } catch (error) {
    // Nothing reached Overleaf, so the folder goes back to how it was.
    if (!pushed) {
      engine.undoAdopt();
    }
    const msg = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Overleaf Connect: Upload failed - ${msg}`);
    return;
  } finally {
    engine.dispose();
  }
  writeMarker(workspacePath, projectUrl);
  vscode.window.showInformationMessage(`Overleaf Connect: ${folder.name} is on Overleaf and now syncs with it.`);
  await initializeSync(folder, authManager, config, excludePatterns);
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
  syncs.stop();
}
