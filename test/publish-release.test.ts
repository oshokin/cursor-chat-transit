import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  publishedReleaseSummary,
  publishRelease,
  type GitHubClient,
  type GitHubResponse,
} from '../scripts/publish-release';
import { changelogSection, releaseNotes } from '../scripts/changelog-section';

/** In-memory GitHub state for one repository. */
interface State {
  /** Commit the tag points at, if the tag exists. */
  tagSha: string | null;
  /** Release stored for that tag. */
  release: {
    /** Release id. */
    id: number;
    /** True while the release is still a draft. */
    draft: boolean;
    /** Browser URL of the release. */
    html_url: string;
    /** Files already attached to the release. */
    assets: {
      /** Asset id used to download the bytes. */
      id: number;
      /** File name shown on the release. */
      name: string;
      /** Exact bytes stored for that file. */
      bytes: Buffer;
    }[];
  } | null;
  /** Status to return for the next tag read, when set. */
  tagStatus?: number;
  /** Reject the next tag creation, as a dropped connection would. */
  failTagWrite?: boolean;
  /** Title sent when a release is created. */
  releaseName?: string;
  /** Omit drafts from the release list, as an unauthenticated list does. */
  hideDraftsInList?: boolean;
}

/** Route one request against the in-memory release. */
function client(state: State): GitHubClient {
  let nextAsset = 1;

  return {
    /** Route one request against the in-memory release. */
    async request(method, url, body): Promise<GitHubResponse> {
      /** JSON response with the given status. */
      const json = (status: number, value: unknown): GitHubResponse => ({
        status,
        body: Buffer.from(JSON.stringify(value)),
      });

      if (method === 'GET' && url.includes('/git/ref/tags/')) {
        if (state.tagStatus) {
          const status = state.tagStatus;

          state.tagStatus = undefined;

          return { status, body: Buffer.from('unavailable') };
        }

        if (!state.tagSha) return { status: 404, body: Buffer.from('missing') };

        return json(200, {
          object: { type: 'commit', sha: state.tagSha },
        });
      }

      if (method === 'PATCH' && url.includes('/git/refs/tags/')) {
        const parsed = JSON.parse(String(body)) as { sha?: string };

        if (!parsed.sha)
          return { status: 422, body: Buffer.from('missing sha') };

        state.tagSha = parsed.sha;

        return json(200, { ref: `refs/tags/${url.split('/').pop()}` });
      }

      if (method === 'DELETE' && /\/releases\/\d+$/.test(url)) {
        const id = Number(url.split('/').pop());

        if (state.release?.id === id) state.release = null;

        return { status: 204, body: Buffer.alloc(0) };
      }

      if (method === 'POST' && url.endsWith('/git/refs')) {
        if (state.failTagWrite) {
          state.failTagWrite = false;
          state.tagSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

          throw new Error('socket hang up');
        }

        const parsed = JSON.parse(String(body)) as { sha: string };

        state.tagSha = parsed.sha;

        return json(201, { ref: 'refs/tags/v1.0.1' });
      }

      if (method === 'GET' && url.includes('/releases/tags/')) {
        if (!state.release || state.release.draft)
          return { status: 404, body: Buffer.from('missing') };

        return json(200, {
          id: state.release.id,
          tag_name: 'v1.0.1',
          draft: state.release.draft,
          html_url: state.release.html_url,
          assets: state.release.assets.map((asset) => ({
            id: asset.id,
            name: asset.name,
          })),
        });
      }

      if (method === 'GET' && /\/releases\/\d+$/.test(url)) {
        const id = Number(url.split('/').pop());

        if (!state.release || state.release.id !== id) {
          return { status: 404, body: Buffer.from('missing') };
        }

        return json(200, {
          id: state.release.id,
          tag_name: 'v1.0.1',
          draft: state.release.draft,
          html_url: state.release.html_url,
          assets: state.release.assets.map((asset) => ({
            id: asset.id,
            name: asset.name,
          })),
        });
      }

      if (method === 'GET' && url.includes('/releases?')) {
        const visible =
          state.release && !(state.release.draft && state.hideDraftsInList);

        return json(
          200,
          visible && state.release
            ? [
                {
                  ...state.release,
                  tag_name: 'v1.0.1',
                  assets: state.release.assets.map(({ id, name }) => ({
                    id,
                    name,
                  })),
                },
              ]
            : [],
        );
      }

      if (method === 'POST' && url.endsWith('/releases')) {
        const parsed = JSON.parse(String(body)) as { name?: string };

        state.releaseName = parsed.name;

        state.release = {
          id: 7,
          draft: true,
          html_url: 'https://github.com/example/repo/releases/tag/v1.0.1',
          assets: [],
        };

        return json(201, { id: 7 });
      }

      if (method === 'POST' && url.includes('/assets?name=')) {
        const name = decodeURIComponent(url.split('name=')[1] || '');

        state.release?.assets.push({
          id: nextAsset,
          name,
          bytes: Buffer.from(body as Buffer),
        });

        nextAsset += 1;

        return json(201, { name });
      }

      if (method === 'GET' && url.includes('/releases/assets/')) {
        const id = Number(url.split('/').pop());
        const asset = state.release?.assets.find((item) => item.id === id);

        if (!asset) return { status: 404, body: Buffer.from('missing') };

        return { status: 200, body: asset.bytes };
      }

      if (method === 'PATCH' && url.includes('/releases/')) {
        if (state.release) state.release.draft = false;

        return json(200, { draft: false });
      }

      throw new Error(`unexpected ${method} ${url}`);
    },
  };
}

/** Bytes the publisher uploads for one version. */
interface PackedFiles {
  /** Versioned VSIX contents. */
  vsix: Buffer;
  /** `sha256sum` output for that VSIX. */
  sums: Buffer;
}

/** VSIX bytes and a matching SHA256SUMS buffer. */
function files(): PackedFiles {
  const vsix = Buffer.from('vsix-bytes');
  const hash = createHash('sha256').update(vsix).digest('hex');

  return {
    vsix,
    sums: Buffer.from(`${hash}  cursor-chat-transit-1.0.1.vsix\n`),
  };
}

/** Publish input with the shared fixture bytes. */
function input(state: State) {
  const packed = files();

  return {
    repository: 'example/repo',
    sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    version: '1.0.1',
    notes: '## 1.0.1\n\n- Fixed\n',
    vsix: packed.vsix,
    sums: packed.sums,
    client: client(state),
  };
}

test('the first publication creates a tag, uploads both files, and publishes the draft', async () => {
  const state: State = {
    tagSha: null,
    release: null,
    hideDraftsInList: true,
  };

  const url = await publishRelease(input(state));

  assert.equal(url, 'https://github.com/example/repo/releases/tag/v1.0.1');
  assert.equal(state.releaseName, 'v1.0.1');
  assert.equal(state.tagSha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(state.release?.draft, false);

  assert.deepEqual(state.release?.assets.map((asset) => asset.name).sort(), [
    'SHA256SUMS',
    'cursor-chat-transit-1.0.1.vsix',
  ]);
});

test('an unpublished tag on another commit moves to this commit', async () => {
  const state: State = {
    tagSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    release: {
      id: 4,
      draft: true,
      html_url: 'https://github.com/example/repo/releases/tag/v1.0.1',
      assets: [
        {
          id: 3,
          name: 'cursor-chat-transit-1.0.1.vsix',
          bytes: Buffer.from('old-candidate'),
        },
      ],
    },
  };

  const url = await publishRelease(input(state));

  assert.equal(url, 'https://github.com/example/repo/releases/tag/v1.0.1');
  assert.equal(state.tagSha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(state.release?.draft, false);

  assert.equal(
    state.release?.assets.some(
      (asset) => asset.bytes.toString() === 'old-candidate',
    ),
    false,
  );
});

test('a published release on another commit is not moved', async () => {
  const packed = files();

  const state: State = {
    tagSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    release: {
      id: 7,
      draft: false,
      html_url: 'https://github.com/example/repo/releases/tag/v1.0.1',
      assets: [
        { id: 3, name: 'cursor-chat-transit-1.0.1.vsix', bytes: packed.vsix },
        { id: 4, name: 'SHA256SUMS', bytes: packed.sums },
      ],
    },
  };

  await assert.rejects(
    () => publishRelease(input(state)),
    /Refusing to move it/,
  );

  assert.equal(state.tagSha, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(state.release?.draft, false);
});

test('an API 500 is not treated as a missing tag', async () => {
  const state: State = { tagSha: null, release: null, tagStatus: 500 };

  await assert.rejects(
    () => publishRelease(input(state)),
    /Not treating this as a missing release/,
  );
});

test('a dropped tag write is reconciled by reading the tag back', async () => {
  const state: State = { tagSha: null, release: null, failTagWrite: true };
  const url = await publishRelease(input(state));

  assert.match(url, /releases\/tag\/v1\.0\.1/);
  assert.equal(state.release?.draft, false);
});

test('an existing draft uploads only the missing asset', async () => {
  const packed = files();

  const state: State = {
    tagSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    release: {
      id: 7,
      draft: true,
      html_url: 'https://github.com/example/repo/releases/tag/v1.0.1',
      assets: [
        {
          id: 3,
          name: 'cursor-chat-transit-1.0.1.vsix',
          bytes: packed.vsix,
        },
      ],
    },
  };

  await publishRelease(input(state));
  assert.equal(state.release?.assets.length, 2);
  assert.equal(state.release?.draft, false);
});

test('different bytes for an existing asset are not replaced', async () => {
  const state: State = {
    tagSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    release: {
      id: 7,
      draft: true,
      html_url: 'https://github.com/example/repo/releases/tag/v1.0.1',
      assets: [
        {
          id: 3,
          name: 'cursor-chat-transit-1.0.1.vsix',
          bytes: Buffer.from('other'),
        },
      ],
    },
  };

  await assert.rejects(() => publishRelease(input(state)), /different bytes/);
  assert.equal(state.release?.assets.length, 1);
  assert.equal(state.release?.draft, true);
});

test('a published release is returned without uploading again', async () => {
  const packed = files();

  const state: State = {
    tagSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    release: {
      id: 7,
      draft: false,
      html_url: 'https://github.com/example/repo/releases/tag/v1.0.1',
      assets: [
        { id: 3, name: 'cursor-chat-transit-1.0.1.vsix', bytes: packed.vsix },
        { id: 4, name: 'SHA256SUMS', bytes: packed.sums },
      ],
    },
  };

  const release = state.release;

  assert.ok(release);
  const before = release.assets.length;

  const url = await publishRelease({
    ...input(state),
    vsix: Buffer.from('rebuilt-bytes-must-not-replace'),
    sums: Buffer.from(
      `${createHash('sha256').update('rebuilt-bytes-must-not-replace').digest('hex')}  cursor-chat-transit-1.0.1.vsix\n`,
    ),
  });

  assert.equal(url, release.html_url);
  assert.equal(release.assets.length, before);
  assert.equal(release.assets[0]?.bytes.toString(), 'vsix-bytes');
});

test('changelog notes keep one non-empty top section and add install steps', () => {
  const markdown = `# Changelog

## [1.0.1](https://example.test/compare) (2026-10-01)

### Bug Fixes

* correct a path

## 1.0.0

- Original section that must survive.
`;

  assert.match(changelogSection(markdown, '1.0.1'), /## \[1\.0\.1\]/);
  assert.match(changelogSection(markdown, '1.0.1'), /correct a path/);

  const notes = releaseNotes(markdown, '1.0.1');

  assert.match(notes, /^### Bug Fixes/m);
  assert.match(notes, /correct a path/);
  assert.match(notes, /Install from VSIX/);
  assert.doesNotMatch(notes, /^## \[1\.0\.1\]/m);

  assert.throws(
    () => changelogSection('## 1.0.0\n\n## 1.0.1\n\n- later\n', '1.0.1'),
    /must open with/,
  );

  assert.throws(
    () =>
      changelogSection('## 1.0.1\n\n- first\n\n## 1.0.1\n\n- again\n', '1.0.1'),
    /2 sections/,
  );

  assert.throws(() => changelogSection('## 1.0.1\n\n\n', '1.0.1'), /empty/);
});

test('a published release summary names the version, commit, URL, and VSIX', () => {
  const summary = publishedReleaseSummary({
    version: '1.0.1',
    sha: 'abc123',
    url: 'https://github.com/example/repo/releases/tag/v1.0.1',
    vsixName: 'cursor-chat-transit-1.0.1.vsix',
  });

  assert.match(summary, /Version: `1\.0\.1`/);
  assert.match(summary, /Commit: `abc123`/);
  assert.match(summary, /releases\/tag\/v1\.0\.1/);
  assert.match(summary, /cursor-chat-transit-1\.0\.1\.vsix/);
});
