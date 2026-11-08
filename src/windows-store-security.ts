import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const SID = /^S-\d-\d+(?:-\d+)+$/;
const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';

/** Bounded, shell-free invocation; never resolve security tools through PATH. */
export function runWindowsSecurityTool(
  tool: 'powershell' | 'icacls',
  args: string[],
): Promise<string> {
  const root = process.env.SystemRoot;

  if (!root || !path.win32.isAbsolute(root))
    throw new Error('Windows SystemRoot unavailable for ACL verification.');

  const executable = path.win32.join(
    root,
    'System32',
    ...(tool === 'powershell'
      ? ['WindowsPowerShell', 'v1.0', 'powershell.exe']
      : ['icacls.exe']),
  );

  return new Promise((resolve, reject) => {
    childProcess.execFile(
      executable,
      args,
      {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        shell: false,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

function powershell(script: string): Promise<string> {
  return runWindowsSecurityTool('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(
      `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';${script}`,
      'utf16le',
    ).toString('base64'),
  ]);
}

interface Security {
  owner: string;
  reparse: boolean;
  protected: boolean;
  rules: Array<{
    sid: string;
    inherited: boolean;
    allow: boolean;
    rights: number;
    inheritance: number;
    propagation: number;
  }>;
}

async function inspect(directory: string): Promise<Security> {
  // A base64 literal keeps arbitrary path characters out of PowerShell syntax.
  const encoded = Buffer.from(directory, 'utf8').toString('base64');

  return JSON.parse(
    await powershell(
      `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));` +
        // Get-Acl autoloads Microsoft.PowerShell.Security, which the runner
        // cannot load under -NoProfile. DirectorySecurity is the same ACL.
        '$i=[IO.DirectoryInfo]::new($p);' +
        "$a=[Security.AccessControl.DirectorySecurity]::new($p,[Security.AccessControl.AccessControlSections]'Access, Owner');" +
        '$r=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {' +
        "@{sid=$_.IdentityReference.Value;inherited=$_.IsInherited;allow=($_.AccessControlType -eq 'Allow');rights=[int]$_.FileSystemRights;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags}});" +
        '@{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;reparse=(($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0);protected=$a.AreAccessRulesProtected;rules=$r}|ConvertTo-Json -Compress -Depth 4',
    ),
  ) as Security;
}

const FULL_CONTROL = 2032127;
const GENERIC_ALL = 268435456;

function isFullControl(value: unknown): boolean {
  const rights = Number(value);

  return (
    rights === FULL_CONTROL ||
    rights === GENERIC_ALL ||
    (rights & FULL_CONTROL) === FULL_CONTROL
  );
}

/** Reject any deviation from the private SID ACL. An elevated token may own the directory as Administrators. */
export function verifyWindowsStoreSecurity(
  security: Security,
  user: string,
): void {
  const required = new Set([user, SYSTEM, ADMINISTRATORS]);
  const rules = Array.isArray(security.rules) ? security.rules : [];
  const seen = new Set<string>();

  if (
    security.reparse ||
    (security.owner !== user && security.owner !== ADMINISTRATORS) ||
    !security.protected ||
    rules.length === 0 ||
    rules.some((rule) => {
      const inheritance = Number(rule.inheritance);
      const propagation = Number(rule.propagation);

      if (
        !required.has(rule.sid) ||
        rule.inherited ||
        !rule.allow ||
        !isFullControl(rule.rights) ||
        inheritance !== 3 ||
        propagation !== 0
      )
        return true;

      seen.add(rule.sid);

      return false;
    }) ||
    seen.size !== required.size
  )
    throw new Error(
      `Unsafe Windows agent-store ownership, reparse point or ACL. owner=${security.owner} protected=${security.protected} reparse=${security.reparse} rules=${JSON.stringify(security.rules)}`,
    );
}

/** Match Cursor's three SID grants, but verify owner and exact protected ACL too. */
export async function provisionWindowsVisualizationScope(
  scope: string,
  base: string,
): Promise<void> {
  const user = (
    await powershell(
      '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    )
  ).trim();

  if (!SID.test(user)) throw new Error('Windows current-user SID unavailable.');
  const created: Array<{ directory: string; dev: number; ino: number }> = [];
  let current = path.parse(scope).root;

  try {
    for (const part of scope
      .slice(current.length)
      .split(path.sep)
      .filter(Boolean)) {
      current = path.join(current, part);
      let made = false;

      try {
        await fs.lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await fs.mkdir(current);
        made = true;
      }

      const stat = await fs.lstat(current);

      if (made)
        created.push({ directory: current, dev: stat.dev, ino: stat.ino });

      const resolved = path.resolve(current);
      const resolvedBase = path.resolve(base);
      const aboveBase = resolvedBase.startsWith(`${resolved}${path.sep}`);

      const privateScope =
        resolved === resolvedBase ||
        resolved.startsWith(`${resolvedBase}${path.sep}`);

      if (stat.isSymbolicLink() && aboveBase) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Unsafe Windows scope directory.');
      // C:\ and the runner temp parents are not the store. Inspecting them
      // starts PowerShell for every ancestor and rejects ordinary junctions.
      if (!made && !privateScope) continue;
      const before = await inspect(current);

      if (before.reparse) throw new Error('Unsafe Windows reparse point.');

      if (made) {
        // An elevated token owns a new directory as Administrators. That is
        // the Windows default and still one of the three private SIDs.
        if (before.owner !== user && before.owner !== ADMINISTRATORS)
          throw new Error('Unsafe Windows directory owner.');

        await runWindowsSecurityTool('icacls', [
          current,
          '/inheritance:r',
          '/grant:r',
          `*${user}:(OI)(CI)F`,
          `*${SYSTEM}:(OI)(CI)F`,
          `*${ADMINISTRATORS}:(OI)(CI)F`,
        ]);
      }

      if (made || privateScope)
        verifyWindowsStoreSecurity(await inspect(current), user);
      const after = await fs.lstat(current);

      if (
        after.isSymbolicLink() ||
        after.dev !== stat.dev ||
        after.ino !== stat.ino
      )
        throw new Error(
          'Windows scope identity changed during ACL verification.',
        );
    }
  } catch (error) {
    for (const item of created.reverse()) {
      try {
        const stat = await fs.lstat(item.directory);

        if (
          stat.isDirectory() &&
          !stat.isSymbolicLink() &&
          stat.dev === item.dev &&
          stat.ino === item.ino &&
          !(await inspect(item.directory)).reparse
        )
          await fs.rmdir(item.directory);
      } catch {
        /* Retain nonempty, replaced or unverifiable directories. */
      }
    }

    throw error;
  }
}
