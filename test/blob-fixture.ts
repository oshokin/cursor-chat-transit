import { createHash } from 'node:crypto';

/** SHA-256 of blob bytes, which Cursor uses as the agentKv id. */
export function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Protobuf varint. */
function varint(value: number): Buffer {
  const out: number[] = [];
  let n = value;

  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }

  out.push(n);

  return Buffer.from(out);
}

/** Length-delimited protobuf field. */
function field(number: number, payload: Buffer): Buffer {
  return Buffer.concat([
    varint((number << 3) | 2),
    varint(payload.length),
    payload,
  ]);
}

/** 32-byte blob id field. */
function blob(number: number, id: string): Buffer {
  return field(number, Buffer.from(id, 'hex'));
}

/**
 * One chat shaped like Cursor's agent.v1 messages.
 * The todo blob is named and deliberately absent.
 */
export function agentChatFixture() {
  const text = Buffer.from('Please look at publish_deb.sh');
  const tool = Buffer.from('contents of publish_deb.sh');
  const fileBody = Buffer.from('package main\n');
  const initial = Buffer.from('package main\nfunc old()\n');
  const summary = Buffer.from('Packaging scripts were updated.');
  const textId = digest(text);
  const toolId = digest(tool);
  const fileId = digest(fileBody);
  const initialId = digest(initial);
  const summaryId = digest(summary);

  const user = Buffer.concat([
    field(1, Buffer.from('update the packaging scripts')),
    blob(18, textId),
  ]);

  const step = Buffer.concat([
    field(1, field(1, Buffer.from('I edited publish_deb.sh'))),
    field(
      2,
      Buffer.concat([
        field(1, Buffer.from('read')),
        field(4, Buffer.from('a'.repeat(32))),
        blob(5, toolId),
      ]),
    ),
  ]);

  const userId = digest(user);
  const stepId = digest(step);
  const turn = field(1, Buffer.concat([blob(1, userId), blob(2, stepId)]));
  const turnId = digest(turn);
  const archive = blob(4, summaryId);
  const archiveId = digest(archive);
  const todoId = 'ab'.repeat(32);

  const state = Buffer.concat([
    blob(8, turnId),
    blob(3, todoId),
    blob(13, archiveId),
    field(
      15,
      Buffer.concat([
        field(1, Buffer.from('publish_deb.sh')),
        field(2, Buffer.concat([blob(1, fileId), blob(2, initialId)])),
      ]),
    ),
    field(18, Buffer.from('c'.repeat(32))),
  ]);

  const blobs = new Map<string, Buffer>([
    [turnId, turn],
    [userId, user],
    [stepId, step],
    [textId, text],
    [toolId, tool],
    [fileId, fileBody],
    [initialId, initial],
    [summaryId, summary],
    [archiveId, archive],
  ]);

  return {
    state: `~${state.toString('base64')}`,
    blobs,
    present: [
      turnId,
      archiveId,
      fileId,
      initialId,
      userId,
      stepId,
      summaryId,
      textId,
      toolId,
    ],
    missing: todoId,
    decoy: Buffer.from('a'.repeat(32)).toString('hex'),
    readPath: Buffer.from('c'.repeat(32)).toString('hex'),
  };
}
