import test from 'node:test';
import assert from 'node:assert/strict';
import { fileUriMetadata } from '../src/file-uri';

test('Windows drive and UNC file metadata preserve native paths and escape URI components', () => {
  const drive = fileUriMetadata(
    { scheme: 'file', authority: '', path: '/C:/Users/Oleg/Проект #1' },
    'win32',
  );
  assert.equal(drive.fsPath, 'C:\\Users\\Oleg\\Проект #1');
  assert.equal(new URL(drive.external).hash, '');
  assert.equal(
    decodeURIComponent(new URL(drive.external).pathname),
    '/C:/Users/Oleg/Проект #1',
  );
  const unc = fileUriMetadata(
    { scheme: 'file', authority: 'server', path: '/share/My Project' },
    'win32',
  );
  assert.equal(unc.fsPath, '\\\\server\\share\\My Project');
  assert.equal(unc.external, 'file://server/share/My%20Project');
});

test('POSIX paths preserve percent signs and reserved URI characters without changing identity', () => {
  const uri = { scheme: 'file', authority: '', path: '/home/oleg/a%b?c#d' };
  const before = { ...uri };
  const metadata = fileUriMetadata(uri, 'linux');
  assert.equal(metadata.fsPath, uri.path);
  assert.equal(metadata.external, 'file:///home/oleg/a%25b%3Fc%23d');
  assert.deepEqual(uri, before);
});
