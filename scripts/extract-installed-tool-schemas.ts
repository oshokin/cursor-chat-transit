/** Generate public protobuf metadata; never reads profile or conversation data. */
import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync(
  '/usr/share/cursor/resources/app/out/vs/workbench/workbench.desktop.main.js',
  'utf8',
);

const definitions = new Map<string, { name: string; body: string }>();

// protobuf-es implements these well-known messages as classes, not factories.
definitions.set('R_', {
  name: 'google.protobuf.Struct',
  body: '{no:1,name:"fields",kind:"map",K:9,V:{kind:"message",T:QQ}}',
});

definitions.set('QQ', {
  name: 'google.protobuf.Value',
  body: '{no:1,name:"null_value",kind:"enum",T:Null,oneof:"kind"},{no:2,name:"number_value",kind:"scalar",T:1,oneof:"kind"},{no:3,name:"string_value",kind:"scalar",T:9,oneof:"kind"},{no:4,name:"bool_value",kind:"scalar",T:8,oneof:"kind"},{no:5,name:"struct_value",kind:"message",T:R_,oneof:"kind"},{no:6,name:"list_value",kind:"message",T:Xks,oneof:"kind"}',
});

definitions.set('Xks', {
  name: 'google.protobuf.ListValue',
  body: '{no:1,name:"values",kind:"message",T:QQ,repeated:!0}',
});

for (const match of source.matchAll(
  /([\w$]+)=\w+\.makeMessageType\("([^"]+)",(?:\(\)=>)?\[([^\]]*)\](?:,\{localName:"[^"]+"\})?\)/g,
)) {
  definitions.set(match[1]!, { name: match[2]!, body: match[3]! });
}

type Field = {
  no: number;
  name: string;
  wire: number;
  message?: string;
  oneof?: string;
  repeated?: boolean;
  packed?: boolean;
};

const result: Record<string, Field[]> = {};
const pending = ['xm'];
const visited = new Set<string>();

while (pending.length) {
  const alias = pending.pop()!;

  if (visited.has(alias)) continue;
  visited.add(alias);
  const definition = definitions.get(alias);

  if (!definition) throw new Error(`Unresolved installed message ${alias}`);
  const fields: Field[] = [];

  for (const match of definition.body.matchAll(
    /\{no:(\d+),name:"([^"]+)",kind:"(scalar|enum|message|map)",([^]*?)(?=\},\{no:|\}$)/g,
  )) {
    const tail = match[4]!;
    const kind = match[3]!;
    const type = /(?:^|,)T:([\w$]+)/.exec(tail)?.[1];

    const field: Field = {
      no: Number(match[1]),
      name: match[2]!,
      wire:
        kind === 'message' || kind === 'map'
          ? 2
          : kind === 'enum'
            ? 0
            : type === '9' || type === '12'
              ? 2
              : type === '1' || type === '6' || type === '16'
                ? 1
                : type === '2' || type === '7' || type === '15'
                  ? 5
                  : 0,
    };

    const oneof = /oneof:"([^"]+)"/.exec(tail)?.[1];

    if (oneof) field.oneof = oneof;
    if (tail.includes('repeated:!0')) field.repeated = true;
    if (field.repeated && field.wire !== 2) field.packed = true;

    if (kind === 'message') {
      const nested = definitions.get(type!);

      if (!nested)
        throw new Error(`Unresolved ${definition.name}.${field.name}`);
      field.message = nested.name;
      pending.push(type!);
    }

    // Maps are explicit protobuf entry messages, including message-valued maps.
    if (kind === 'map') {
      const value = /V:\{kind:"(message|scalar|enum)",T:([\w$]+)/.exec(tail);
      const mapName = `${definition.name}.${field.name}Entry`;
      const valueMessage = value?.[1] === 'message';
      const nested = valueMessage ? definitions.get(value![2]!) : undefined;

      if (valueMessage && !nested) throw new Error(`Unresolved map ${mapName}`);
      field.message = mapName;
      field.repeated = true;

      result[mapName] = [
        { no: 1, name: 'key', wire: 2 },
        {
          no: 2,
          name: 'value',
          wire:
            valueMessage || value?.[2] === '9' || value?.[2] === '12' ? 2 : 0,
          ...(nested ? { message: nested.name } : {}),
        },
      ];

      if (valueMessage) pending.push(value![2]!);
    }

    fields.push(field);
  }

  const declared = [...definition.body.matchAll(/\{no:/g)].length;

  if (fields.length !== declared)
    throw new Error(
      `Incomplete extraction ${definition.name}: ${fields.length}/${declared}`,
    );
  result[definition.name] = fields;
}

writeFileSync(
  'src/cursor-tool-schemas.json',
  `${JSON.stringify(Object.fromEntries(Object.entries(result).sort()), null, 2)}\n`,
);

console.log(
  JSON.stringify({
    schemas: Object.keys(result).length,
    fields: Object.values(result).flat().length,
  }),
);
