// Overleaf's web pages, as observed from the browser: these endpoints are undocumented, so every path lives here and
// nothing else in the extension builds one. No vscode import, so it is tested with plain mocha.

/** Every web endpoint used, in one place, so a wrong guess is fixed here. */
export const WEB_ENDPOINTS = {
  /** The project page; its HTML carries the CSRF token POSTs need. */
  projectPage: (projectId: string) => `/project/${projectId}`,
  /** The signed-in user's projects as JSON. */
  projectList: () => '/user/projects',
  compile: (projectId: string) => `/project/${projectId}/compile?auto_compile=false`,
  /** Comment threads with their messages, keyed by thread id. */
  threads: (projectId: string) => `/project/${projectId}/threads`,
  /** Where each comment sits in its document, per document. */
  ranges: (projectId: string) => `/project/${projectId}/ranges`,
  /** POST {content}: a reply on a thread. */
  threadMessages: (projectId: string, threadId: string) => `/project/${projectId}/thread/${threadId}/messages`,
  /** POST {content}: new text for one of the user's own messages. */
  editMessage: (projectId: string, threadId: string, messageId: string) =>
    `/project/${projectId}/thread/${threadId}/messages/${messageId}/edit`,
  /** DELETE: one of the user's own messages. */
  message: (projectId: string, threadId: string, messageId: string) => `/project/${projectId}/thread/${threadId}/messages/${messageId}`,
  /** POST: mark a thread resolved. */
  resolveThread: (projectId: string, docId: string, threadId: string) => `/project/${projectId}/doc/${docId}/thread/${threadId}/resolve`,
  /** POST: reopen a resolved thread. */
  reopenThread: (projectId: string, docId: string, threadId: string) => `/project/${projectId}/doc/${docId}/thread/${threadId}/reopen`,
  /** DELETE: a whole thread and its highlight in the document. */
  thread: (projectId: string, docId: string, threadId: string) => `/project/${projectId}/doc/${docId}/thread/${threadId}`,
};

/** Header that carries the CSRF token on a POST. */
export const CSRF_HEADER = 'X-Csrf-Token';

/**
 * The pasted session cookie as a Cookie header value: "name=value", with any "Cookie:" prefix dropped.
 * The whole pair is kept because the cookie's name differs between overleaf.com and self-hosted servers; a bare
 * value is taken as `defaultName`'s when one is known (see sessionCookieName).
 */
export function normalizeCookie(input: string, defaultName?: string): string | undefined {
  const value = input.trim().replace(/^cookie:\s*/i, '').trim();
  if (defaultName && /^[^=;\s]+$/.test(value)) {
    return `${defaultName}=${value}`;
  }
  return /^[^=;\s]+=[^;\s]+(;\s*[^=;\s]+=[^;\s]*)*;?$/.test(value) ? value.replace(/;$/, '') : undefined;
}

/** The session cookie's name on a server whose web origin is `origin`, when it is known (overleaf.com only). */
export function sessionCookieName(origin: string | undefined): string | undefined {
  try {
    return origin && new URL(origin).hostname.toLowerCase() === 'www.overleaf.com' ? 'overleaf_session2' : undefined;
  } catch {
    return undefined;
  }
}

/** The token in the project page's `<meta name="ol-csrfToken" content="...">`. */
export function parseCsrf(html: string): string | undefined {
  const tag = html.match(/<meta\b[^>]*\bname=["']ol-csrfToken["'][^>]*>/i)?.[0];
  return tag?.match(/\bcontent=["']([^"']+)["']/i)?.[1];
}

/** The signed-in user's id in the project page's `<meta name="ol-user_id" content="...">`. */
export function parseUserId(html: string): string | undefined {
  const tag = html.match(/<meta\b[^>]*\bname=["']ol-user_id["'][^>]*>/i)?.[0];
  return tag?.match(/\bcontent=["']([^"']+)["']/i)?.[1];
}

/** Ids go into request paths, so only Overleaf's hex ids are let through. */
export function isWebId(id: string | undefined): id is string {
  return !!id && /^[a-f0-9]{10,}$/i.test(id);
}

export interface WebProject {
  id: string;
  name: string;
  /** Archived or trashed: still listed, after the others. */
  inactive: boolean;
  lastUpdated?: Date;
  /** "owner", "readWrite", "readOnly", ... as the list reports it; overleaf.com sends this but no dates. */
  accessLevel?: string;
}

/** Projects from the list endpoint, newest first, archived and trashed ones last. Tolerates a bare array. */
export function parseProjects(json: unknown): WebProject[] {
  const raw = Array.isArray(json) ? json : (json as { projects?: unknown })?.projects;
  if (!Array.isArray(raw)) {
    return [];
  }
  const projects: WebProject[] = [];
  for (const p of raw) {
    const id = typeof p?._id === 'string' ? p._id : typeof p?.id === 'string' ? p.id : undefined;
    if (!id || !/^[a-f0-9]{10,}$/i.test(id)) {
      continue;
    }
    const updated = p.lastUpdated ? new Date(p.lastUpdated) : undefined;
    projects.push({
      id,
      name: typeof p.name === 'string' && p.name ? p.name : id,
      inactive: !!(p.archived || p.trashed),
      lastUpdated: updated && !isNaN(updated.getTime()) ? updated : undefined,
      accessLevel: typeof p.accessLevel === 'string' ? p.accessLevel : undefined,
    });
  }
  return projects.sort(
    (a, b) => Number(a.inactive) - Number(b.inactive) || (b.lastUpdated?.getTime() ?? 0) - (a.lastUpdated?.getTime() ?? 0)
  );
}

export interface CompileOutput {
  /** "success", "failure", "timedout", "too-recently-compiled", ... as Overleaf reports it. */
  status: string;
  pdfUrl?: string;
  logUrl?: string;
}

/**
 * Where to download the PDF and the log from, as absolute URLs on `origin`. A separate download host Overleaf may name is
 * ignored: the session cookie goes only to the server the user signed in to.
 */
export function parseCompile(json: unknown, origin: string): CompileOutput {
  const r = (json ?? {}) as {
    status?: unknown;
    outputFiles?: { path?: unknown; url?: unknown }[];
    clsiServerId?: unknown;
  };
  const status = typeof r.status === 'string' ? r.status : 'unknown';
  const files = Array.isArray(r.outputFiles) ? r.outputFiles : [];
  const server = typeof r.clsiServerId === 'string' ? r.clsiServerId : undefined;
  const urlOf = (name: string): string | undefined => {
    const file = files.find((f) => f?.path === name && typeof f.url === 'string');
    if (!file) {
      return undefined;
    }
    const u = new URL(String(file.url), origin);
    if (u.origin !== new URL(origin).origin) {
      return undefined;
    }
    if (server && !u.searchParams.has('clsiserverid')) {
      u.searchParams.set('clsiserverid', server);
    }
    return u.toString();
  };
  return { status, pdfUrl: urlOf('output.pdf'), logUrl: urlOf('output.log') };
}

/** What a failed compile status means to the user. */
export function describeCompileStatus(status: string): string {
  switch (status) {
    case 'failure':
      return 'LaTeX reported errors and no PDF was produced.';
    case 'timedout':
      return 'The compile ran out of time on Overleaf.';
    case 'too-recently-compiled':
      return 'Overleaf compiled this project moments ago; try again in a few seconds.';
    case 'autocompile-backoff':
    case 'project-too-large':
    case 'terminated':
      return `Overleaf did not compile the project (${status}).`;
    default:
      return `Overleaf answered "${status}".`;
  }
}

export interface WebMessage {
  id?: string;
  /** Who wrote it, to tell the user's own messages (which they may edit and delete) from others'. */
  userId?: string;
  author: string;
  content: string;
  timestamp?: Date;
}

export interface WebThread {
  id: string;
  resolved: boolean;
  messages: WebMessage[];
}

/** Threads keyed by id, each with its messages oldest first. */
export function parseThreads(json: unknown): Map<string, WebThread> {
  const out = new Map<string, WebThread>();
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return out;
  }
  for (const [id, t] of Object.entries(json as Record<string, unknown>)) {
    const thread = t as { resolved?: unknown; messages?: unknown };
    const messages = (Array.isArray(thread?.messages) ? thread.messages : [])
      .map((m: { id?: unknown; _id?: unknown; user_id?: unknown; content?: unknown; timestamp?: unknown; user?: { id?: unknown; _id?: unknown; first_name?: unknown; last_name?: unknown } }) => ({
        id: firstString(m?.id, m?._id),
        userId: firstString(m?.user_id, m?.user?.id, m?.user?._id),
        author: authorName(m?.user),
        content: typeof m?.content === 'string' ? m.content : '',
        timestamp: typeof m?.timestamp === 'number' ? new Date(m.timestamp) : undefined,
      }))
      .filter((m) => m.content);
    out.set(id, { id, resolved: !!thread?.resolved, messages: messages.sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0)) });
  }
  return out;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === 'string' && !!v);
}

function authorName(user: { first_name?: unknown; last_name?: unknown } | undefined): string {
  const parts = [user?.first_name, user?.last_name].filter((p): p is string => typeof p === 'string' && !!p);
  return parts.join(' ') || 'Overleaf user';
}

export interface WebCommentAnchor {
  threadId: string;
  /** The Overleaf document it is in, which resolving, reopening and deleting the thread name. */
  docId?: string;
  /** The commented text. */
  quote: string;
  /** Its character offset in Overleaf's copy of the document. */
  offset: number;
}

/** Every comment's anchor across the project's documents. Documents are not named here, so the quote locates the file. */
export function parseRanges(json: unknown): WebCommentAnchor[] {
  const docs = Array.isArray(json) ? json : [];
  const out: WebCommentAnchor[] = [];
  for (const doc of docs) {
    const comments = doc?.ranges?.comments;
    for (const c of Array.isArray(comments) ? comments : []) {
      const op = c?.op;
      const threadId = typeof op?.t === 'string' ? op.t : typeof c?.id === 'string' ? c.id : undefined;
      if (threadId && typeof op?.c === 'string' && op.c && typeof op?.p === 'number') {
        out.push({ threadId, docId: typeof doc?.id === 'string' ? doc.id : undefined, quote: op.c, offset: op.p });
      }
    }
  }
  return out;
}

/**
 * Where the quote sits in the local copy: at the offset Overleaf gave if it is still there, else the occurrence
 * nearest to it, since local edits shift text. Undefined when the quote is gone.
 */
export function locateQuote(text: string, quote: string, offset: number): number | undefined {
  if (text.startsWith(quote, offset)) {
    return offset;
  }
  let best: number | undefined;
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) {
    if (best === undefined || Math.abs(i - offset) < Math.abs(best - offset)) {
      best = i;
    }
  }
  return best;
}

// ---- Overleaf's real-time service (socket.io 0.9), used only to add a comment: a comment's highlight is an edit to
// the document, which Overleaf accepts over this connection and over no HTTP route.

/** The handshake that opens a real-time session for one project. */
export const REALTIME_ENDPOINTS = {
  handshake: (projectId: string, now: number) => `/socket.io/1/?t=${now}&projectId=${projectId}`,
  websocket: (sessionId: string, projectId: string) => `/socket.io/1/websocket/${sessionId}?projectId=${projectId}`,
};

/** The session id from a handshake answer "sid:heartbeat:close:transports", when websocket is offered. */
export function parseHandshake(body: string): string | undefined {
  const [sid, , , transports] = body.trim().split(':');
  return sid && /^[\w-]+$/.test(sid) && (transports ?? '').split(',').includes('websocket') ? sid : undefined;
}

/** One socket.io 0.9 frame, as far as this extension reads them. */
export type RealtimeFrame =
  | { kind: 'connect' }
  | { kind: 'disconnect' }
  | { kind: 'heartbeat' }
  | { kind: 'event'; name: string; args: unknown[] }
  | { kind: 'ack'; id: number; args: unknown[] }
  | { kind: 'error'; reason: string }
  | { kind: 'other' };

export function parseFrame(frame: string): RealtimeFrame {
  const m = frame.match(/^(\d):([^:]*):([^:]*):?([\s\S]*)$/);
  if (!m) {
    return { kind: 'other' };
  }
  const [, type, , , data] = m;
  try {
    switch (type) {
      case '0':
        return { kind: 'disconnect' };
      case '1':
        return { kind: 'connect' };
      case '2':
        return { kind: 'heartbeat' };
      case '5': {
        const e = JSON.parse(data) as { name?: unknown; args?: unknown };
        return typeof e?.name === 'string' ? { kind: 'event', name: e.name, args: Array.isArray(e.args) ? e.args : [] } : { kind: 'other' };
      }
      case '6': {
        const a = data.match(/^(\d+)\+?([\s\S]*)$/);
        if (!a) {
          return { kind: 'other' };
        }
        const args = a[2] ? JSON.parse(a[2]) : [];
        return { kind: 'ack', id: Number(a[1]), args: Array.isArray(args) ? args : [] };
      }
      case '7':
        return { kind: 'error', reason: data };
      default:
        return { kind: 'other' };
    }
  } catch {
    return { kind: 'other' };
  }
}

/** An event that asks for an acknowledgement with data, numbered `id`. */
export function eventFrame(id: number, name: string, args: unknown[]): string {
  return `5:${id}+::${JSON.stringify({ name, args })}`;
}

export const HEARTBEAT_FRAME = '2::';
export const DISCONNECT_FRAME = '0::';

/** A document line from joinDoc, which Overleaf sends as UTF-8 bytes in a binary string. */
export function decodeDocLine(line: string): string {
  return Buffer.from(line, 'latin1').toString('utf8');
}

/** The id of the editable document at `relPath` ("chapters/intro.tex") in joinProject's project tree. */
export function findDocId(project: unknown, relPath: string): string | undefined {
  type Folder = { name?: unknown; docs?: { _id?: unknown; name?: unknown }[]; folders?: Folder[] };
  const roots = (project as { rootFolder?: unknown })?.rootFolder;
  let folder: Folder | undefined = Array.isArray(roots) ? roots[0] : undefined;
  const parts = relPath.split('/').filter(Boolean);
  const name = parts.pop();
  for (const part of parts) {
    folder = Array.isArray(folder?.folders) ? folder.folders.find((f) => f?.name === part) : undefined;
  }
  const doc = Array.isArray(folder?.docs) ? folder.docs.find((d) => d?.name === name) : undefined;
  return typeof doc?._id === 'string' && isWebId(doc._id) ? doc._id : undefined;
}

/** A new thread id in Overleaf's form: a 24-hex ObjectId that starts with the time in seconds. */
export function newThreadId(now = Date.now(), random: () => number = Math.random): string {
  const hex = (n: number, width: number) => Math.floor(n).toString(16).padStart(width, '0').slice(-width);
  return hex(now / 1000, 8) + hex(random() * 0xffffff, 6) + hex(random() * 0x7fff, 4) + '000001';
}

/** The message an error acknowledgement carries, which Overleaf sends as a string or an object with a message. */
export function ackError(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  const message = (value as { message?: unknown })?.message;
  return typeof message === 'string' ? message : JSON.stringify(value);
}
