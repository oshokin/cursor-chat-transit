import { createHash, type Hash } from 'node:crypto';
import { FINGERPRINT_ALGORITHM } from './bundle-limits';
import { canonicalJson } from './import-policy';

/**
 * Drop `grouping.textPreview` on one conversation header only.
 * Nested objects keep a field of the same name. An empty `grouping` is removed.
 */
export function stripConversationPreview(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const grouping = record.grouping;

  if (!grouping || typeof grouping !== 'object' || Array.isArray(grouping)) {
    return value;
  }

  if (!Object.hasOwn(grouping, 'textPreview')) return value;
  const nextGrouping = { ...(grouping as Record<string, unknown>) };

  delete nextGrouping.textPreview;
  const next: Record<string, unknown> = { ...record };

  if (Object.keys(nextGrouping).length === 0) delete next.grouping;
  else next.grouping = nextGrouping;

  return next;
}

/** Length-framed SHA-256 of snapshot components. */
export class SnapshotHasher {
  /** Running SHA-256 of the framed snapshot. */
  private readonly hash: Hash = createHash('sha256');
  /** Whether conversation bytes were framed, and whether that array was empty. */
  private conversation: 'absent' | 'empty' | 'present' | undefined;

  /** Source composer id. */
  source(sourceComposerId: string): void {
    this.frame('algorithm', FINGERPRINT_ALGORITHM);
    this.frame('source', sourceComposerId);
  }

  /** Header without workspace binding. */
  header(value: Record<string, unknown>): void {
    const copy = { ...value };

    delete copy.workspaceIdentifier;
    this.frame('header', canonicalJson(copy));
  }

  /** Composer fields with the conversation array already removed. */
  composer(value: Record<string, unknown>): void {
    this.frame('composer', canonicalJson(value));
  }

  /** Distinguish a missing conversation array from an empty one. */
  conversationState(state: 'absent' | 'empty' | 'present'): void {
    this.conversation = state;
    this.frame('conversation-state', state);
  }

  /** One conversation element in source order. */
  conversationItem(value: unknown): void {
    if (this.conversation !== 'present') {
      throw new Error('Conversation item without a present conversation.');
    }

    this.frame('conversation', canonicalJson(stripConversationPreview(value)));
  }

  /** One bubble component. Caller supplies bubble-id order. */
  bubble(bubbleId: string, payload: unknown): void {
    this.frame('bubble', canonicalJson({ bubbleId, payload }));
  }

  /** Hash of one bubble component, already in bubble-id order. */
  bubbleDigest(digest: string): void {
    this.frame('bubble-digest', digest);
  }

  /** One dependency component. Caller supplies kind/id order. */
  dependency(value: unknown): void {
    this.frame('dependency', canonicalJson(value));
  }

  /** Completeness bit. */
  quality(value: 'complete' | 'history-only'): void {
    this.frame('quality', value);
  }

  /** Lowercase hex digest. */
  digest(): string {
    return this.hash.digest('hex');
  }

  /** SHA-256 of one bubble payload, used as a disk-sorted component. */
  static bubbleComponent(bubbleId: string, payload: unknown): string {
    return createHash('sha256')
      .update(canonicalJson({ bubbleId, payload }), 'utf8')
      .digest('hex');
  }

  /** Mix one labeled string into the snapshot hash. */
  private frame(type: string, text: string): void {
    const kind = Buffer.from(type, 'utf8');
    const body = Buffer.from(text, 'utf8');
    const len = Buffer.alloc(8);

    len.writeUInt32BE(kind.length, 0);
    len.writeUInt32BE(body.length, 4);
    this.hash.update(kind);
    this.hash.update(len);
    this.hash.update(body);
  }
}
