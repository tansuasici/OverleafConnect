// Talks to Overleaf's web pages with the user's session cookie. The cookie is sent only to `origin` and never
// appears in an error, a log line or a URL. No vscode import, so it is tested with plain mocha and a fake fetch.

import { CSRF_HEADER, parseCompile, parseCsrf, parseProjects, parseRanges, parseThreads, WEB_ENDPOINTS, WebCommentAnchor, WebProject, WebThread, CompileOutput } from './webModel';

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

  private async request(method: 'GET' | 'POST', pathAndQuery: string, opts: { json?: unknown; csrf?: string; accept?: string } = {}) {
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
      throw new WebError(method, path, res.status, (res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403);
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
    const res = await this.request('GET', WEB_ENDPOINTS.projectPage(projectId), { accept: 'text/html' });
    const token = parseCsrf(await res.text());
    if (!token) {
      throw new Error('The project page had no CSRF token; Overleaf may have changed its page.');
    }
    return token;
  }

  async listProjects(): Promise<WebProject[]> {
    return parseProjects(await this.getJson(WEB_ENDPOINTS.projectList()));
  }

  async compile(projectId: string): Promise<CompileOutput> {
    const csrf = await this.csrfToken(projectId);
    const res = await this.request('POST', WEB_ENDPOINTS.compile(projectId), {
      csrf,
      json: { rootDoc_id: null, draft: false, check: 'silent', incrementalCompilesEnabled: true },
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
}
