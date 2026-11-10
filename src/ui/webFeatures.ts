import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AuthManager } from '../auth/authManager';
import { projectIdFromUrl, webOrigin } from '../auth/projectUrl';
import { CommentPlacementError, OverleafWebClient, WebError } from '../web/overleafWeb';
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
  const cookie = (await authManager.getSessionCookie()) ?? (ask ? await authManager.promptForSessionCookie(gitOrServerUrl) : undefined);
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
    description: p.inactive ? 'archived' : p.accessLevel && p.accessLevel !== 'owner' ? 'shared with you' : p.lastUpdated?.toLocaleDateString(),
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

/** Where a VS Code comment thread lives on Overleaf. */
interface ThreadRef {
  folderPath: string;
  projectId: string;
  threadId: string;
  docId?: string;
}

/** One Overleaf message in a VS Code thread; its own contextValue lets the user edit and delete only their own. */
class OverleafMessage implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  readonly contextValue: 'own' | 'other';
  private saved: string;

  constructor(
    public body: string | vscode.MarkdownString,
    readonly author: vscode.CommentAuthorInformation,
    readonly timestamp: Date | undefined,
    readonly messageId: string | undefined,
    own: boolean,
    public parent?: vscode.CommentThread
  ) {
    this.saved = typeof body === 'string' ? body : body.value;
    this.contextValue = own && messageId ? 'own' : 'other';
  }

  get text(): string {
    return typeof this.body === 'string' ? this.body : this.body.value;
  }

  revert(): void {
    this.body = this.saved;
    this.mode = vscode.CommentMode.Preview;
  }
}

/**
 * Overleaf's comment threads on the lines they are about. Replies, edits and deletions of the user's own messages,
 * resolving, reopening and deleting threads go to Overleaf, then the folder's threads are fetched again, so what VS
 * Code shows is what Overleaf accepted. A new comment goes on the selected text (or the line) in a connected folder.
 */
export class OverleafComments implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('overleafconnect.comments', 'Overleaf Comments');
  private readonly threads = new Map<string, vscode.CommentThread[]>();
  private readonly refs = new WeakMap<vscode.CommentThread, ThreadRef>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Workspace folders known to be connected to an Overleaf project. */
  private readonly connected = new Map<string, Promise<boolean>>();

  constructor(private readonly authManager: AuthManager) {
    this.controller.options = { prompt: 'Comment on Overleaf', placeHolder: 'Comment on Overleaf' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: async (doc) =>
        doc.uri.scheme === 'file' && (await this.folderFor(doc.uri)) ? [new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)] : [],
    };
    const command = <A extends unknown[]>(id: string, run: (...args: A) => Promise<void> | void) =>
      this.disposables.push(vscode.commands.registerCommand(`overleafconnect.comments.${id}`, run));
    command('reply', (reply: vscode.CommentReply) => this.reply(reply));
    command('create', (reply: vscode.CommentReply) => this.create(reply));
    command('resolve', (thread: vscode.CommentThread) => this.threadAction(thread, 'Resolving the comment', (c, r) => c.resolveThread(r.projectId, r.docId!, r.threadId)));
    command('reopen', (thread: vscode.CommentThread) => this.threadAction(thread, 'Reopening the comment', (c, r) => c.reopenThread(r.projectId, r.docId!, r.threadId)));
    command('deleteThread', (thread: vscode.CommentThread) => this.deleteThread(thread));
    command('edit', (message: OverleafMessage) => this.setMode(message, vscode.CommentMode.Editing));
    command('cancelEdit', (message: OverleafMessage) => {
      message.revert();
      this.redraw(message.parent);
    });
    command('saveEdit', (message: OverleafMessage) => this.saveEdit(message));
    command('deleteMessage', (message: OverleafMessage) => this.deleteMessage(message));
  }

  async show(authManager: AuthManager, folderPath: string, quiet = false): Promise<void> {
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
      const load = () => Promise.all([client.threads(projectId), client.commentAnchors(projectId), client.userId(projectId).catch(() => undefined)]);
      const [threads, anchors, userId] = quiet
        ? await load()
        : await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Overleaf Connect: Loading Overleaf comments...' }, load);
      const files = await readTextFiles(folderPath);
      this.clear(folderPath);
      const shown: vscode.CommentThread[] = [];
      let open = 0;
      let unplaced = 0;
      for (const anchor of anchors) {
        const thread = threads.get(anchor.threadId);
        if (!thread || !thread.messages.length) {
          continue;
        }
        const place = placeQuote(files, anchor.quote, anchor.offset);
        if (!place) {
          unplaced++;
          continue;
        }
        const t = this.controller.createCommentThread(vscode.Uri.file(place.file), new vscode.Range(place.start, place.end), []);
        t.comments = thread.messages.map(
          (m) => new OverleafMessage(m.content, { name: m.author }, m.timestamp, m.id, !!userId && m.userId === userId, t)
        );
        t.label = thread.resolved ? 'Overleaf · resolved' : 'Overleaf';
        t.canReply = !thread.resolved;
        t.state = thread.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
        t.contextValue = `overleaf.${thread.resolved ? 'resolved' : 'open'}${anchor.docId ? '.doc' : ''}`;
        t.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        this.refs.set(t, { folderPath, projectId, threadId: anchor.threadId, docId: anchor.docId });
        shown.push(t);
        open += thread.resolved ? 0 : 1;
      }
      this.threads.set(folderPath, shown);
      if (!quiet) {
        const resolved = shown.length - open;
        const notes = [resolved ? `${resolved} resolved` : '', unplaced ? `${unplaced} on text no longer in your copy` : ''].filter(Boolean);
        vscode.window.showInformationMessage(
          `Overleaf Connect: ${open} open comment thread${open === 1 ? '' : 's'} from Overleaf${notes.length ? ` (${notes.join(', ')})` : ''}.`
        );
      }
    } catch (error) {
      await reportWebError(authManager, 'Loading comments', error);
    }
  }

  /** Runs one change on Overleaf for the thread, then shows the folder's threads as Overleaf now has them. */
  private async run(ref: ThreadRef | undefined, what: string, change: (client: OverleafWebClient, ref: ThreadRef) => Promise<void>): Promise<boolean> {
    if (!ref) {
      return false;
    }
    const projectUrl = await this.authManager.getProjectUrl(ref.folderPath);
    const client = projectUrl && (await webClient(this.authManager, projectUrl));
    if (!client) {
      return false;
    }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Overleaf: ${what}...` }, () => change(client, ref));
    } catch (error) {
      await reportWebError(this.authManager, what, error);
      return false;
    }
    await this.show(this.authManager, ref.folderPath, true);
    return true;
  }

  private async reply(reply: vscode.CommentReply): Promise<void> {
    const text = reply.text.trim();
    if (text) {
      await this.run(this.refs.get(reply.thread), 'Replying', (c, r) => c.reply(r.projectId, r.threadId, text));
    }
  }

  /** The connected workspace folder `uri` is in, if any. */
  private async folderFor(uri: vscode.Uri): Promise<string | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    if (!folder) {
      return undefined;
    }
    let known = this.connected.get(folder);
    if (!known) {
      known = this.authManager.getProjectUrl(folder).then((u) => !!u && !!projectIdFromUrl(u), () => false);
      this.connected.set(folder, known);
    }
    if (await known) {
      return folder;
    }
    this.connected.delete(folder); // Ask again next time: the folder may get connected later.
    return undefined;
  }

  /** Starts a thread on Overleaf on the new thread's text: the selection, or its line without surrounding spaces. */
  private async create(reply: vscode.CommentReply): Promise<void> {
    const thread = reply.thread;
    const content = reply.text.trim();
    const folderPath = await this.folderFor(thread.uri);
    if (!content || !folderPath) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(thread.uri);
    let range = thread.range ?? doc.lineAt(0).range;
    if (range.isEmpty) {
      range = doc.lineAt(range.start.line).range;
    }
    const raw = doc.getText(range);
    const start = doc.offsetAt(range.start) + (raw.length - raw.trimStart().length);
    const end = Math.max(start, doc.offsetAt(range.end) - (raw.length - raw.trimEnd().length));
    const quote = doc.getText(new vscode.Range(doc.positionAt(start), doc.positionAt(end))).replace(/\r/g, '');
    if (!quote) {
      vscode.window.showWarningMessage('Overleaf Connect: Select the text to comment on; this line is empty.');
      return;
    }
    const near = doc.getText(new vscode.Range(new vscode.Position(0, 0), doc.positionAt(start))).replace(/\r/g, '').length;
    const relPath = path.relative(folderPath, thread.uri.fsPath).split(path.sep).join('/');
    const projectUrl = await this.authManager.getProjectUrl(folderPath);
    const projectId = projectUrl && projectIdFromUrl(projectUrl);
    const client = projectUrl && projectId && (await webClient(this.authManager, projectUrl));
    if (!client || !projectId) {
      return;
    }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Overleaf: Adding the comment...' }, () =>
        client.addComment(projectId, relPath, quote, near, content)
      );
    } catch (error) {
      if (error instanceof CommentPlacementError) {
        const choice = await vscode.window.showWarningMessage(`Overleaf Connect: ${error.message}`, 'Sync Now');
        if (choice === 'Sync Now') {
          await vscode.commands.executeCommand('overleafconnect.syncNow');
        }
      } else {
        await reportWebError(this.authManager, 'Adding the comment', error);
      }
      return;
    }
    thread.dispose();
    await this.show(this.authManager, folderPath, true);
  }

  private async threadAction(thread: vscode.CommentThread, what: string, change: (client: OverleafWebClient, ref: ThreadRef) => Promise<void>): Promise<void> {
    const ref = this.refs.get(thread);
    if (ref && !ref.docId) {
      vscode.window.showWarningMessage('Overleaf Connect: Overleaf did not say which document this comment is in; change it on Overleaf.');
      return;
    }
    await this.run(ref, what, change);
  }

  private async deleteThread(thread: vscode.CommentThread): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      'Delete this comment and all its replies on Overleaf? This cannot be undone.',
      { modal: true },
      'Delete'
    );
    if (choice === 'Delete') {
      await this.threadAction(thread, 'Deleting the comment', (c, r) => c.deleteThread(r.projectId, r.docId!, r.threadId));
    }
  }

  private async saveEdit(message: OverleafMessage): Promise<void> {
    const text = message.text.trim();
    const ref = message.parent && this.refs.get(message.parent);
    if (!text || !message.messageId) {
      message.revert();
      this.redraw(message.parent);
      return;
    }
    if (!(await this.run(ref, 'Editing the message', (c, r) => c.editMessage(r.projectId, r.threadId, message.messageId!, text)))) {
      message.revert();
      this.redraw(message.parent);
    }
  }

  private async deleteMessage(message: OverleafMessage): Promise<void> {
    if (!message.messageId) {
      return;
    }
    const choice = await vscode.window.showWarningMessage('Delete this message on Overleaf? This cannot be undone.', { modal: true }, 'Delete');
    if (choice === 'Delete') {
      await this.run(message.parent && this.refs.get(message.parent), 'Deleting the message', (c, r) =>
        c.deleteMessage(r.projectId, r.threadId, message.messageId!)
      );
    }
  }

  private setMode(message: OverleafMessage, mode: vscode.CommentMode): void {
    message.mode = mode;
    this.redraw(message.parent);
  }

  /** VS Code redraws a thread's comments only when the array is replaced. */
  private redraw(thread: vscode.CommentThread | undefined): void {
    if (thread) {
      thread.comments = [...thread.comments];
    }
  }

  clear(folderPath: string): void {
    this.threads.get(folderPath)?.forEach((t) => t.dispose());
    this.threads.delete(folderPath);
  }

  dispose(): void {
    [...this.threads.keys()].forEach((f) => this.clear(f));
    this.disposables.forEach((d) => d.dispose());
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
