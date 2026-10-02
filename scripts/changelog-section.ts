import { stableVersion } from './stable-version';

/** One changelog heading and the text that belongs to it. */
interface Section {
  /** Version parsed from the heading, when the heading has one. */
  version: string | null;
  /** Heading line, without the trailing newline. */
  heading: string;
  /** Body until the next `##` heading. */
  body: string;
}

/** Version token at the start of a changelog heading title. */
function versionInHeading(title: string): string | null {
  const match = /^(?:\[)?v?(\d+\.\d+\.\d+)(?:\])?(?:$|[\s(.])/.exec(title);

  return match?.[1] ?? null;
}

/** Split a changelog into `##` sections after the file preamble. */
function sections(markdown: string): Section[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const found: Section[] = [];
  let current: Section | null = null;
  const body: string[] = [];

  /** Store the section that just ended. */
  const flush = (): void => {
    if (!current) return;
    current.body = body.join('\n').trim();
    found.push(current);
    body.length = 0;
  };

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);

    if (!heading?.[1]) {
      if (current) body.push(line);
      continue;
    }

    flush();

    current = {
      version: versionInHeading(heading[1]),
      heading: line,
      body: '',
    };
  }

  flush();

  return found;
}

/**
 * Return the only top section for `version`.
 * The first `##` heading must be that version, its body must contain text,
 * and the file must not contain a second heading for the same version.
 */
export function changelogSection(markdown: string, version: string): string {
  if (!stableVersion(version)) {
    throw new Error(`Changelog version ${version} is not a stable X.Y.Z.`);
  }

  const parsed = sections(markdown);
  const top = parsed[0];

  if (!top || top.version !== version) {
    throw new Error(
      `CHANGELOG.md must open with a single ## ${version} section.`,
    );
  }

  if (!top.body) {
    throw new Error(`CHANGELOG.md section ${version} is empty.`);
  }

  const copies = parsed.filter((section) => section.version === version);

  if (copies.length !== 1) {
    throw new Error(
      `CHANGELOG.md has ${copies.length} sections for ${version}.`,
    );
  }

  return `${top.heading}\n\n${top.body}\n`;
}

/** Changelog body plus the VSIX install steps. The release title already shows the version. */
export function releaseNotes(markdown: string, version: string): string {
  const section = changelogSection(markdown, version)
    .trimEnd()
    .replace(/^##[^#][^\n]*\n+/, '');

  return `${section}

## Install

1. Download \`cursor-chat-transit-${version}.vsix\` and \`SHA256SUMS\`.
2. Check the checksum with \`sha256sum --check SHA256SUMS\`.
3. In Cursor, open Extensions, choose the … menu, then Install from VSIX….
4. Reload the editor if prompted.
`;
}
