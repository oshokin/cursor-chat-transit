import schemas from './cursor-tool-schemas.json';
import { readFields } from './conversation-state';

/** Public installed Cursor 3.29.9 protobuf metadata, not private chat content. */
interface Field {
  no: number;
  name: string;
  wire: number;
  message?: string;
  oneof?: string;
  repeated?: boolean;
  packed?: boolean;
}

/** Explicit persisted blob references; inline bytes and output hashes stay opaque. */
const roles: Record<string, 'scan' | 'step'> = {
  'agent.v1.ReadToolSuccess.data_blob_id': 'scan',
  'agent.v1.ReadToolSuccess.content_blob_id': 'scan',
  'agent.v1.TruncatedToolCall.original_step_blob_id': 'step',
};

/** Validate every reachable declared wrapper and collect only evidenced blob ids. */
export function toolSchemaRefs(bytes: Buffer) {
  const refs: { digest: string; kind: 'scan' | 'step'; required: boolean }[] =
    [];

  let count = 0;

  const visit = (name: string, payload: Buffer, depth: number): void => {
    if (depth > 64) throw new Error('Tool schema depth limit.');
    const fields = (schemas as Record<string, Field[]>)[name];

    if (!fields) throw new Error(`Unsupported installed schema ${name}.`);
    const oneofs = new Set<string>();
    const singles = new Set<number>();

    for (const row of readFields(payload)) {
      if (++count > 100_000) throw new Error('Tool schema field limit.');
      const field = fields.find((candidate) => candidate.no === row.field);

      if (!field) throw new Error(`Unknown ${name} field ${row.field}.`);
      if (row.wire !== field.wire && !(field.packed && row.wire === 2))
        throw new Error(`Invalid ${name}.${field.name} wire type.`);
      if (!field.repeated && singles.has(field.no))
        throw new Error(`Repeated singular ${name}.${field.name}.`);
      singles.add(field.no);

      if (field.oneof) {
        if (oneofs.has(field.oneof))
          throw new Error(`Ambiguous ${name} oneof.`);
        oneofs.add(field.oneof);
      }

      const role = roles[`${name}.${field.name}`];

      if (role && row.bytes.length) {
        if (row.bytes.length !== 32)
          throw new Error(`Invalid ${name} blob id.`);

        refs.push({
          digest: row.bytes.toString('hex'),
          kind: role,
          required: true,
        });
      } else if (field.message) visit(field.message, row.bytes, depth + 1);
    }
  };

  visit('agent.v1.ToolCall', bytes, 0);

  return refs;
}
