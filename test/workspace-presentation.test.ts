import test from 'node:test';
import assert from 'node:assert/strict';
import { sshDisplayHost } from '../src/workspace-presentation';
import { uriFromString } from '../src/core';

test('decode SSH display aliases and hex JSON without changing connection identity', () => {
  const hex = Buffer.from(
    JSON.stringify({ hostName: 'oshokin-laptop' }),
  ).toString('hex');

  assert.equal(sshDisplayHost(`ssh-remote%2B${hex}`), 'oshokin-laptop');
  assert.equal(sshDisplayHost('ssh-remote+my-host'), 'my-host');
  assert.equal(sshDisplayHost('wsl+Ubuntu'), undefined);
  assert.equal(sshDisplayHost('ssh-remote+7b00'), undefined);
  assert.equal(sshDisplayHost('ssh-remote%xx'), undefined);
  assert.equal(sshDisplayHost('ssh-remote+$(zap)'), undefined);
});

test('authority percent decoding happens once at URI parsing boundary', () => {
  assert.equal(
    uriFromString('vscode-remote://ssh-remote%2Bhost/repo').authority,
    'ssh-remote+host',
  );

  assert.equal(
    uriFromString('vscode-remote://ssh-remote%252Bhost/repo').authority,
    'ssh-remote%2Bhost',
  );
});
