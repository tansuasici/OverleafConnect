import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AuthManager } from '../auth/authManager';
import { projectIdFromUrl, webOrigin } from '../auth/projectUrl';
import { OverleafWebClient, WebError } from '../web/overleafWeb';
import { describeCompileStatus, locateQuote, WebProject } from '../web/webModel';
import { SyncManager } from '../sync/syncManager';
import { SyncState } from '../types';
import { getOutputChannel } from './outputChannel';

/** A client for the server behind `gitOrServerUrl`, asking for the session cookie when none is stored yet. */
export async function webClient(authManager: AuthManager, gitOrServerUrl: string, ask = true): Promise<OverleafWebClient | undefined> {
  const origin = webOrigin(gitOrServerUrl);
  if (!origin) {
    return undefined;
  }
  const cookie = (await authManager.getSessionCookie()) ?? (ask ? await authManager.promptForSessionCookie() : undefined);
  return cookie ? new OverleafWebClient(origin, cookie) : undefined;
}

/** Reports a failed web request; a refused cookie is forgotten so the next try asks for a new one. */
export async function reportWebError(authManager: AuthManager, what: string, error: unknown): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  getOutputChannel().appendLine(`[Overleaf Connect] ${what} failed: ${msg}`);
  if (error instanceof WebError && error.signedOut) {
    await authManager.deleteSessionCookie();
    const choice = await vscode.window.showErrorMessage(`Overleaf Connect: ${what} failed. ${msg}`, 'Set Session Cookie');
    if (choice === 'Set Session Cookie') {
      await authManager.promptForSessionCookie();
    }
    return;
  }
  vscode.window.showErrorMessage(`Overleaf Connect: ${what} failed - ${msg}`);
}

const ENTER_MANUALLY = 'enter';

/**
 * The project to clone, picked from the user's Overleaf projects when a session cookie is stored. Returns its id,
 * `null` to fall back to typing an id or URL, or undefined when the user cancelled.
 */
export async function pickProjectToClone(authManager: AuthManager, serverUrl: string): Promise<string | null | undefined> {
  const client = await webClient(authManager, serverUrl, false);
  if (!client) {
    return null;
  }
  let projects: WebProject[];
  try {
    projects = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Overleaf Connect: Loading your Overleaf projects...' },
      () => client.listProjects()
    );
  } catch (error) {
    await reportWebError(authManager, 'Loading the project list', error);
    return null;
  }
  type Item = vscode.QuickPickItem & { id: string };
  const items: Item[] = projects.map((p) => ({
    label: p.name,
    description: p.inactive ? 'archived' : p.lastUpdated?.toLocaleDateString(),
    detail: p.id,
    id: p.id,
  }));
  items.push({ label: '$(edit) Enter a project ID or URL...', id: ENTER_MANUALLY, alwaysShow: true });
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Overleaf Connect: Clone Overleaf Project',
    placeHolder: projects.length ? 'Project to clone' : 'No projects found; enter an ID or URL',
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!picked) {
    return undefined;
  }
  return picked.id === ENTER_MANUALLY ? null : picked.id;
}

/**
 * Compiles the project on Overleaf and opens the PDF. Syncs first, since Overleaf compiles its own copy; the PDF
 * goes to the extension's storage, not the folder, so it is never pushed back.
 */
export async function compileOnOverleaf(
  authManager: AuthManager,
  folderPath: string,
  sync: SyncManager | undefined,
  storage: vscode.Uri
): Promise<void> {
  const projectUrl = await authManager.getProjectUrl(folderPath);
  const projectId = projectUrl && projectIdFromUrl(projectUrl);
  if (!projectUrl || !projectId) {
    vscode.window.showWarningMessage('Overleaf Connect: This folder is not connected to an Overleaf project.');
    return;
  }
  const client = await webClient(authManager, projectUrl);
  if (!client) {
    return;
  }
  if (sync && !sync.paused) {
    await sync.syncNow();
  }
  if (!sync || sync.paused || sync.getState() === SyncState.Conflict || sync.getState() === SyncState.Error) {
    const go = await vscode.window.showWarningMessage(
      'Overleaf Connect: Your latest changes may not be on Overleaf yet; Overleaf compiles its own copy of the project.',
      'Compile Anyway'
    );
    if (go !== 'Compile Anyway') {
      return;
    }
  }
  const outDir = path.join(storage.fsPath, 'compiles', projectId);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Overleaf Connect: Compiling on Overleaf...' },
      async () => {
        const result = await client.compile(projectId);
        fs.mkdirSync(outDir, { recursive: true });
        const logFile = path.join(outDir, 'output.log');
        let hasLog = false;
        if (result.logUrl) {
          try {
            fs.writeFileSync(logFile, await client.download(result.logUrl));
            hasLog = true;
          } catch {
            // The PDF still opens without its log.
          }
        }
        if (result.status !== 'success' || !result.pdfUrl) {
          const choice = await vscode.window.showErrorMessage(
            `Overleaf Connect: ${result.status === 'success' ? 'Overleaf produced no PDF.' : describeCompileStatus(result.status)}`,
            ...(hasLog ? ['Show Log'] : [])
          );
          if (choice === 'Show Log') {
            await vscode.window.showTextDocument(vscode.Uri.file(logFile), { preview: true });
          }
          return;
        }
        const pdfFile = path.join(outDir, `${path.basename(folderPath)}.pdf`);
        fs.writeFileSync(pdfFile, await client.download(result.pdfUrl));
        getOutputChannel().appendLine(`[Overleaf Connect] Compiled on Overleaf: ${pdfFile}`);
        await vscode.env.openExternal(vscode.Uri.file(pdfFile));
      }
    );
  } catch (error) {
    await reportWebError(authManager, 'Compiling on Overleaf', error);
  }
}

/** Overleaf's open comment threads, shown read-only on the lines they are about. */
export class OverleafComments implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('overleafconnect.comments', 'Overleaf Comments');
  private readonly threads = new Map<string, vscode.CommentThread[]>();

  constructor() {
    this.controller.options = { prompt: 'Reply on Overleaf', placeHolder: 'Replying is done on Overleaf' };
  }

  async show(authManager: AuthManager, folderPath: string): Promise<void> {
    const projectUrl = await authManager.getProjectUrl(folderPath);
    const projectId = projectUrl && projectIdFromUrl(projectUrl);
    if (!projectUrl || !projectId) {
      vscode.window.showWarningMessage('Overleaf Connect: This folder is not connected to an Overleaf project.');
      return;
    }
    const client = await webClient(authManager, projectUrl);
    if (!client) {
      return;
    }
    try {
      const [threads, anchors] = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Overleaf Connect: Loading Overleaf comments...' },
        () => Promise.all([client.threads(projectId), client.commentAnchors(projectId)])
      );
      const files = await readTextFiles(folderPath);
      this.clear(folderPath);
      const shown: vscode.CommentThread[] = [];
      let resolved = 0;
      let unplaced = 0;
      for (const anchor of anchors) {
        const thread = threads.get(anchor.threadId);
        if (!thread || !thread.messages.length) {
          continue;
        }
        if (thread.resolved) {
          resolved++;
          continue;
        }
        const place = placeQuote(files, anchor.quote, anchor.offset);
        if (!place) {
          unplaced++;
          continue;
        }
        const t = this.controller.createCommentThread(
          vscode.Uri.file(place.file),
          new vscode.Range(place.start, place.end),
          thread.messages.map((m) => ({
            body: m.content,
            mode: vscode.CommentMode.Preview,
            author: { name: m.author },
          }))
        );
        t.canReply = false;
        t.label = 'Overleaf';
        t.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        shown.push(t);
      }
      this.threads.set(folderPath, shown);
      const notes = [
        resolved ? `${resolved} resolved not shown` : '',
        unplaced ? `${unplaced} on text no longer in your copy` : '',
      ].filter(Boolean);
      vscode.window.showInformationMessage(
        `Overleaf Connect: ${shown.length} open comment thread${shown.length === 1 ? '' : 's'} from Overleaf${notes.length ? ` (${notes.join(', ')})` : ''}.`
      );
    } catch (error) {
      await reportWebError(authManager, 'Loading comments', error);
    }
  }

  clear(folderPath: string): void {
    this.threads.get(folderPath)?.forEach((t) => t.dispose());
    this.threads.delete(folderPath);
  }

  dispose(): void {
    [...this.threads.keys()].forEach((f) => this.clear(f));
    this.controller.dispose();
  }
}

const COMMENTABLE = '**/*.{tex,bib,sty,cls,bst,md,txt,Rtex,Rnw}';

async function readTextFiles(folderPath: string): Promise<{ file: string; text: string }[]> {
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folderPath, COMMENTABLE), '**/{.git,node_modules}/**', 2000);
  const out: { file: string; text: string }[] = [];
  for (const uri of uris) {
    try {
      out.push({ file: uri.fsPath, text: fs.readFileSync(uri.fsPath, 'utf8') });
    } catch {
      // Unreadable files cannot hold a comment.
    }
  }
  return out;
}

/** The file and range of a comment's quote: an exact hit at Overleaf's offset first, else the nearest one in any file. */
function placeQuote(files: { file: string; text: string }[], quote: string, offset: number) {
  let best: { file: string; text: string; at: number } | undefined;
  for (const f of files) {
    const at = locateQuote(f.text, quote, offset);
    if (at === undefined) {
      continue;
    }
    if (at === offset) {
      best = { ...f, at };
      break;
    }
    if (!best || Math.abs(at - offset) < Math.abs(best.at - offset)) {
      best = { ...f, at };
    }
  }
  return best && { file: best.file, start: positionAt(best.text, best.at), end: positionAt(best.text, best.at + quote.length) };
}

function positionAt(text: string, offset: number): vscode.Position {
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  return new vscode.Position(line, offset - (before.lastIndexOf('\n') + 1));
}
