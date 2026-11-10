import * as assert from 'assert';
import { webOrigin } from '../../src/auth/projectUrl';
import { CommentPlacementError, FetchFn, OverleafWebClient, WebError } from '../../src/web/overleafWeb';
import { RealtimeConnection, RealtimeError, RealtimeSocket, SocketFactory } from '../../src/web/realtime';
import {
  ackError,
  CSRF_HEADER,
  decodeDocLine,
  eventFrame,
  findDocId,
  locateQuote,
  newThreadId,
  parseFrame,
  parseHandshake,
  normalizeCookie,
  sessionCookieName,
  parseCompile,
  parseCsrf,
  parseProjects,
  parseRanges,
  parseThreads,
  parseUserId,
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

  test('normalizeCookie names a bare value only when the name is known', () => {
    assert.strictEqual(normalizeCookie(' s%3Aabc ', 'overleaf_session2'), 'overleaf_session2=s%3Aabc');
    assert.strictEqual(normalizeCookie('a=b', 'overleaf_session2'), 'a=b');
    assert.strictEqual(normalizeCookie('a b', 'overleaf_session2'), undefined);
    assert.strictEqual(normalizeCookie('', 'overleaf_session2'), undefined);
  });

  test('sessionCookieName knows overleaf.com only', () => {
    assert.strictEqual(sessionCookieName(webOrigin('https://git.overleaf.com')), 'overleaf_session2');
    assert.strictEqual(sessionCookieName('https://www.overleaf.com'), 'overleaf_session2');
    assert.strictEqual(sessionCookieName('https://latex.example.org'), undefined);
    assert.strictEqual(sessionCookieName(undefined), undefined);
  });

  test('parseCsrf reads the meta tag in either attribute order', () => {
    assert.strictEqual(parseCsrf('<meta name="ol-csrfToken" content="tok1">'), 'tok1');
    assert.strictEqual(parseCsrf("<meta content='tok2' name='ol-csrfToken'/>"), 'tok2');
    assert.strictEqual(parseCsrf('<meta name="other" content="x">'), undefined);
  });

  test('parseUserId reads the user meta tag', () => {
    assert.strictEqual(parseUserId('<meta content="u1" name="ol-user_id">'), 'u1');
    assert.strictEqual(parseUserId('<meta name="ol-csrfToken" content="x">'), undefined);
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
    // overleaf.com's real shape: only _id, name and accessLevel, kept in the server's order.
    const real = parseProjects({ projects: [{ _id: 'eeeeeeeeeeee', name: 'B', accessLevel: 'readWrite' }, { _id: 'ffffffffffff', name: 'A', accessLevel: 'owner' }] });
    assert.deepStrictEqual(real.map((p) => [p.name, p.accessLevel]), [['B', 'readWrite'], ['A', 'owner']]);
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
          { id: 'm2', content: 'second', timestamp: 2, user: { id: 'u1', first_name: 'Ada', last_name: 'L' } },
          { _id: 'm1', user_id: 'u2', content: 'first', timestamp: 1, user: {} },
        ],
      },
      t2: { resolved: true, messages: [] },
    });
    assert.deepStrictEqual(t.get('t1')!.messages.map((m) => [m.content, m.author]), [
      ['first', 'Overleaf user'],
      ['second', 'Ada L'],
    ]);
    assert.deepStrictEqual(t.get('t1')!.messages.map((m) => [m.id, m.userId]), [
      ['m1', 'u2'],
      ['m2', 'u1'],
    ]);
    assert.strictEqual(t.get('t2')!.resolved, true);
    assert.strictEqual(parseThreads([]).size, 0);
  });

  test('parseRanges reads comment anchors across documents', () => {
    const a = parseRanges([
      { id: 'doc1', ranges: { comments: [{ id: 'c1', op: { c: 'hello', p: 4, t: 't1' } }, { op: { c: '', p: 0, t: 'x' } }] } },
      { id: 'doc2', ranges: {} },
    ]);
    assert.deepStrictEqual(a, [{ threadId: 't1', docId: 'doc1', quote: 'hello', offset: 4 }]);
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

  const T = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const M = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const D = 'cccccccccccccccccccccccc';
  const page = (call: Call) => (call.method === 'GET' ? { status: 200, body: '<meta name="ol-csrfToken" content="tok"><meta name="ol-user_id" content="me">' } : { status: 204 });

  test('comment changes go to their endpoints with the CSRF token, fetching the page once', async () => {
    const { fetchFn, calls } = fakeFetch(page);
    const client = new OverleafWebClient(ORIGIN, COOKIE, fetchFn);
    assert.strictEqual(await client.userId(ID), 'me');
    await client.reply(ID, T, 'hi');
    await client.editMessage(ID, T, M, 'hey');
    await client.deleteMessage(ID, T, M);
    await client.resolveThread(ID, D, T);
    await client.reopenThread(ID, D, T);
    await client.deleteThread(ID, D, T);
    assert.strictEqual(calls.filter((c) => c.method === 'GET').length, 1);
    const changes = calls.filter((c) => c.method !== 'GET');
    assert.deepStrictEqual(
      changes.map((c) => [c.method, c.url.slice(ORIGIN.length), c.body]),
      [
        ['POST', `/project/${ID}/thread/${T}/messages`, '{"content":"hi"}'],
        ['POST', `/project/${ID}/thread/${T}/messages/${M}/edit`, '{"content":"hey"}'],
        ['DELETE', `/project/${ID}/thread/${T}/messages/${M}`, undefined],
        ['POST', `/project/${ID}/doc/${D}/thread/${T}/resolve`, undefined],
        ['POST', `/project/${ID}/doc/${D}/thread/${T}/reopen`, undefined],
        ['DELETE', `/project/${ID}/doc/${D}/thread/${T}`, undefined],
      ]
    );
    assert.ok(changes.every((c) => c.headers[CSRF_HEADER] === 'tok' && c.headers.Cookie === COOKIE && c.redirect === 'manual'));
  });

  test('a 403 on a change refetches the token once and is not taken as signed out', async () => {
    let pages = 0;
    const { fetchFn, calls } = fakeFetch((call) => {
      if (call.method === 'GET') {
        pages++;
        return { status: 200, body: `<meta name="ol-csrfToken" content="tok${pages}">` };
      }
      return { status: call.headers[CSRF_HEADER] === 'tok2' ? 204 : 403 };
    });
    const client = new OverleafWebClient(ORIGIN, COOKIE, fetchFn);
    await client.reply(ID, T, 'hi');
    assert.strictEqual(calls.filter((c) => c.method === 'POST').length, 2);

    const { fetchFn: denied } = fakeFetch((call) => (call.method === 'GET' ? page(call) : { status: 403 }));
    await assert.rejects(new OverleafWebClient(ORIGIN, COOKIE, denied).resolveThread(ID, D, T), (e: unknown) => {
      assert.ok(e instanceof WebError && e.status === 403 && !e.signedOut);
      return true;
    });
  });

  test('ids that are not Overleaf ids never reach a path', async () => {
    const { fetchFn, calls } = fakeFetch(page);
    const client = new OverleafWebClient(ORIGIN, COOKIE, fetchFn);
    await assert.rejects(client.deleteMessage(ID, T, '../../user/delete'));
    assert.ok(calls.every((c) => c.method === 'GET'));
  });
});

suite('realtime protocol', () => {
  test('parseHandshake takes the session id only when websocket is offered', () => {
    assert.strictEqual(parseHandshake('abc-123:60:60:websocket,xhr-polling'), 'abc-123');
    assert.strictEqual(parseHandshake('abc:60:60:xhr-polling'), undefined);
    assert.strictEqual(parseHandshake('<html>'), undefined);
    assert.strictEqual(parseHandshake(''), undefined);
  });

  test('parseFrame reads events, acks, heartbeats and errors', () => {
    assert.deepStrictEqual(parseFrame('2::'), { kind: 'heartbeat' });
    assert.deepStrictEqual(parseFrame('0::'), { kind: 'disconnect' });
    assert.deepStrictEqual(parseFrame('5:::{"name":"joinProjectResponse","args":[{"a":1}]}'), { kind: 'event', name: 'joinProjectResponse', args: [{ a: 1 }] });
    assert.deepStrictEqual(parseFrame('6:::3+[null,["x"],7]'), { kind: 'ack', id: 3, args: [null, ['x'], 7] });
    assert.deepStrictEqual(parseFrame('7:::1+0'), { kind: 'error', reason: '1+0' });
    assert.deepStrictEqual(parseFrame('5:::not json'), { kind: 'other' });
    assert.deepStrictEqual(parseFrame('garbage'), { kind: 'other' });
  });

  test('eventFrame asks for an acknowledgement with data', () => {
    assert.strictEqual(eventFrame(4, 'joinDoc', ['d', { encodeRanges: true }]), '5:4+::{"name":"joinDoc","args":["d",{"encodeRanges":true}]}');
  });

  test('decodeDocLine turns UTF-8 bytes back into text', () => {
    const encoded = Buffer.from('Çalışma – ğ', 'utf8').toString('latin1');
    assert.strictEqual(decodeDocLine(encoded), 'Çalışma – ğ');
    assert.strictEqual(decodeDocLine('plain'), 'plain');
  });

  test('findDocId walks folders and ignores files that are not documents', () => {
    const D1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const D2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const project = {
      rootFolder: [{ name: 'rootFolder', docs: [{ _id: D1, name: 'main.tex' }], fileRefs: [{ _id: ID, name: 'fig.png' }], folders: [{ name: 'chapters', docs: [{ _id: D2, name: 'intro.tex' }], folders: [] }] }],
    };
    assert.strictEqual(findDocId(project, 'main.tex'), D1);
    assert.strictEqual(findDocId(project, 'chapters/intro.tex'), D2);
    assert.strictEqual(findDocId(project, 'fig.png'), undefined);
    assert.strictEqual(findDocId(project, 'other/intro.tex'), undefined);
    assert.strictEqual(findDocId(undefined, 'main.tex'), undefined);
  });

  test('newThreadId is a 24-hex id that starts with the time', () => {
    const id = newThreadId(0x5f000000 * 1000, () => 0.5);
    assert.match(id, /^[0-9a-f]{24}$/);
    assert.ok(id.startsWith('5f000000'));
    assert.ok(id.endsWith('000001'));
    assert.match(newThreadId(), /^[0-9a-f]{24}$/);
  });

  test('ackError reads strings, messages and nothing', () => {
    assert.strictEqual(ackError(null), undefined);
    assert.strictEqual(ackError('boom'), 'boom');
    assert.strictEqual(ackError({ message: 'bad' }), 'bad');
    assert.strictEqual(ackError({ code: 1 }), '{"code":1}');
  });
});

/** A socket that records what is sent and answers each event through `answer`. */
class FakeSocket implements RealtimeSocket {
  readonly sent: string[] = [];
  closed = false;
  private listener?: (data: string) => void;
  private closeListener?: (error?: Error) => void;

  constructor(private readonly answer: (name: string, args: unknown[]) => unknown[] | undefined = () => [null]) {}

  send(data: string): void {
    this.sent.push(data);
    const m = data.match(/^5:(\d+)\+::([\s\S]*)$/);
    if (m) {
      const { name, args } = JSON.parse(m[2]) as { name: string; args: unknown[] };
      const reply = this.answer(name, args);
      if (reply) {
        setImmediate(() => this.push(`6:::${m[1]}+${JSON.stringify(reply)}`));
      }
    }
  }
  close(): void {
    this.closed = true;
  }
  onMessage(listener: (data: string) => void): void {
    this.listener = listener;
  }
  onClose(listener: (error?: Error) => void): void {
    this.closeListener = listener;
  }
  push(frame: string): void {
    this.listener?.(frame);
  }
  drop(): void {
    this.closeListener?.();
  }
}

suite('RealtimeConnection', () => {
  test('echoes heartbeats and keeps the project from joinProjectResponse', async () => {
    const socket = new FakeSocket();
    const connection = new RealtimeConnection(socket, 200);
    socket.push('2::');
    assert.deepStrictEqual(socket.sent, ['2::']);
    socket.push('5:::{"name":"joinProjectResponse","args":[{"project":{"name":"P"}}]}');
    assert.deepStrictEqual(await connection.project(), { name: 'P' });
  });

  test('waits for the project when it comes later', async () => {
    const socket = new FakeSocket();
    const connection = new RealtimeConnection(socket, 200);
    const project = connection.project();
    socket.push('5:::{"name":"joinProjectResponse","args":[{"project":{"name":"Q"}}]}');
    assert.deepStrictEqual(await project, { name: 'Q' });
  });

  test('call resolves with the acknowledgement after the error slot', async () => {
    const socket = new FakeSocket(() => [null, ['line'], 3]);
    const connection = new RealtimeConnection(socket, 200);
    assert.deepStrictEqual(await connection.call('joinDoc', ['d']), [['line'], 3]);
  });

  test('call rejects with the error an acknowledgement carries', async () => {
    const socket = new FakeSocket(() => [{ message: 'not allowed' }]);
    const connection = new RealtimeConnection(socket, 200);
    await assert.rejects(connection.call('joinDoc', ['d']), (e: unknown) => e instanceof RealtimeError && e.message === 'not allowed');
  });

  test('a rejected connection fails what is waiting', async () => {
    const socket = new FakeSocket(() => undefined);
    const connection = new RealtimeConnection(socket, 200);
    const pending = connection.call('joinDoc', ['d']);
    socket.push('5:::{"name":"connectionRejected","args":[{"message":"no access"}]}');
    await assert.rejects(pending, /no access/);
    await assert.rejects(connection.project(), /no access/);
  });

  test('times out when Overleaf does not answer, and a dropped socket fails calls', async () => {
    const quiet = new RealtimeConnection(new FakeSocket(() => undefined), 20);
    await assert.rejects(quiet.call('joinDoc', ['d']), /did not answer in time/);
    const socket = new FakeSocket(() => undefined);
    const dropped = new RealtimeConnection(socket, 200);
    const pending = dropped.call('joinDoc', ['d']);
    socket.drop();
    await assert.rejects(pending, /closed/);
  });

  test('close says goodbye and closes the socket', () => {
    const socket = new FakeSocket();
    new RealtimeConnection(socket, 200).close();
    assert.deepStrictEqual(socket.sent, ['0::']);
    assert.ok(socket.closed);
  });
});

suite('OverleafWebClient.addComment', () => {
  const DOC = 'cccccccccccccccccccccccc';
  const PROJECT = { rootFolder: [{ name: 'rootFolder', docs: [{ _id: DOC, name: 'main.tex' }], folders: [] }] };
  const LINES = ['\\section{Giriş}', 'Hello world, hello again.'].map((l) => Buffer.from(l, 'utf8').toString('latin1'));

  type Setup = { joinDoc?: unknown[]; project?: unknown; afterUpdate?: string[] };
  function setup(opts: Setup = {}) {
    const calls: (Call & { order: number })[] = [];
    const sockets: { url: string; headers: Record<string, string>; socket: FakeSocket }[] = [];
    const events: string[] = [];
    const applied: string[] = [];
    let order = 0;
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, ...init, order: order++ });
      events.push(`${init.method} ${new URL(url).pathname}`);
      const handshake = url.includes('/socket.io/1/?');
      const body = handshake ? 'sid-1:60:60:websocket,xhr-polling' : url.endsWith('/project/' + ID) ? '<meta name="ol-csrfToken" content="tok">' : '';
      return {
        status: 200,
        ok: true,
        text: async () => body,
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => null, getSetCookie: () => (handshake ? ['GCLB=affinity; Path=/; HttpOnly', 'overleaf_session2=other; Path=/'] : []) },
      };
    };
    const socketFactory: SocketFactory = async (url, headers) => {
      const socket = new FakeSocket((name) => {
        events.push(`ws ${name}`);
        if (name === 'joinDoc') {
          return opts.joinDoc ?? [null, LINES, 42, [], {}, 'sharejs-text-ot'];
        }
        if (name === 'applyOtUpdate') {
          const after = opts.afterUpdate ?? [`5:::${JSON.stringify({ name: 'otUpdateApplied', args: [{ v: 42, doc: DOC }] })}`];
          after.forEach((frame, i) => setTimeout(() => (applied.push(frame), socket.push(frame)), 5 * (i + 1)));
        }
        return [null];
      });
      sockets.push({ url, headers, socket });
      setImmediate(() => socket.push(`5:::${JSON.stringify({ name: 'joinProjectResponse', args: [{ project: opts.project ?? PROJECT }] })}`));
      return socket;
    };
    const client = new OverleafWebClient(ORIGIN, COOKIE, fetchFn, socketFactory);
    return { client, calls, sockets, events, applied };
  }

  test('posts the first message, then marks the quote in the document', async () => {
    const { client, calls, sockets, events } = setup();
    await client.addComment(ID, 'main.tex', 'hello', 40, 'Check this');
    assert.strictEqual(sockets.length, 1);
    assert.strictEqual(sockets[0].url, `wss://www.overleaf.com/socket.io/1/websocket/sid-1?projectId=${ID}`);
    assert.strictEqual(sockets[0].headers.Origin, ORIGIN);
    assert.strictEqual(sockets[0].headers.Cookie, `${COOKIE}; GCLB=affinity`);
    calls.forEach((c) => assert.ok(c.url.startsWith(ORIGIN + '/')));
    const post = calls.find((c) => c.method === 'POST');
    assert.ok(post);
    assert.match(post.url, new RegExp(`/project/${ID}/thread/[0-9a-f]{24}/messages$`));
    assert.deepStrictEqual(JSON.parse(post.body!), { content: 'Check this' });
    const threadId = post.url.match(/thread\/([0-9a-f]{24})/)![1];
    const sent = sockets[0].socket.sent.filter((f) => f.startsWith('5:')).map((f) => JSON.parse(f.replace(/^5:\d+\+::/, '')));
    assert.deepStrictEqual(sent[0], { name: 'joinDoc', args: [DOC, { encodeRanges: true }] });
    // "\section{Giriş}\n" is 16 characters; the second "hello" is at 13 in the next line.
    assert.deepStrictEqual(sent[1], { name: 'applyOtUpdate', args: [DOC, { doc: DOC, op: [{ c: 'hello', p: 16 + 13, t: threadId }], v: 42 }] });
    assert.ok(events.indexOf(`POST /project/${ID}/thread/${threadId}/messages`) < events.indexOf('ws applyOtUpdate'));
    assert.ok(sockets[0].socket.closed);
  });

  test('waits for Overleaf to apply the update, ignoring other edits', async () => {
    const other = `5:::${JSON.stringify({ name: 'otUpdateApplied', args: [{ v: 42, doc: DOC, op: [{ i: 'x', p: 0 }], meta: { source: 'someone' } }] })}`;
    const mine = `5:::${JSON.stringify({ name: 'otUpdateApplied', args: [{ v: 43, doc: DOC }] })}`;
    const { client, applied } = setup({ afterUpdate: [other, mine] });
    await client.addComment(ID, 'main.tex', 'hello', 0, 'x');
    assert.deepStrictEqual(applied, [other, mine]);
  });

  test('reports an update Overleaf refused after queueing it', async () => {
    const { client } = setup({ afterUpdate: [`5:::${JSON.stringify({ name: 'otUpdateError', args: ['Delete component does not match', {}] })}`] });
    await assert.rejects(client.addComment(ID, 'main.tex', 'hello', 0, 'x'), (e: unknown) => e instanceof RealtimeError && /does not match/.test(e.message));
  });

  test('refuses a quote Overleaf does not have, and posts nothing', async () => {
    const { client, calls, sockets } = setup();
    await assert.rejects(client.addComment(ID, 'main.tex', 'not there', 0, 'x'), (e: unknown) => e instanceof CommentPlacementError && /Sync/.test(e.message));
    assert.ok(!calls.some((c) => c.method === 'POST'));
    assert.ok(sockets[0].socket.closed);
  });

  test('refuses a file that is not a document in the project', async () => {
    const { client } = setup();
    await assert.rejects(client.addComment(ID, 'missing.tex', 'hello', 0, 'x'), CommentPlacementError);
  });

  test('explains documents in the newer editing format', async () => {
    const { client } = setup({ joinDoc: ['client does not support history-ot'] });
    await assert.rejects(client.addComment(ID, 'main.tex', 'hello', 0, 'x'), (e: unknown) => e instanceof CommentPlacementError && /on Overleaf/.test(e.message));
  });
});
