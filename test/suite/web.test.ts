import * as assert from 'assert';
import { webOrigin } from '../../src/auth/projectUrl';
import { FetchFn, OverleafWebClient, WebError } from '../../src/web/overleafWeb';
import {
  CSRF_HEADER,
  locateQuote,
  normalizeCookie,
  parseCompile,
  parseCsrf,
  parseProjects,
  parseRanges,
  parseThreads,
} from '../../src/web/webModel';

const ID = '0123456789abcdef01234567';
const ORIGIN = 'https://www.overleaf.com';
const COOKIE = 'overleaf_session2=s%3Asecret-value';

suite('webModel', () => {
  test('normalizeCookie keeps name=value pairs and drops a Cookie: prefix', () => {
    assert.strictEqual(normalizeCookie('  Cookie: a=b; '), 'a=b');
    assert.strictEqual(normalizeCookie('a=b; c=d'), 'a=b; c=d');
    assert.strictEqual(normalizeCookie('justavalue'), undefined);
    assert.strictEqual(normalizeCookie('a=b c'), undefined);
    assert.strictEqual(normalizeCookie(''), undefined);
  });

  test('parseCsrf reads the meta tag in either attribute order', () => {
    assert.strictEqual(parseCsrf('<meta name="ol-csrfToken" content="tok1">'), 'tok1');
    assert.strictEqual(parseCsrf("<meta content='tok2' name='ol-csrfToken'/>"), 'tok2');
    assert.strictEqual(parseCsrf('<meta name="other" content="x">'), undefined);
  });

  test('parseProjects sorts active newest first and skips bad ids', () => {
    const list = parseProjects({
      projects: [
        { _id: 'aaaaaaaaaaaa', name: 'Old', lastUpdated: '2024-01-01T00:00:00Z' },
        { _id: 'bbbbbbbbbbbb', name: 'Archived', archived: true, lastUpdated: '2026-01-01T00:00:00Z' },
        { _id: 'cccccccccccc', name: 'New', lastUpdated: '2025-01-01T00:00:00Z' },
        { _id: 'not-an-id', name: 'Bad' },
      ],
    });
    assert.deepStrictEqual(list.map((p) => p.name), ['New', 'Old', 'Archived']);
    assert.strictEqual(list[2].inactive, true);
    assert.deepStrictEqual(parseProjects([{ id: 'dddddddddddd' }]).map((p) => p.name), ['dddddddddddd']);
    assert.deepStrictEqual(parseProjects('nope'), []);
  });

  test('parseCompile resolves URLs on the origin and drops foreign ones', () => {
    const r = parseCompile(
      {
        status: 'success',
        clsiServerId: 'clsi-1',
        outputFiles: [
          { path: 'output.pdf', url: `/project/${ID}/build/abc/output/output.pdf` },
          { path: 'output.log', url: 'https://evil.example/output.log' },
        ],
      },
      ORIGIN
    );
    assert.strictEqual(r.status, 'success');
    assert.strictEqual(r.pdfUrl, `${ORIGIN}/project/${ID}/build/abc/output/output.pdf?clsiserverid=clsi-1`);
    assert.strictEqual(r.logUrl, undefined);
    assert.strictEqual(parseCompile(null, ORIGIN).status, 'unknown');
  });

  test('parseThreads orders messages and names authors', () => {
    const t = parseThreads({
      t1: {
        resolved: false,
        messages: [
          { content: 'second', timestamp: 2, user: { first_name: 'Ada', last_name: 'L' } },
          { content: 'first', timestamp: 1, user: {} },
        ],
      },
      t2: { resolved: true, messages: [] },
    });
    assert.deepStrictEqual(t.get('t1')!.messages.map((m) => [m.content, m.author]), [
      ['first', 'Overleaf user'],
      ['second', 'Ada L'],
    ]);
    assert.strictEqual(t.get('t2')!.resolved, true);
    assert.strictEqual(parseThreads([]).size, 0);
  });

  test('parseRanges reads comment anchors across documents', () => {
    const a = parseRanges([
      { id: 'doc1', ranges: { comments: [{ id: 'c1', op: { c: 'hello', p: 4, t: 't1' } }, { op: { c: '', p: 0, t: 'x' } }] } },
      { id: 'doc2', ranges: {} },
    ]);
    assert.deepStrictEqual(a, [{ threadId: 't1', quote: 'hello', offset: 4 }]);
  });

  test('locateQuote prefers the offset, then the nearest occurrence', () => {
    assert.strictEqual(locateQuote('ab hello hello', 'hello', 9), 9);
    assert.strictEqual(locateQuote('hello xx hello', 'hello', 7), 9);
    assert.strictEqual(locateQuote('nothing here', 'hello', 0), undefined);
  });

  test('webOrigin maps git hosts to the web origin without credentials', () => {
    assert.strictEqual(webOrigin(`https://git:tok@git.overleaf.com/${ID}`), ORIGIN);
    assert.strictEqual(webOrigin('https://git.overleaf.com'), ORIGIN);
    assert.strictEqual(webOrigin('https://git.latex.example.org/abc'), 'https://latex.example.org');
  });
});

type Call = { url: string; method: string; headers: Record<string, string>; body?: string; redirect: string };

function fakeFetch(handler: (call: Call) => { status: number; body?: string }): { fetchFn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const call = { url, ...init };
    calls.push(call);
    const { status, body = '' } = handler(call);
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    };
  };
  return { fetchFn, calls };
}

suite('OverleafWebClient', () => {
  test('sends the cookie only to the origin and never follows redirects', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: JSON.stringify({ projects: [] }) }));
    await new OverleafWebClient(ORIGIN, COOKIE, fetchFn).listProjects();
    assert.strictEqual(calls[0].url, `${ORIGIN}/user/projects`);
    assert.strictEqual(calls[0].headers.Cookie, COOKIE);
    assert.strictEqual(calls[0].redirect, 'manual');
  });

  test('a redirect means signed out, and the error never holds the cookie', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 302 }));
    const client = new OverleafWebClient(ORIGIN, COOKIE, fetchFn);
    await assert.rejects(client.listProjects(), (e: unknown) => {
      assert.ok(e instanceof WebError);
      assert.strictEqual(e.signedOut, true);
      assert.ok(!e.message.includes('secret-value'));
      return true;
    });
  });

  test('a server error is not signed out', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 500 }));
    await assert.rejects(new OverleafWebClient(ORIGIN, COOKIE, fetchFn).threads(ID), (e: unknown) => {
      assert.ok(e instanceof WebError && !e.signedOut && e.message.includes('500'));
      return true;
    });
  });

  test('refuses to download from another host', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 200 }));
    const client = new OverleafWebClient(ORIGIN, COOKIE, fetchFn);
    await assert.rejects(client.download('https://evil.example/x.pdf'));
    await assert.rejects(client.download('//evil.example/x.pdf'));
    assert.strictEqual(calls.length, 0);
    await client.download(`${ORIGIN}/out.pdf`);
    assert.strictEqual(calls[0].url, `${ORIGIN}/out.pdf`);
  });

  test('compile fetches the CSRF token and sends it on the POST', async () => {
    const { fetchFn, calls } = fakeFetch((call) =>
      call.method === 'GET'
        ? { status: 200, body: '<meta name="ol-csrfToken" content="tok">' }
        : { status: 200, body: JSON.stringify({ status: 'success', outputFiles: [{ path: 'output.pdf', url: '/out.pdf' }] }) }
    );
    const r = await new OverleafWebClient(ORIGIN, COOKIE, fetchFn).compile(ID);
    assert.strictEqual(calls[0].url, `${ORIGIN}/project/${ID}`);
    assert.strictEqual(calls[1].method, 'POST');
    assert.strictEqual(calls[1].headers[CSRF_HEADER], 'tok');
    assert.strictEqual(calls[1].url, `${ORIGIN}/project/${ID}/compile?auto_compile=false`);
    assert.strictEqual(r.pdfUrl, `${ORIGIN}/out.pdf`);
  });
});
