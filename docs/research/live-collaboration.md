# Live co-editing and chat: research

Status: research (OC-10). Nothing here is built yet. This document records what the extension already knows about
Overleaf's real-time service, what live co-editing and chat from VS Code would need on top of it, and a recommendation.
It is based on the protocol as observed while building comment creation (0.2.3) and on reading Overleaf's public
source to understand it; no Overleaf code is copied, and none should be.

## What already works

`src/web/realtime.ts` holds a short-lived socket.io 0.9 connection, used today only to add a comment:

| Step | Frame / request |
| --- | --- |
| Handshake | `GET /socket.io/1/?t=<ms>&projectId=<id>` answers `sid:heartbeat:close:transports` |
| Socket | `wss://<host>/socket.io/1/websocket/<sid>?projectId=<id>`, with the user's cookie and the server's `Origin` |
| Heartbeat | `2::` answered with `2::` |
| Join | the server sends `joinProjectResponse` with the project tree and this connection's `publicId` |
| Open a doc | `joinDoc(docId, {encodeRanges: true})` acks `[lines, version, ops, ranges]`; lines are latin1-encoded UTF-8 |
| Change | `applyOtUpdate(docId, {doc, op, v})`; the ack means queued only |
| Confirm | `otUpdateApplied` with `{v, doc}` and no op to the sender; refusal is `otUpdateError`, then disconnect |

Documents in the newer `history-ot` format are refused by `joinDoc` for this client; comment creation tells the user to
use Overleaf for those.

## What live co-editing needs

1. **A connection that stays open.** One `RealtimeConnection` per open project, with reconnect and back-off, instead of
   one per action. On reconnect every joined doc must be re-joined from the version it last saw (the server can send
   the missed updates), or reloaded if that fails.
2. **Two-way text sync.** Local VS Code edits become ops (`{i, p}` insert, `{d, p}` delete, offsets in the doc's text),
   sent with the version they were made against. Remote `otUpdateApplied` events carry other users' ops, applied to
   the editor with a `WorkspaceEdit`.
3. **Operational transform.** While our update is in flight, remote updates keep arriving. The client must keep one
   in-flight update and a buffer of pending local edits, transform remote ops against both, and transform the buffer
   against the remote ops (the classic ShareJS-style text OT for plain text ops). This is the hard part: a mistake
   corrupts the user's document on Overleaf for everyone. It needs a clean-room implementation and property tests
   (random concurrent edits converge to the same text).
4. **Line endings and encoding.** Overleaf's text is `\n`-only and its offsets count UTF-16 code units of the decoded
   text; a CRLF file in VS Code must be mapped offset by offset.
5. **The file on disk.** Today the extension syncs files on disk. Live editing means the editor buffer, not the disk,
   is the truth for joined docs; the disk sync must skip those files or it fights the live channel.
6. **history-ot documents.** Overleaf is moving documents to a different OT format. A client built only for the old
   text ops would not work for them; this is a real risk for the whole feature.

## Cursors and presence

Overleaf exchanges positions with `clientTracking.updatePosition({row, column, doc_id})` and receives others as
`clientTracking.clientUpdated`, with `clientTracking.clientDisconnected` when someone leaves;
`clientTracking.getConnectedUsers` lists who is in the project. In VS Code these would be decorations (a coloured
caret and name label) and a "who is here" list. This works without the OT engine and is a cheap first step.

## Chat

Project chat is plain HTTP plus one event: `GET /project/:id/messages` (history), `POST /project/:id/messages` with
`{content}` (send, same CSRF handling as comment replies), and `new-chat-message` on the socket for new messages. A
webview or a Chat-like tree view can show it. This also does not need the OT engine.

## Recommendation

- Do **presence (cursors) and chat first**, on a long-lived connection: they need the connection work in point 1,
  but not OT, and they are read-mostly, so a bug cannot damage the document.
- Treat **live co-editing** as a separate, large project. Start only after a spike that shows the `history-ot` format
  can be supported or that the old format stays available for long enough. Until then, the disk sync stays the way
  to edit.
- Every new socket call keeps the current rules: the cookie goes only to the signed-in Overleaf origin, it is never
  logged, and no Overleaf code is copied.

## Open questions to verify against a live project

- The exact shape of `clientTracking.clientUpdated` and whether `updatePosition` needs the doc to be joined.
- Whether `joinDoc` with a `fromVersion` returns the missed ops after a reconnect.
- How long `history-ot` documents keep accepting the old text ops for other clients, if at all.
