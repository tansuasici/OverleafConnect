// Talks to Overleaf's web pages with the user's session cookie. The cookie is sent only to `origin` and never
// appears in an error, a log line or a URL. No vscode import, so it is tested with plain mocha and a fake fetch.

import {
  CSRF_HEADER,
  CompileOutput,
  isWebId,
  parseCompile,
  parseCsrf,
  parseProjects,
  parseRanges,
  parseThreads,
  parseUserId,
  WEB_ENDPOINTS,
  WebCommentAnchor,
  WebProject,
  WebThread,
} from './webModel';

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: 'manual' }) => Promise<{
  status: number;
  ok: boolean;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** A request Overleaf refused or answered unexpectedly: method, path and status only. */
export class WebError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly signedOut: boolean
  ) {
    super(
      signedOut
        ? `Overleaf did not accept the session cookie (${method} ${path} → ${status}). Set it again.`
        : `${method} ${path} → HTTP ${status}`
    );
  }
}

export class OverleafWebClient {
  private readonly origin: string;

  constructor(
    origin: string,
    private readonly cookie: string,
    private readonly fetchFn: FetchFn = globalThis.fetch as unknown as FetchFn
  ) {
    this.origin = new URL(origin).origin;
  }

  /** The CSRF token and user id from each project's page, fetched once per client. */
  private readonly pages = new Map<string, Promise<{ csrf: string; userId?: string }>>();

  private async request(method: 'GET' | 'POST' | 'DELETE', pathAndQuery: string, opts: { json?: unknown; csrf?: string; accept?: string } = {}) {
    const url = new URL(pathAndQuery, this.origin);
    if (url.origin !== this.origin) {
      throw new Error('Refusing to send the session cookie to another server.');
    }
    const headers: Record<string, string> = { Cookie: this.cookie, Accept: opts.accept ?? 'application/json' };
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (opts.csrf) {
      headers[CSRF_HEADER] = opts.csrf;
    }
    const res = await this.fetchFn(url.toString(), {
      method,
      headers,
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
      // A redirect means the login page: follow none, so the cookie is never replayed elsewhere.
      redirect: 'manual',
    });
    if (!res.ok) {
      const path = url.pathname;
      // On a change, 403 is a stale CSRF token or a missing permission rather than a dead session.
      const refused = res.status === 401 || (res.status === 403 && !opts.csrf);
      throw new WebError(method, path, res.status, (res.status >= 300 && res.status < 400) || refused);
    }
    return res;
  }

  private async getJson(pathAndQuery: string): Promise<unknown> {
    const res = await this.request('GET', pathAndQuery);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GET ${new URL(pathAndQuery, this.origin).pathname} did not return JSON.`);
    }
  }

  async csrfToken(projectId: string): Promise<string> {
    return (await this.projectPage(projectId)).csrf;
  }

  /** The signed-in user's id, to tell which comment messages are theirs; undefined when the page does not say. */
  async userId(projectId: string): Promise<string | undefined> {
    return (await this.projectPage(projectId)).userId;
  }

  private projectPage(projectId: string, fresh = false): Promise<{ csrf: string; userId?: string }> {
    let page = fresh ? undefined : this.pages.get(projectId);
    if (!page) {
      page = (async () => {
        const res = await this.request('GET', WEB_ENDPOINTS.projectPage(projectId), { accept: 'text/html' });
        const html = await res.text();
        const csrf = parseCsrf(html);
        if (!csrf) {
          throw new Error('The project page had no CSRF token; Overleaf may have changed its page.');
        }
        return { csrf, userId: parseUserId(html) };
      })();
      page.catch(() => this.pages.delete(projectId));
      this.pages.set(projectId, page);
    }
    return page;
  }

  /** A change to the project, with its CSRF token; a 403 fetches a fresh token and tries once more. */
  private async change(method: 'POST' | 'DELETE', projectId: string, path: string, json?: unknown) {
    const send = async (fresh: boolean) =>
      this.request(method, path, { csrf: (await this.projectPage(projectId, fresh)).csrf, json, accept: 'application/json' });
    try {
      return await send(false);
    } catch (error) {
      if (error instanceof WebError && error.status === 403) {
        return send(true);
      }
      throw error;
    }
  }

  async listProjects(): Promise<WebProject[]> {
    return parseProjects(await this.getJson(WEB_ENDPOINTS.projectList()));
  }

  async compile(projectId: string): Promise<CompileOutput> {
    const res = await this.change('POST', projectId, WEB_ENDPOINTS.compile(projectId), {
      rootDoc_id: null,
      draft: false,
      check: 'silent',
      incrementalCompilesEnabled: true,
    });
    return parseCompile(JSON.parse(await res.text()), this.origin);
  }

  /** A compile output file; only URLs on `origin`, which `parseCompile` guarantees. */
  async download(url: string): Promise<Buffer> {
    const u = new URL(url, this.origin);
    if (u.origin !== this.origin) {
      throw new Error('Refusing to send the session cookie to another server.');
    }
    const res = await this.request('GET', u.pathname + u.search, { accept: '*/*' });
    return Buffer.from(await res.arrayBuffer());
  }

  async threads(projectId: string): Promise<Map<string, WebThread>> {
    return parseThreads(await this.getJson(WEB_ENDPOINTS.threads(projectId)));
  }

  async commentAnchors(projectId: string): Promise<WebCommentAnchor[]> {
    return parseRanges(await this.getJson(WEB_ENDPOINTS.ranges(projectId)));
  }

  async reply(projectId: string, threadId: string, content: string): Promise<void> {
    await this.change('POST', projectId, WEB_ENDPOINTS.threadMessages(projectId, ids(threadId)), { content });
  }

  async editMessage(projectId: string, threadId: string, messageId: string, content: string): Promise<void> {
    await this.change('POST', projectId, WEB_ENDPOINTS.editMessage(projectId, ids(threadId), ids(messageId)), { content });
  }

  async deleteMessage(projectId: string, threadId: string, messageId: string): Promise<void> {
    await this.change('DELETE', projectId, WEB_ENDPOINTS.message(projectId, ids(threadId), ids(messageId)));
  }

  async resolveThread(projectId: string, docId: string, threadId: string): Promise<void> {
    await this.change('POST', projectId, WEB_ENDPOINTS.resolveThread(projectId, ids(docId), ids(threadId)));
  }

  async reopenThread(projectId: string, docId: string, threadId: string): Promise<void> {
    await this.change('POST', projectId, WEB_ENDPOINTS.reopenThread(projectId, ids(docId), ids(threadId)));
  }

  async deleteThread(projectId: string, docId: string, threadId: string): Promise<void> {
    await this.change('DELETE', projectId, WEB_ENDPOINTS.thread(projectId, ids(docId), ids(threadId)));
  }
}

/** An id about to go into a path: Overleaf's hex ids only. */
function ids(id: string): string {
  if (!isWebId(id)) {
    throw new Error('Overleaf sent an id this extension does not recognise.');
  }
  return id;
}
