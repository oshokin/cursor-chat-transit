# Locate or install the Node.js toolchain pinned in .nvmrc.
# Windows 10/11 (PowerShell 5.1). Cursor helper node has no npm.
# A different Node 24 already on PATH is not reused.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Tools = Join-Path $Root '.tools\node'
$Dist = 'https://nodejs.org/dist'
$Ua = 'cursor-chat-transit-dev-node'
$BinDir = $null
$Version = $null
$Major = $null
$Archive = $null

# Write to stderr and exit.
function Fail([string]$Message) {
  [Console]::Error.WriteLine($Message)
  exit 1
}

# Read the first non-comment token from .nvmrc.
function Get-WantedVersion {
  $raw = Get-Content -LiteralPath (Join-Path $Root '.nvmrc')
  foreach ($line in $raw) {
    $cut = ($line -split '#', 2)[0].Trim()
    if (-not $cut) { continue }
    $script:Version = $cut.TrimStart('v')
    break
  }
  if (-not $script:Version) { Fail '.nvmrc does not contain a Node version.' }
  $script:Major = ($script:Version -split '\.')[0]
  if ($script:Major -notmatch '^[0-9]+$') {
    Fail "Unsupported Node version in .nvmrc: $script:Version"
  }
}

# node.exe or node in a candidate directory.
function Get-NodeFile([string]$Dir) {
  foreach ($name in @('node.exe', 'node')) {
    $path = Join-Path $Dir $name
    if (Test-Path -LiteralPath $path) { return $path }
  }
  return $null
}

# npm.cmd or npm beside the Node binary.
function Get-NpmFile([string]$Dir) {
  foreach ($name in @('npm.cmd', 'npm')) {
    $path = Join-Path $Dir $name
    if (Test-Path -LiteralPath $path) { return $path }
  }
  return $null
}

# True when the directory has the exact .nvmrc Node version and npm beside it.
function Test-Toolchain([string]$Dir) {
  if (-not $Dir) { return $false }
  $node = Get-NodeFile $Dir
  $npm = Get-NpmFile $Dir
  if (-not $node -or -not $npm) { return $false }
  try {
    $nodeVer = (& $node -p 'process.versions.node' 2>$null)
  } catch {
    return $false
  }
  if (-not $nodeVer) { return $false }
  if ($nodeVer.Trim() -ne $Version) { return $false }
  $script:BinDir = $Dir
  return $true
}

# Search .tools, PATH, nvm-windows, fnm, mise, volta, and Program Files.
# CCT_DEV_NODE_ISOLATE=1 (tests) considers only this repo's .tools\node.
function Find-Bin {
  if (Test-Toolchain (Join-Path $Tools 'bin')) { return $true }
  if (Test-Toolchain $Tools) { return $true }
  if ($env:CCT_DEV_NODE_ISOLATE) { return $false }
  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($part in ($env:PATH -split ';')) {
    if ($part) { [void]$candidates.Add($part) }
  }
  $nvmHome = $env:NVM_HOME
  if (-not $nvmHome) { $nvmHome = Join-Path $env:APPDATA 'nvm' }
  [void]$candidates.Add((Join-Path $nvmHome "v$Version"))
  [void]$candidates.Add((Join-Path $env:ProgramFiles 'nodejs'))
  [void]$candidates.Add((Join-Path $env:USERPROFILE ".fnm\node-versions\v$Version\installation"))
  [void]$candidates.Add((Join-Path $env:LOCALAPPDATA "fnm\node-versions\v$Version\installation"))
  [void]$candidates.Add((Join-Path $env:LOCALAPPDATA "mise\installs\node\$Version"))
  [void]$candidates.Add((Join-Path $env:LOCALAPPDATA "mise\installs\node\v$Version"))
  [void]$candidates.Add((Join-Path $env:USERPROFILE '.volta\bin'))
  foreach ($dir in $candidates) {
    if (Test-Toolchain $dir) { return $true }
  }
  return $false
}

# Official Windows zip name for this CPU.
function Get-ArchiveName {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $arch = 'AMD64' }
  switch ($arch) {
    'AMD64' { $cpu = 'x64' }
    'ARM64' { $cpu = 'arm64' }
    default { Fail "No official Node.js Windows build is mapped for $arch." }
  }
  $script:Archive = "node-v$Version-win-$cpu.zip"
}

# Download a URL with Invoke-WebRequest.
function Fetch-File([string]$Url, [string]$Dest) {
  Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -UserAgent $Ua
}

# Checksum for Archive from the official SHASUMS256.txt.
function Get-ExpectedSha {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("cct-node-sha-" + [guid]::NewGuid().ToString('n') + '.txt')
  try {
    Fetch-File "$Dist/v$Version/SHASUMS256.txt" $tmp
    foreach ($line in Get-Content -LiteralPath $tmp) {
      if ($line -match '^([0-9a-f]{64})\s+\*?(\S+)\s*$' -and $Matches[2] -eq $Archive) {
        return $Matches[1]
      }
    }
  } finally {
    Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
  }
  Fail "No SHA-256 listed for $Archive in the Node.js SHASUMS256.txt."
}

# Download, verify, and unpack the official Node.js zip into .tools\node.
function Install-Official {
  Get-ArchiveName
  Write-Host "Downloading Node.js $Version ($Archive) from nodejs.org..."
  $toolsParent = Join-Path $Root '.tools'
  New-Item -ItemType Directory -Force -Path $toolsParent | Out-Null
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('cct-node-' + [guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp $Archive
    Fetch-File "$Dist/v$Version/$Archive" $zip
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    $expected = (Get-ExpectedSha).ToLowerInvariant()
    if ($actual -ne $expected) {
      Fail "Node.js archive checksum mismatch.`n  expected $expected`n  actual   $actual"
    }
    $unpacked = Join-Path $tmp 'unpacked'
    Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
    $root = Get-ChildItem -LiteralPath $unpacked -Directory | Where-Object {
      Get-NodeFile $_.FullName
    } | Select-Object -First 1
    if (-not $root) { Fail 'Unexpected layout in the downloaded Node.js archive.' }
    if (Test-Path -LiteralPath $Tools) {
      Remove-Item -LiteralPath $Tools -Recurse -Force
    }
    Move-Item -LiteralPath $root.FullName -Destination $Tools
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (-not (Test-Toolchain $Tools) -and -not (Test-Toolchain (Join-Path $Tools 'bin'))) {
    Fail 'Downloaded Node.js, but npm was not found next to node.'
  }
  $node = Get-NodeFile $BinDir
  Write-Host "Installed $(& $node -p 'process.versions.node') at $BinDir"
}

# Explain how to obtain Node when none was found.
function Write-Missing {
  Write-Host @"
Node.js $Version and npm are not on PATH.
Cursor helper node is not a toolchain: it has no npm.

From this repository run:
  task setup

That downloads the official Windows Node.js zip pinned in .nvmrc into
.tools\node (gitignored) and then runs npm ci.

If you prefer a version manager, install fnm or nvm-windows, then retry.
Official builds: https://nodejs.org/en/download
Do not use an unrelated Microsoft Store or stale Chocolatey npm as the toolchain.
"@
}

# Put BinDir first on PATH for the following command.
function Use-NodeEnv {
  $env:PATH = "$BinDir;$env:PATH"
  Remove-Item Env:npm_config_devdir -ErrorAction SilentlyContinue
  Remove-Item Env:NPM_CONFIG_DEVDIR -ErrorAction SilentlyContinue
}

# Invoke npm.cmd from the resolved toolchain, not a Store shim.
function Invoke-Npm([string[]]$NpmArgs) {
  Use-NodeEnv
  $npm = Get-NpmFile $BinDir
  if (-not $npm) { Fail 'npm was not found in the selected toolchain.' }
  & $npm @NpmArgs | Out-Host
  $code = $LASTEXITCODE
  if ($null -eq $code) { return 0 }
  return [int]$code
}

# Print the resolved node, npm, and which tree they came from.
function Write-Status {
  $origin = $BinDir
  if ($BinDir -eq $Tools -or $BinDir -eq (Join-Path $Tools 'bin')) {
    $origin = 'project .tools/node'
  }
  $node = Get-NodeFile $BinDir
  Write-Host "node $(& $node -p 'process.versions.node')  $node"
  Write-Host "npm  $(Get-NpmFile $BinDir)"
  Write-Host "bin   $BinDir ($origin)"
}

$setup = $false
$status = $false
$afterDash = $false
$command = New-Object System.Collections.Generic.List[string]
foreach ($arg in $args) {
  if ($afterDash) {
    [void]$command.Add([string]$arg)
    continue
  }
  switch -Exact ($arg) {
    '--setup' { $setup = $true }
    '--status' { $status = $true }
    '--' { $afterDash = $true }
    default { [void]$command.Add([string]$arg) }
  }
}

Get-WantedVersion
$found = Find-Bin

if ($setup) {
  if (-not $found) { Install-Official }
  else {
    $node = Get-NodeFile $BinDir
    Write-Host "Using Node $(& $node -p 'process.versions.node') at $BinDir"
  }
  exit (Invoke-Npm @('ci'))
}

if (-not $found) {
  Write-Missing
  exit 1
}

if ($status -or $command.Count -eq 0) {
  Write-Status
  exit 0
}

Use-NodeEnv
if ($command[0] -eq 'npm') {
  $rest = @()
  if ($command.Count -gt 1) { $rest = $command.GetRange(1, $command.Count - 1).ToArray() }
  exit (Invoke-Npm $rest)
}

$exe = $command[0]
$rest = @()
if ($command.Count -gt 1) { $rest = $command.GetRange(1, $command.Count - 1).ToArray() }
& $exe @rest
if ($null -eq $LASTEXITCODE) { exit 0 }
exit $LASTEXITCODE
