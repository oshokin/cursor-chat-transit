import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { runSqlite } from './sqlite-process';
import type { SqliteConn } from './types';

/** Collect stdout into a string. */
function collectText(): { output: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const output = new Writable({
    /** Append one stdout chunk; decoding happens in `text()`. */
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return {
    /** Writable that stores stdout chunks. */
    output,
    /** UTF-8 of all collected chunks. */
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

/** Ordered sqlite3 paths: configured, PATH, then platform fallbacks. */
function candidateExecutables(configured?: string): string[] {
  const out: string[] = [];
  if (configured) return path.isAbsolute(configured) ? [configured] : [];
  const pathVar = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const ext = process.platform === 'win32' ? '.exe' : '';
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    out.push(path.join(dir, `sqlite3${ext}`));
  }
  if (process.platform === 'win32') {
    out.push(
      'C:\\sqlite3\\sqlite3.exe',
      'C:\\Program Files\\sqlite3\\sqlite3.exe',
    );
    if (process.env.USERPROFILE) {
      out.push(
        path.join(
          process.env.USERPROFILE,
          'scoop\\apps\\sqlite\\current\\sqlite3.exe',
        ),
      );
    }
  } else {
    out.push(
      '/usr/bin/sqlite3',
      '/usr/local/bin/sqlite3',
      '/opt/homebrew/bin/sqlite3',
    );
  }
  return [...new Set(out.filter(Boolean))];
}

/** Pump SQL through runSqlite and return collected stdout. */
async function runAndCollect(
  opts: SqliteConn & { sql: string; readOnly?: boolean },
): Promise<string> {
  const sink = collectText();
  await runSqlite({
    executable: opts.executable,
    database: opts.database,
    initFile: opts.initFile,
    input: opts.sql,
    output: sink.output,
    readOnly: opts.readOnly !== false,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  return sink.text();
}

/** Locate a local sqlite3 executable. */
export function findSqliteExecutable(configured?: string): string | null {
  for (const p of candidateExecutables(configured)) {
    try {
      if (fs.statSync(p).isFile()) {
        fs.accessSync(
          p,
          process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK,
        );
        return p;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

/** Write an empty `-init` file so sqlite3 does not read `~/.sqliterc`. */
export async function ensureInitFile(dir: string): Promise<string> {
  const initFile = path.join(dir, 'empty-sqliterc');
  await fs.promises.writeFile(initFile, '', { flag: 'w' });
  return initFile;
}

/** Quote a filesystem path for sqlite3 dot-commands (C-style escapes, not SQL). */
export function quoteDotPath(filePath: string): string {
  if (typeof filePath !== 'string' || !filePath || /[\0\r\n]/u.test(filePath)) {
    throw new TypeError('Invalid SQLite dot-command path');
  }
  return `"${filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Run a read query in list/tab mode. */
export async function execSql(
  opts: SqliteConn & { sql: string; readOnly?: boolean },
): Promise<string> {
  const preamble = [
    busyTimeoutCommand(opts.busyTimeoutMs),
    '.mode list',
    '.separator "\t"',
    opts.sql,
    '',
  ].join('\n');
  return runAndCollect({ ...opts, sql: preamble });
}

/** Run a mutating SQL script (no `-readonly`). */
export async function execSqlScript(
  opts: SqliteConn & { sql: string },
): Promise<string> {
  return runAndCollect({
    ...opts,
    sql: `${busyTimeoutCommand(opts.busyTimeoutMs)}\n${opts.sql}`,
    readOnly: false,
  });
}

/** Validate before embedding a value in a CLI command. Applies to every connection. */
export function busyTimeoutCommand(value = 5000): string {
  if (!Number.isInteger(value) || value < 0 || value > 30000) {
    throw new TypeError(
      'SQLite busy timeout must be an integer from 0 to 30000 ms',
    );
  }
  return `.timeout ${value}`;
}

/** `SELECT sqlite_version()` via a throwaway temp database. */
export async function sqliteVersion(
  executable: string,
  initFile: string,
  signal?: AbortSignal,
): Promise<string> {
  const tmpDb = path.join(os.tmpdir(), `cct-version-${process.pid}.db`);
  try {
    return (
      await runAndCollect({
        executable,
        database: tmpDb,
        initFile,
        sql: 'SELECT sqlite_version();\n',
        readOnly: false,
        timeoutMs: 10000,
        signal,
      })
    ).trim();
  } finally {
    try {
      fs.unlinkSync(tmpDb);
    } catch {
      /* ignore */
    }
  }
}

/** SQLite `.backup` (fail closed if the dest file is missing or empty). */
export async function backupDatabase(opts: {
  /** Absolute path of the sqlite3 executable. */
  executable: string;
  /** Database file to back up. */
  database: string;
  /** Destination backup file path. */
  dest: string;
  /** sqlite3 `-init` file that sets timeouts and modes. */
  initFile: string;
  /** Cancellation for the backup child. */
  signal?: AbortSignal;
  /** Wall-clock limit for the backup child. */
  timeoutMs?: number;
  /** SQLite busy timeout applied through the init file. */
  busyTimeoutMs?: number;
}): Promise<void> {
  await runAndCollect({
    executable: opts.executable,
    database: opts.database,
    initFile: opts.initFile,
    sql: `${busyTimeoutCommand(opts.busyTimeoutMs)}\n.backup ${quoteDotPath(opts.dest)}\n`,
    readOnly: true,
    timeoutMs: opts.timeoutMs ?? 600000,
    signal: opts.signal,
  });
}

/** Decode hex ASCII bytes to binary without creating a JS string. */
export function hexAsciiToBuffer(ascii: Buffer): Buffer {
  const len = ascii.length;
  if (!len) return Buffer.alloc(0);
  if (len % 2 !== 0) throw new Error('Odd hex length');
  const out = Buffer.allocUnsafe(len / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = fromHexDigit(ascii[i * 2]);
    const lo = fromHexDigit(ascii[i * 2 + 1]);
    if (hi < 0 || lo < 0) throw new Error('Invalid hex');
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Parse one `0-9a-fA-F` byte into a nibble, or -1. */
function fromHexDigit(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

/** ASCII tab, line feed, and carriage return used when splitting sqlite list output. */
const TAB = 0x09;
/** ASCII line feed. */
const NL = 0x0a;
/** ASCII carriage return. */
const CR = 0x0d;

/** Split a list-mode line on tabs and hex-decode each field. */
export function parseHexRowLine(line: Buffer, cols: number): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= line.length; i++) {
    if (i < line.length && line[i] !== TAB) continue;
    fields.push(hexAsciiToBuffer(line.subarray(start, i)));
    start = i + 1;
    if (fields.length === cols) break;
  }
  while (fields.length < cols) fields.push(Buffer.alloc(0));
  return fields.slice(0, cols);
}

/** Writable that hex-decodes sqlite3 list rows as they arrive (never one giant string). */
export function createHexRowParser(
  cols: number,
  onRow: (fields: Buffer[]) => void | Promise<void>,
): Writable {
  const parts: Buffer[] = [];
  let partsLen = 0;
  /** Join buffered fragments with `suffix` into one sqlite3 list line. */
  const takeLine = (suffix: Buffer): Buffer => {
    if (!partsLen) return suffix;
    const line = Buffer.concat([...parts, suffix], partsLen + suffix.length);
    parts.length = 0;
    partsLen = 0;
    return line;
  };
  /** Strip a trailing CR and decode one complete hex row. */
  const flushLine = async (line: Buffer) => {
    if (line.length && line[line.length - 1] === CR) {
      line = line.subarray(0, line.length - 1);
    }
    if (!line.length) return;
    await onRow(parseHexRowLine(line, cols));
  };
  return new Writable({
    /** Hex-decode complete lines; keep a partial line in `parts`. */
    write(chunk, _enc, cb) {
      void (async () => {
        let buf = Buffer.from(chunk);
        while (buf.length) {
          const nl = buf.indexOf(NL);
          if (nl < 0) {
            parts.push(buf);
            partsLen += buf.length;
            break;
          }
          await flushLine(takeLine(buf.subarray(0, nl)));
          buf = buf.subarray(nl + 1);
        }
      })().then(
        () => cb(),
        (err: Error) => cb(err),
      );
    },
    /** Decode a trailing fragment that was not terminated by a newline. */
    final(cb) {
      void (async () => {
        if (partsLen) await flushLine(takeLine(Buffer.alloc(0)));
      })().then(
        () => cb(),
        (err: Error) => cb(err),
      );
    },
  });
}

/** Run a hex-encoded list query and invoke `onRow` per decoded row. */
export async function execSqlHexRows(
  opts: SqliteConn & {
    sql: string;
    cols: number;
    onRow: (fields: Buffer[]) => void | Promise<void>;
  },
): Promise<void> {
  const preamble = [
    busyTimeoutCommand(opts.busyTimeoutMs),
    '.mode list',
    '.separator "\t"',
    opts.sql,
    '',
  ].join('\n');
  const output = createHexRowParser(opts.cols, opts.onRow);
  await runSqlite({
    executable: opts.executable,
    database: opts.database,
    initFile: opts.initFile,
    input: preamble,
    output,
    readOnly: opts.readOnly !== false,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
}

/** Decode a hex column from sqlite3 list mode. */
export function hexToBuffer(hex: string): Buffer {
  const clean = (hex || '').trim();
  if (!clean) return Buffer.alloc(0);
  return Buffer.from(clean, 'hex');
}

/** Split tab-separated sqlite3 list output into fixed-width rows. */
export function parseListRows(text: string, cols: number): string[][] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((line) => {
    const parts = line.split('\t');
    while (parts.length < cols) parts.push('');
    return parts.slice(0, cols);
  });
}
