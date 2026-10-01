import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { releaseNotes } from './changelog-section';
import { stableVersion } from './stable-version';

/** One HTTP exchange with the GitHub API. */
export interface GitHubResponse {
  /** HTTP status code. */
  status: number;
  /** Response body. Empty when the server sent none. */
  body: Buffer;
}

/** Minimal client so tests can simulate tag and release state. */
export interface GitHubClient {
  /** Perform one request. Network failures reject; they are not a 404. */
  request(
    /** HTTP method. */
    method: string,
    /** Absolute GitHub API URL. */
    url: string,
    /** JSON text or raw asset bytes. */
    body?: Buffer | string,
    /** Headers that override the client defaults. */
    headers?: Record<string, string>,
  ): Promise<GitHubResponse>;
}

/** Release asset metadata returned by the GitHub API. */
interface Asset {
  /** Asset id used to download the bytes. */
  id: number;
  /** File name shown on the release. */
  name: string;
}

/** Release metadata this publisher needs. */
interface Release {
  /** Release id. */
  id: number;
  /** Tag name, including the `v` prefix. */
  tag_name: string;
  /** True while the release is still a draft. */
  draft: boolean;
  /** Browser URL of the release. */
  html_url: string;
  /** Files already attached to the release. */
  assets: Asset[];
}

/** Local files that must match the release assets. */
interface LocalAsset {
  /** Asset file name. */
  name: string;
  /** Exact bytes to upload or compare. */
  bytes: Buffer;
}

/** Inputs for one publication of an already built VSIX. */
export interface PublishInput {
  /** `owner/repo`. */
  repository: string;
  /** Commit that passed CI. The tag must point here. */
  sha: string;
  /** Stable `X.Y.Z` version already recorded in package.json. */
  version: string;
  /** Release notes, including the install steps. */
  notes: string;
  /** Versioned VSIX bytes. */
  vsix: Buffer;
  /** `sha256sum` output for that VSIX. */
  sums: Buffer;
  /** GitHub API client. */
  client: GitHubClient;
}

/** SHA-256 hex digest of a buffer. */
function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Parse a JSON body or explain that the response was not JSON. */
function jsonBody<T>(response: GitHubResponse, what: string): T {
  try {
    return JSON.parse(response.body.toString('utf8')) as T;
  } catch {
    throw new Error(
      `GitHub ${what} returned ${response.status} with a non-JSON body.`,
    );
  }
}

/** 403 and 5xx are errors, including when a later read might have been a 404. */
async function send(
  client: GitHubClient,
  method: string,
  url: string,
  body?: Buffer | string,
  headers?: Record<string, string>,
): Promise<GitHubResponse> {
  const response = await client.request(method, url, body, headers);

  if (
    response.status === 403 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    throw new Error(
      `GitHub API ${response.status} for ${method} ${url}. Not treating this as a missing release.`,
    );
  }

  return response;
}

/** API prefix for this repository. */
function api(repository: string): string {
  return `https://api.github.com/repos/${repository}`;
}

/** Commit SHA for a tag, or null when the tag ref does not exist. */
async function tagCommit(
  client: GitHubClient,
  repository: string,
  tag: string,
): Promise<string | null> {
  const response = await send(
    client,
    'GET',
    `${api(repository)}/git/ref/tags/${encodeURIComponent(tag)}`,
  );

  if (response.status === 404) return null;

  if (response.status !== 200) {
    throw new Error(
      `Unexpected GitHub status ${response.status} while reading ${tag}.`,
    );
  }

  const ref = jsonBody<{ object?: { sha?: string; type?: string } }>(
    response,
    `ref ${tag}`,
  );

  const object = ref.object;

  if (!object?.sha || !object.type) {
    throw new Error(`GitHub ref ${tag} has no object.`);
  }

  if (object.type === 'commit') return object.sha;

  if (object.type !== 'tag') {
    throw new Error(
      `GitHub ref ${tag} points at ${object.type}, not a commit.`,
    );
  }

  const annotated = await send(
    client,
    'GET',
    `${api(repository)}/git/tags/${object.sha}`,
  );

  if (annotated.status !== 200) {
    throw new Error(
      `Unexpected GitHub status ${annotated.status} while reading annotated tag ${tag}.`,
    );
  }

  const tagObject = jsonBody<{ object?: { sha?: string; type?: string } }>(
    annotated,
    `tag ${tag}`,
  );

  if (tagObject.object?.type !== 'commit' || !tagObject.object.sha) {
    throw new Error(`Annotated tag ${tag} does not point at a commit.`);
  }

  return tagObject.object.sha;
}

/** Release for a tag, or null when GitHub has no such release. */
async function releaseByTag(
  client: GitHubClient,
  repository: string,
  tag: string,
): Promise<Release | null> {
  const response = await send(
    client,
    'GET',
    `${api(repository)}/releases/tags/${encodeURIComponent(tag)}`,
  );

  if (response.status === 404) return findDraft(client, repository, tag);

  if (response.status !== 200) {
    throw new Error(
      `Unexpected GitHub status ${response.status} while reading release ${tag}.`,
    );
  }

  return jsonBody<Release>(response, `release ${tag}`);
}

/** Published-by-tag lookup excludes drafts; enumerate authenticated releases on 404. */
async function findDraft(
  client: GitHubClient,
  repository: string,
  tag: string,
): Promise<Release | null> {
  for (let page = 1; ; page++) {
    const response = await send(
      client,
      'GET',
      `${api(repository)}/releases?per_page=100&page=${page}`,
    );

    if (response.status !== 200) {
      throw new Error(
        `Cannot list releases: GitHub returned ${response.status}.`,
      );
    }

    const releases = jsonBody<Release[]>(response, 'release list');

    if (!Array.isArray(releases))
      throw new Error('GitHub release list is not an array.');
    const found = releases.filter((release) => release.tag_name === tag);

    if (found.length > 1)
      throw new Error(`Multiple releases found for ${tag}.`);
    if (found[0]) return found[0];
    if (releases.length < 100) return null;
  }
}

/** Download one asset. A transport error is rethrown, not treated as absence. */
async function downloadAsset(
  client: GitHubClient,
  repository: string,
  asset: Asset,
): Promise<Buffer> {
  const response = await send(
    client,
    'GET',
    `${api(repository)}/releases/assets/${asset.id}`,
    undefined,
    { accept: 'application/octet-stream' },
  );

  if (response.status !== 200) {
    throw new Error(
      `Unexpected GitHub status ${response.status} while downloading ${asset.name}.`,
    );
  }

  return response.body;
}

/** Create the tag, then read it back. A failed read after a write is not success. */
async function ensureTag(
  client: GitHubClient,
  repository: string,
  tag: string,
  sha: string,
): Promise<void> {
  const existing = await tagCommit(client, repository, tag);

  if (existing === sha) return;

  if (existing) {
    throw new Error(
      `Tag ${tag} points at ${existing}, not ${sha}. Refusing to move it.`,
    );
  }

  let writeError: unknown;

  try {
    const created = await send(
      client,
      'POST',
      `${api(repository)}/git/refs`,
      JSON.stringify({ ref: `refs/tags/${tag}`, sha }),
      { 'content-type': 'application/json' },
    );

    if (created.status !== 201) {
      writeError = new Error(`Creating tag ${tag} returned ${created.status}.`);
    }
  } catch (error) {
    writeError = error;
  }

  let current: string | null;

  try {
    current = await tagCommit(client, repository, tag);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new Error(
      `Tag ${tag} write result is unknown, and reading it back failed. ${reason}`,
      { cause: error },
    );
  }

  if (current === sha) return;

  if (current) {
    throw new Error(
      `Tag ${tag} points at ${current}, not ${sha}. Refusing to move it.`,
    );
  }

  throw writeError instanceof Error
    ? writeError
    : new Error(`Tag ${tag} was not created.`);
}

/** Create a draft, then read it back before uploading files. */
async function ensureDraft(
  client: GitHubClient,
  input: PublishInput,
  tag: string,
): Promise<Release> {
  const existing = await releaseByTag(client, input.repository, tag);

  if (existing) return existing;
  let writeError: unknown;

  try {
    const created = await send(
      client,
      'POST',
      `${api(input.repository)}/releases`,
      JSON.stringify({
        tag_name: tag,
        target_commitish: input.sha,
        name: `Cursor Chat Transit v${input.version}`,
        body: input.notes,
        draft: true,
        prerelease: false,
      }),
      { 'content-type': 'application/json' },
    );

    if (created.status !== 201) {
      writeError = new Error(
        `Creating release ${tag} returned ${created.status}.`,
      );
    }
  } catch (error) {
    writeError = error;
  }

  let release: Release | null;

  try {
    release = await releaseByTag(client, input.repository, tag);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new Error(
      `Release ${tag} write result is unknown, and reading it back failed. ${reason}`,
      { cause: error },
    );
  }

  if (release) return release;

  throw writeError instanceof Error
    ? writeError
    : new Error(`Release ${tag} was not created.`);
}

/** Upload one missing asset, then download it and compare bytes. */
async function uploadAsset(
  client: GitHubClient,
  repository: string,
  release: Release,
  file: LocalAsset,
): Promise<void> {
  let writeError: unknown;

  try {
    const uploaded = await send(
      client,
      'POST',
      `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`,
      file.bytes,
      { 'content-type': 'application/octet-stream' },
    );

    if (uploaded.status !== 201) {
      writeError = new Error(
        `Uploading ${file.name} returned ${uploaded.status}.`,
      );
    }
  } catch (error) {
    writeError = error;
  }

  const fresh = await releaseByTag(client, repository, release.tag_name);
  const asset = fresh?.assets.find((item) => item.name === file.name);

  if (!asset) {
    throw writeError instanceof Error
      ? writeError
      : new Error(`Upload of ${file.name} did not appear on the release.`);
  }

  const remote = await downloadAsset(client, repository, asset);

  if (!remote.equals(file.bytes)) {
    throw new Error(
      `Asset ${file.name} is on the release with different bytes. Not overwriting it.`,
    );
  }
}

/** Keep an existing matching asset. Stop when the same name has different bytes. */
async function ensureAsset(
  client: GitHubClient,
  repository: string,
  release: Release,
  file: LocalAsset,
): Promise<void> {
  const asset = release.assets.find((item) => item.name === file.name);

  if (!asset) {
    await uploadAsset(client, repository, release, file);

    return;
  }

  const remote = await downloadAsset(client, repository, asset);

  if (!remote.equals(file.bytes)) {
    throw new Error(
      `Asset ${file.name} already exists with different bytes. Not overwriting it.`,
    );
  }
}

/** Check a published VSIX against the checksum file published beside it. */
async function verifyPublished(
  client: GitHubClient,
  repository: string,
  release: Release,
  tag: string,
  sha: string,
): Promise<void> {
  const tagSha = await tagCommit(client, repository, tag);

  if (tagSha !== sha) {
    throw new Error(
      `Published tag ${tag} points at ${tagSha ?? 'nothing'}, not ${sha}.`,
    );
  }

  const sumsAsset = release.assets.find((item) => item.name === 'SHA256SUMS');

  const vsixAsset = release.assets.find(
    (item) => item.name === `cursor-chat-transit-${tag.slice(1)}.vsix`,
  );

  if (!sumsAsset || !vsixAsset) {
    throw new Error(
      `Published release ${tag} is missing the VSIX or SHA256SUMS.`,
    );
  }

  const sums = await downloadAsset(client, repository, sumsAsset);
  const vsix = await downloadAsset(client, repository, vsixAsset);

  const expected = new RegExp(
    `^${digest(vsix)} [ *]${vsixAsset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    'm',
  );

  if (!expected.test(sums.toString('utf8'))) {
    throw new Error(
      `Published ${vsixAsset.name} does not match the published SHA256SUMS. Not replacing it.`,
    );
  }
}

/** Mark a draft public, then read it back. */
async function publishDraft(
  client: GitHubClient,
  repository: string,
  release: Release,
): Promise<Release> {
  let writeError: unknown;

  try {
    const updated = await send(
      client,
      'PATCH',
      `${api(repository)}/releases/${release.id}`,
      JSON.stringify({ draft: false }),
      { 'content-type': 'application/json' },
    );

    if (updated.status !== 200) {
      writeError = new Error(
        `Publishing release ${release.tag_name} returned ${updated.status}.`,
      );
    }
  } catch (error) {
    writeError = error;
  }

  const fresh = await releaseByTag(client, repository, release.tag_name);

  if (!fresh) {
    throw new Error(
      `Release ${release.tag_name} could not be read after publish.`,
    );
  }

  if (fresh.draft) {
    throw writeError instanceof Error
      ? writeError
      : new Error(`Release ${release.tag_name} is still a draft.`);
  }

  return fresh;
}

/**
 * Create or continue the GitHub Release for this exact commit and version.
 * Does not move an existing tag or replace an asset that has different bytes.
 */
export async function publishRelease(input: PublishInput): Promise<string> {
  if (!stableVersion(input.version)) {
    throw new Error(
      `Version ${input.version} is not a stable X.Y.Z. Not publishing.`,
    );
  }

  const tag = `v${input.version}`;
  const vsixName = `cursor-chat-transit-${input.version}.vsix`;
  const sumsText = input.sums.toString('utf8');

  if (
    !new RegExp(`^${digest(input.vsix)} [ *]${vsixName}$`, 'm').test(sumsText)
  ) {
    throw new Error(`SHA256SUMS does not describe ${vsixName}.`);
  }

  await ensureTag(input.client, input.repository, tag, input.sha);
  const existing = await releaseByTag(input.client, input.repository, tag);

  if (existing && !existing.draft) {
    await verifyPublished(
      input.client,
      input.repository,
      existing,
      tag,
      input.sha,
    );

    return existing.html_url;
  }

  const draft = existing ?? (await ensureDraft(input.client, input, tag));

  if (!draft.draft) {
    await verifyPublished(
      input.client,
      input.repository,
      draft,
      tag,
      input.sha,
    );

    return draft.html_url;
  }

  const files: LocalAsset[] = [
    { name: vsixName, bytes: input.vsix },
    { name: 'SHA256SUMS', bytes: input.sums },
  ];

  for (const file of files) {
    await ensureAsset(input.client, input.repository, draft, file);
  }

  const published = await publishDraft(input.client, input.repository, draft);

  await verifyPublished(
    input.client,
    input.repository,
    published,
    tag,
    input.sha,
  );

  return published.html_url;
}

/** Workflow summary after a release is published or confirmed. */
export function publishedReleaseSummary(input: {
  /** Recorded package version. */
  version: string;
  /** Commit that owns the tag. */
  sha: string;
  /** Browser URL of the published release. */
  url: string;
  /** VSIX file name attached to the release. */
  vsixName: string;
}): string {
  return [
    '### Release',
    '',
    `- Version: \`${input.version}\``,
    `- Commit: \`${input.sha}\``,
    `- Release: ${input.url}`,
    `- VSIX: \`${input.vsixName}\``,
    '',
  ].join('\n');
}

/** Real GitHub client. Timeouts and transport errors reject. */
export function githubClient(token: string): GitHubClient {
  return {
    /** Send one GitHub request and return its status and body. */
    async request(method, url, body, headers) {
      const response = await fetch(url, {
        method,
        body,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'cursor-chat-transit',
          'x-github-api-version': '2022-11-28',
          ...headers,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });

      return {
        status: response.status,
        body: Buffer.from(await response.arrayBuffer()),
      };
    },
  };
}

/** Publish the artifact downloaded for this workflow run. */
async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const artifactDir = process.env.ARTIFACT_DIR;
  const root = process.cwd();

  if (!token || !repository || !sha || !artifactDir) {
    throw new Error(
      'GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, and ARTIFACT_DIR are required.',
    );
  }

  const version = (
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;

  const vsixName = `cursor-chat-transit-${version}.vsix`;

  const notes = releaseNotes(
    fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'),
    version,
  );

  const url = await publishRelease({
    repository,
    sha,
    version,
    notes,
    vsix: fs.readFileSync(path.join(artifactDir, vsixName)),
    sums: fs.readFileSync(path.join(artifactDir, 'SHA256SUMS')),
    client: githubClient(token),
  });

  console.log(url);

  const summary = process.env.GITHUB_STEP_SUMMARY;

  if (summary) {
    fs.appendFileSync(
      summary,
      publishedReleaseSummary({
        version,
        sha,
        url,
        vsixName,
      }),
    );
  }
}

/** Absolute path of this file when it is the process entry point. */
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (entry.endsWith(`${path.sep}publish-release.ts`)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
