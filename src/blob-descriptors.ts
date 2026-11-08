import { readFields } from './conversation-state';
import { toolSchemaRefs } from './tool-schema-refs';

/** Bounded subset of the installed agent.v1 descriptors (host module 91033).
 * Only declared blob fields are dependencies; inline bytes remain opaque.
 * Generated schemas establish these paths:
 * ConversationStep.2 -> ToolCall.8 -> ReadToolCall.2 -> ReadToolResult.1
 * -> ReadToolSuccess.{9,10}; ToolCall.34 -> TruncatedToolCall.1 is a step
 * reference, while TruncatedToolCall.5 is an inline ToolCall preview.
 * UserMessage.3 -> SelectedContext.{1,23,25} -> media.{1,9.1}.
 * ReadSuccess.7 is registered by module 91033 but belongs to ExecClientMessage
 * .{7,29} -> ReadResult.1, NOT the persisted ConversationStep read wrapper.
 * Do not confuse these different success schemas or invent a persisted path.
 */
type Descriptor = {
  blobs?: Readonly<
    Record<number, 'scan' | 'step' | 'invocation' | 'pr' | 'diff'>
  >;
  messages?: Readonly<Record<number, Descriptor>>;
  allowed: readonly number[];
  oneof?: readonly number[];
};

const paired: Descriptor = { allowed: [1, 2], blobs: { 1: 'scan' } };

const media: Descriptor = {
  allowed: [1, 2, 3, 4, 7, 8, 9, 10],
  oneof: [1, 8, 9, 10],
  blobs: { 1: 'scan' },
  messages: { 9: paired },
};

const invocation: Descriptor = {
  allowed: [1, 2, 3, 4, 10],
  oneof: [1, 2, 3, 4, 10],
  blobs: { 10: 'invocation' },
};

const pr: Descriptor = {
  allowed: [1, 2, 3, 4, 5, 6, 7],
  blobs: { 7: 'pr' },
};

const diff: Descriptor = {
  allowed: [1, 2, 3, 4, 5, 6],
  blobs: { 6: 'diff' },
};

const selected: Descriptor = {
  allowed: [...Array.from({ length: 27 }, (_, i) => i + 1), 34],
  messages: {
    1: media,
    2: invocation,
    9: { allowed: [1, 2, 3, 4, 5, 6], blobs: { 6: 'scan' } },
    16: { allowed: [1, 2], oneof: [1, 2], blobs: { 2: 'scan' } },
    20: diff,
    21: pr,
    23: {
      ...media,
      allowed: [1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13],
      oneof: [1, 8, 9, 11, 13],
    },
    25: media,
  },
};

const readSuccess: Descriptor = {
  allowed: Array.from({ length: 13 }, (_, i) => i + 1),
  oneof: [1, 6, 9, 10],
  blobs: { 9: 'scan', 10: 'scan' },
};

const tool: Descriptor = {
  allowed: [4, 5, 8, 34, 48, 54, 57, 59, 60],
  oneof: [4, 5, 8, 34, 48],
  messages: {
    // Installed 3.29.9 module 15354 / 59903: GrepToolCall -> GrepResult.
    // GrepSuccess contains inline search results, never blob references.
    5: {
      allowed: [1, 2],
      messages: {
        1: { allowed: Array.from({ length: 16 }, (_, i) => i + 1) },
        2: {
          allowed: [1, 2],
          oneof: [1, 2],
          messages: {
            1: { allowed: [1, 2, 3, 4, 5] },
            2: { allowed: [1] },
          },
        },
      },
    },
    4: {
      allowed: [1, 2],
      messages: {
        1: { allowed: [1, 2] },
        2: {
          allowed: [1, 2],
          oneof: [1, 2],
          messages: {
            1: { allowed: [1, 2, 3, 4, 5, 6] },
            2: { allowed: [1] },
          },
        },
      },
    },
    48: {
      allowed: [1, 2],
      messages: {
        1: { allowed: [1, 3, 4] },
        2: {
          allowed: [1, 2],
          oneof: [1, 2],
          messages: {
            1: { allowed: [1, 3] },
            2: { allowed: [1] },
          },
        },
      },
    },
    8: {
      allowed: [1, 2],
      messages: {
        2: { allowed: [1, 2], oneof: [1, 2], messages: { 1: readSuccess } },
      },
    },
    34: {
      allowed: [1, 2, 3, 4, 5],
      blobs: { 1: 'step' },
    },
  },
};

// TruncatedToolCall.preview is another ToolCall, not another ConversationStep.
tool.messages![34]!.messages = { 5: tool };

/** Structured roots reached by the shared blob graph. */
export type DescriptorKind = 'selected' | 'tool' | 'invocation' | 'pr' | 'diff';

/** Parse known wrappers without searching arbitrary byte strings for hashes. */
export function descriptorRefs(kind: DescriptorKind, bytes: Buffer) {
  if (kind === 'tool') return toolSchemaRefs(bytes);

  const out: {
    digest: string;
    kind: 'scan' | 'step' | 'invocation' | 'pr' | 'diff';
    required: boolean;
  }[] = [];

  let count = 0;

  const visit = (schema: Descriptor, payload: Buffer, depth: number): void => {
    if (depth > 32) throw new Error('Typed blob wrappers exceed depth limit.');
    let oneofSeen = false;

    for (const field of readFields(payload)) {
      if (schema.oneof?.includes(field.field)) {
        if (oneofSeen) throw new Error('Ambiguous typed wrapper oneof.');
        oneofSeen = true;
      }

      if (++count > 100_000) throw new Error('Too many typed wrapper fields.');
      if (!schema.allowed.includes(field.field))
        throw new Error(`Unknown typed blob wrapper field ${field.field}.`);
      const role = schema.blobs?.[field.field];
      const nested = schema.messages?.[field.field];

      if (!role && !nested) continue;
      if (field.wire !== 2) throw new Error('Invalid typed wrapper wire type.');
      if (role) {
        if (field.bytes.length === 0) continue;
        if (field.bytes.length !== 32)
          throw new Error('Invalid typed blob id.');

        out.push({
          digest: field.bytes.toString('hex'),
          kind: role,
          required: true,
        });
      } else if (nested) visit(nested, field.bytes, depth + 1);
    }
  };

  visit({ selected, tool, invocation, pr, diff }[kind], bytes, 0);

  return out;
}
