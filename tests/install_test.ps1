# End-to-end tests for install.ps1 against a local bare repository built from the working tree (committed and
# uncommitted files, as git sees them, .gitignore respected): the cases of tests/install_test.sh plus the
# Windows ones (iex in a session, the Microsoft Store placeholder, the user Path). Needs git and Python 3.11+.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/install_test.ps1     (Windows PowerShell 5.1)
#   pwsh -NoProfile -File tests/install_test.ps1                                   (PowerShell 7+)
#
# Every installer run is a child process of the same PowerShell, with USERPROFILE and LOCALAPPDATA pointing
# below a temporary directory and BENCHMANIA_NO_MODIFY_PATH=1, so the real install locations and the user Path
# are never touched. Only when the environment variable CI is set (an ephemeral CI machine) does the last
# section change the real user Path in the registry, and it restores the old value afterwards.
# The snapshot commit's objects are written to this repository's object store, where git gc removes them.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $root 'install.ps1'
$shell = (Get-Process -Id $PID).Path
$work = Join-Path ([System.IO.Path]::GetTempPath()) ('benchmania-install-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
$out = Join-Path $work 'out'
$script:passed = 0
$script:failed = 0
$script:status = 0

function Pass([string]$What) { $script:passed++; Write-Host "ok    $What" }
function Fail([string]$What) {
    $script:failed++
    Write-Host "FAIL  $What"
    if (Test-Path -LiteralPath $out) { Get-Content -LiteralPath $out -Tail 8 | ForEach-Object { Write-Host "      | $_" } }
}
function Check([string]$What, [scriptblock]$Condition) {
    $ok = $false
    try { $ok = [bool](& $Condition) } catch { $ok = $false }
    if ($ok) { Pass $What } else { Fail $What }
}
function Output { if (Test-Path -LiteralPath $out) { [System.IO.File]::ReadAllText($out) } else { '' } }
function Contains([string]$Text) { (Output).Contains($Text) }
function Lacks([string]$Text) { -not (Output).Contains($Text) }

# git for the test itself; native stderr must not stop Windows PowerShell 5.1.
function Git {
    $ErrorActionPreference = 'Continue'
    $o = @(& git.exe -c core.longpaths=true @args 2>&1 | ForEach-Object { "$_" })
    if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed: $($o -join "`n")" }
    ($o -join "`n").Trim()
}

# Runs a child PowerShell with the given environment changes ($null removes a variable) and writes its output
# to $out; sets $script:status to its exit code. The test's own environment is restored afterwards.
function WithEnv([hashtable]$Vars, [scriptblock]$Body) {
    $saved = @{}
    foreach ($k in $Vars.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
        [Environment]::SetEnvironmentVariable($k, $Vars[$k], 'Process')
    }
    try { & $Body } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    }
}
function RunChild([string[]]$ShellArgs) {
    $ErrorActionPreference = 'Continue'
    $lines = @(& $shell -NoProfile -NonInteractive -ExecutionPolicy Bypass @ShellArgs 2>&1 | ForEach-Object { "$_" })
    $script:status = $LASTEXITCODE
    [System.IO.File]::WriteAllText($out, ($lines -join "`n") + "`n")
}
function InstallerEnv([string]$Name, [hashtable]$Set) {
    $dir = Join-Path $work $Name
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $vars = @{
        BENCHMANIA_HOME = $null; BENCHMANIA_BIN = $null; BENCHMANIA_REF = $null; BENCHCORE_ROOT = $null
        USERPROFILE = $dir; LOCALAPPDATA = (Join-Path $dir 'AppData\Local')
        BENCHMANIA_REPO = $repoUrl; BENCHMANIA_NO_MODIFY_PATH = '1'
    }
    foreach ($k in $Set.Keys) { $vars[$k] = $Set[$k] }
    $vars
}
# RunInstaller NAME [@{ VAR = value }]: install.ps1 run as a file, with USERPROFILE and LOCALAPPDATA below $work\NAME.
function RunInstaller([string]$Name, [hashtable]$Set = @{}) {
    WithEnv (InstallerEnv $Name $Set) { RunChild @('-File', $installer) }
}
# RunIex NAME CODE: CODE (PowerShell source text) run in a child session through Invoke-Expression, followed by
# a report of the session: still running, functions and variables that the code left behind, $LASTEXITCODE.
# Functions that belong to a module (Windows PowerShell 5.1 autoloads some while the code runs) do not count.
function RunIex([string]$Name, [string]$Source, [hashtable]$Set = @{}) {
    $sourceFile = Join-Path $work "$Name.source.ps1"
    [System.IO.File]::WriteAllText($sourceFile, $Source)
    $probe = @"
`$__f = @(Get-ChildItem function: | Where-Object { -not `$_.ModuleName }).Name; `$__v = @(Get-Variable).Name
try { Get-Content -Raw -LiteralPath '$sourceFile' | Invoke-Expression } catch { 'iex error: ' + `$_.Exception.Message }
`$__auto = @('__f', '__v', '__auto', 'LASTEXITCODE', '_', 'PSItem', 'args', 'input', 'Matches', 'StackTrace', '^', '$', '?')
'SESSION ALIVE'
'new functions: [' + ((@(Get-ChildItem function: | Where-Object { -not `$_.ModuleName }).Name | Where-Object { `$__f -notcontains `$_ }) -join ',') + ']'
'new variables: [' + ((@(Get-Variable).Name | Where-Object { `$__v -notcontains `$_ -and `$__auto -notcontains `$_ }) -join ',') + ']'
'exit code: ' + `$LASTEXITCODE
"@
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($probe))
    WithEnv (InstallerEnv $Name $Set) { RunChild @('-EncodedCommand', $encoded) }
}
function HomeOf([string]$Name) { Join-Path $work "$Name\AppData\Local\benchmania" }
function LauncherOf([string]$Name) { Join-Path $work "$Name\.local\bin\benchmania.cmd" }
function HeadOf([string]$Name) { Git -C (HomeOf $Name) rev-parse HEAD }
function Launch([string]$Launcher, [string[]]$LaunchArgs) {
    $ErrorActionPreference = 'Continue'
    Push-Location (Join-Path $work 'elsewhere')
    try { $lines = @(& $Launcher @LaunchArgs 2>&1 | ForEach-Object { "$_" }) } finally { Pop-Location }
    [System.IO.File]::WriteAllText($out, ($lines -join "`n") + "`n")
}

try {
    Write-Host "install_test.ps1 with $shell (PowerShell $($PSVersionTable.PSVersion))"
    $env:GIT_AUTHOR_NAME = 'test'; $env:GIT_AUTHOR_EMAIL = 'test@example.invalid'
    $env:GIT_COMMITTER_NAME = 'test'; $env:GIT_COMMITTER_EMAIL = 'test@example.invalid'

    # --- A bare upstream repository with one commit: a snapshot of the working tree -----------------------
    $upstream = Join-Path $work 'upstream.git'
    Git init --quiet --bare $upstream | Out-Null
    Git -C $upstream symbolic-ref HEAD refs/heads/main | Out-Null
    $env:GIT_INDEX_FILE = Join-Path $work 'snapshot.index'
    try {
        Git -C $root read-tree HEAD | Out-Null
        Git -C $root -c core.safecrlf=false add -A | Out-Null
        $tree = Git -C $root write-tree
    } finally { Remove-Item Env:GIT_INDEX_FILE }
    $first = Git -C $root commit-tree $tree -m 'snapshot of the working tree'
    Git -C $root push --quiet $upstream "${first}:refs/heads/main" "${first}:refs/tags/v-test" | Out-Null
    $repoUrl = 'file:///' + ($upstream -replace '\\', '/') # file:// so that --depth applies as it does for a remote

    # A developer clone that moves the upstream forward.
    $dev = Join-Path $work 'dev'
    Git clone --quiet $upstream $dev | Out-Null
    function Advance([string]$Message) {
        [System.IO.File]::WriteAllText((Join-Path $dev 'UPSTREAM_CHANGE.txt'), "$Message`n")
        Git -C $dev add UPSTREAM_CHANGE.txt | Out-Null
        Git -C $dev commit --quiet -m $Message | Out-Null
        Git -C $dev push --quiet origin HEAD:main | Out-Null
    }
    New-Item -ItemType Directory -Path (Join-Path $work 'elsewhere') | Out-Null

    Check 'install.ps1 is plain ASCII (Windows PowerShell 5.1 reads files without a BOM as ANSI)' {
        -not ([System.IO.File]::ReadAllBytes($installer) | Where-Object { $_ -gt 127 })
    }

    # --- Fresh install with the default paths ------------------------------------------------------------
    RunInstaller a
    $H = HomeOf a
    $L = LauncherOf a
    Check 'fresh install exits 0' { $status -eq 0 }
    Check 'checkout is a git repository at the default path (%LOCALAPPDATA%\benchmania)' { Test-Path -LiteralPath "$H\.git" -PathType Container }
    Check 'checkout is at the snapshot commit' { (HeadOf a) -eq $first }
    Check 'checkout has core.longpaths set' { (Git -C $H config --local --get core.longpaths) -eq 'true' }
    Check 'launcher benchmania.cmd exists in %USERPROFILE%\.local\bin' { Test-Path -LiteralPath $L -PathType Leaf }
    Check 'launcher carries the marker' { [System.IO.File]::ReadAllText($L).Contains('Launcher written by the Benchmania installer.') }
    Check "launcher calls the checkout's wrapper" { [System.IO.File]::ReadAllText($L).Contains("`"$H\benchmania`" %*") }
    Check 'summary names the checkout' { Contains "Benchmania installed: $H" }
    Check 'summary prints the PATH line for this window' { Contains "`$env:Path += ';$work\a\.local\bin'" }
    Check 'summary says what works on Windows' { Contains 'Measuring needs Linux with Docker' }
    Check 'summary says how to uninstall' { Contains "Remove-Item -Recurse -Force '$H', '$L'" }
    Check 'nothing else written to the home directory' {
        -not (Get-ChildItem -LiteralPath (Join-Path $work 'a') -Force | Where-Object { @('AppData', '.local') -notcontains $_.Name })
    }

    Launch $L @('--version')
    Check 'launcher runs --version from an unrelated directory' { Contains 'Benchmania engine' }
    Launch $L @('list')
    Check 'launcher runs list from an unrelated directory' { Contains 'implementations:' }
    Launch $L @('scaffold', '--help')
    Check 'launcher passes all arguments through' { Contains '--from' }

    # --- Second run without changes ------------------------------------------------------------------------
    RunInstaller a
    Check 'second run exits 0' { $status -eq 0 }
    Check 'second run reports up to date' { Contains "Benchmania is up to date: $H" }
    Check 'second run keeps the commit' { (HeadOf a) -eq $first }

    # --- Update after the upstream moved; an untracked result bundle survives --------------------------------
    $bundleDir = Join-Path $H 'results\example\test-machine'
    New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $bundleDir 'run.json'), '{"kept": true}')
    Advance 'second commit'
    $second = Git -C $dev rev-parse HEAD
    RunInstaller a
    Check 'update exits 0' { $status -eq 0 }
    Check 'update fast-forwards to the new upstream commit' { (HeadOf a) -eq $second }
    Check 'update reports old and new commit' { Contains 'Updated ' }
    Check 'untracked result bundle survives the update' { [System.IO.File]::ReadAllText((Join-Path $bundleDir 'run.json')).Contains('"kept": true') }

    # --- Refusal when a tracked file is modified ---------------------------------------------------------------
    [System.IO.File]::AppendAllText((Join-Path $H 'README.md'), "local edit`n")
    Advance 'third commit'
    RunInstaller a
    Check 'modified tracked file: exits non-zero' { $status -ne 0 }
    Check 'modified tracked file: says so' { Contains 'modified tracked files' }
    Check 'modified tracked file: names the file' { Contains 'README.md' }
    Check 'modified tracked file: checkout not moved' { (HeadOf a) -eq $second }
    Check 'modified tracked file: edit kept' { [System.IO.File]::ReadAllText((Join-Path $H 'README.md')).Contains('local edit') }
    Git -C $H checkout --quiet -- README.md | Out-Null
    RunInstaller a
    Check 'after reverting the edit the update succeeds' { (HeadOf a) -eq (Git -C $dev rev-parse HEAD) }

    # --- An ignored local file is kept when the upstream starts tracking its path -----------------------------
    New-Item -ItemType Directory -Force -Path (Join-Path $H '.git\info') | Out-Null
    [System.IO.File]::AppendAllText((Join-Path $H '.git\info\exclude'), "local-notes.txt`n")
    [System.IO.File]::WriteAllText((Join-Path $H 'local-notes.txt'), 'mine')
    $before = HeadOf a
    [System.IO.File]::WriteAllText((Join-Path $dev 'local-notes.txt'), "upstream`n")
    Git -C $dev add local-notes.txt | Out-Null
    Advance 'upstream tracks local-notes.txt'
    RunInstaller a
    Check 'ignored file in the way: exits non-zero' { $status -ne 0 }
    Check 'ignored file in the way: file kept' { [System.IO.File]::ReadAllText((Join-Path $H 'local-notes.txt')) -eq 'mine' }
    Check 'ignored file in the way: checkout not moved' { (HeadOf a) -eq $before }
    Check 'ignored file in the way: says what to do' { Contains 'Move it away' }
    Remove-Item -LiteralPath (Join-Path $H 'local-notes.txt')
    RunInstaller a
    Check 'after moving the file away the update succeeds' { (HeadOf a) -eq (Git -C $dev rev-parse HEAD) }

    # --- Pinning a tag with BENCHMANIA_REF ---------------------------------------------------------------------
    RunInstaller pinned @{ BENCHMANIA_REF = 'v-test' }
    Check 'pinned install exits 0' { $status -eq 0 }
    Check 'pinned install is at the tag' { (HeadOf pinned) -eq $first }
    RunInstaller pinned @{ BENCHMANIA_REF = 'v-test' }
    Check 'pinned re-run exits 0' { $status -eq 0 }
    Check 'pinned re-run stays at the tag' { (HeadOf pinned) -eq $first }
    RunInstaller pinned
    Check 'unpinned re-run exits 0' { $status -eq 0 }
    Check 'unpinned re-run moves to the default branch' { (HeadOf pinned) -eq (Git -C $dev rev-parse HEAD) }
    Check 'unpinned re-run is on the branch' { (Git -C (HomeOf pinned) symbolic-ref --short HEAD) -eq 'main' }

    # --- Custom paths through BENCHMANIA_HOME and BENCHMANIA_BIN -----------------------------------------------
    $cbin = Join-Path $work 'custom\bin'
    RunInstaller custom @{ BENCHMANIA_HOME = (Join-Path $work 'custom\checkout'); BENCHMANIA_BIN = $cbin; Path = "$cbin;$env:Path" }
    Check 'custom paths: exits 0' { $status -eq 0 }
    Check 'custom paths: launcher in BENCHMANIA_BIN' { Test-Path -LiteralPath (Join-Path $cbin 'benchmania.cmd') }
    Check 'custom paths: checkout in BENCHMANIA_HOME' { Test-Path -LiteralPath (Join-Path $work 'custom\checkout\.git') }
    Check 'custom paths: no PATH line when BENCHMANIA_BIN is on PATH' { Lacks 'is not on your PATH' }

    # --- cmd.exe syntax in a path setting is refused instead of creating a directory named %USERPROFILE% ------
    RunInstaller percent @{ BENCHMANIA_BIN = '%USERPROFILE%\tools' }
    Check 'percent sign in BENCHMANIA_BIN: exits non-zero' { $status -ne 0 }
    Check 'percent sign in BENCHMANIA_BIN: explains' { Contains 'BENCHMANIA_BIN contains a % sign' }
    Check 'percent sign in BENCHMANIA_BIN: nothing installed' { -not (Test-Path -LiteralPath (HomeOf percent)) }

    # --- Refusal when the launcher path holds a foreign file -----------------------------------------------------
    New-Item -ItemType Directory -Force -Path (Join-Path $work 'foreign\.local\bin') | Out-Null
    [System.IO.File]::WriteAllText((LauncherOf foreign), '@echo off')
    RunInstaller foreign
    Check 'foreign launcher: exits non-zero' { $status -ne 0 }
    Check 'foreign launcher: explains' { Contains 'was not written by this installer' }
    Check 'foreign launcher: file unchanged' { [System.IO.File]::ReadAllText((LauncherOf foreign)) -eq '@echo off' }
    Check 'foreign launcher: nothing cloned' { -not (Test-Path -LiteralPath (HomeOf foreign)) }

    # --- Refusal when the home directory is a checkout of another repository ------------------------------------
    $other = HomeOf other
    New-Item -ItemType Directory -Force -Path $other | Out-Null
    Git init --quiet $other | Out-Null
    Git -C $other remote add origin https://example.invalid/other.git | Out-Null
    RunInstaller other
    Check 'other repository: exits non-zero' { $status -ne 0 }
    Check 'other repository: explains' { Contains 'is a checkout of https://example.invalid/other.git' }
    Check 'other repository: no launcher written' { -not (Test-Path -LiteralPath (LauncherOf other)) }

    # --- Refusal when the home directory exists and is not a checkout ------------------------------------------
    New-Item -ItemType Directory -Force -Path (HomeOf plain) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path (HomeOf plain) 'notes.txt'), 'mine')
    RunInstaller plain
    Check 'non-checkout directory: exits non-zero' { $status -ne 0 }
    Check 'non-checkout directory: file kept' { [System.IO.File]::ReadAllText((Join-Path (HomeOf plain) 'notes.txt')) -eq 'mine' }

    # --- A failing clone leaves no launcher ----------------------------------------------------------------------
    function NoBenchmaniaIn([string]$Name) {
        -not (Get-ChildItem -LiteralPath (Join-Path $work "$Name\AppData\Local") -Force -Filter 'benchmania*' -ErrorAction SilentlyContinue)
    }
    RunInstaller broken @{ BENCHMANIA_REPO = (Join-Path $work 'does-not-exist.git') }
    Check 'failing clone: exits non-zero' { $status -ne 0 }
    Check 'failing clone: no launcher' { -not (Test-Path -LiteralPath (LauncherOf broken)) }
    Check 'failing clone: no checkout or partial directory' { NoBenchmaniaIn broken }

    # --- A repository value that starts with a dash is not read as an option -------------------------------------
    RunInstaller dash @{ BENCHMANIA_REPO = '--upload-pack=touch-dash-marker' }
    Check 'dash repository: exits non-zero' { $status -ne 0 }
    Check 'dash repository: reported as a repository that could not be cloned' { Contains 'could not clone --upload-pack=touch-dash-marker' }
    Check 'dash repository: git saw it as the repository, not as an option' { Contains "repository '--upload-pack=touch-dash-marker' does not exist" }
    Check 'dash repository: no checkout or partial directory' { NoBenchmaniaIn dash }

    # --- Through Invoke-Expression in a session, as irm ... | iex does ------------------------------------------
    $source = [System.IO.File]::ReadAllText($installer)
    RunIex iex $source
    Check 'iex install: succeeds' { Contains 'Benchmania installed:' }
    Check 'iex install: session still running' { Contains 'SESSION ALIVE' }
    Check 'iex install: no functions left behind' { Contains 'new functions: []' }
    Check 'iex install: no variables left behind' { Contains 'new variables: []' }
    Check 'iex install: $LASTEXITCODE is 0' { Contains 'exit code: 0' }
    Launch (LauncherOf iex) @('--version')
    Check 'iex install: launcher works' { Contains 'Benchmania engine' }

    New-Item -ItemType Directory -Force -Path (Join-Path $work 'iexfail\.local\bin') | Out-Null
    [System.IO.File]::WriteAllText((LauncherOf iexfail), '@echo off')
    RunIex iexfail $source
    Check 'iex failure: says why' { Contains 'was not written by this installer' }
    Check 'iex failure: session still running' { Contains 'SESSION ALIVE' }
    Check 'iex failure: no exception escapes into the session' { Lacks 'iex error:' }
    Check 'iex failure: no functions left behind' { Contains 'new functions: []' }
    Check 'iex failure: no variables left behind' { Contains 'new variables: []' }
    Check 'iex failure: $LASTEXITCODE is 1' { Contains 'exit code: 1' }

    RunIex truncated $source.Substring(0, [int]($source.Length * 0.6))
    Check 'truncated download: session still running' { Contains 'SESSION ALIVE' }
    Check 'truncated download: does not parse' { Contains 'iex error:' }
    Check 'truncated download: nothing installed' { (NoBenchmaniaIn truncated) -and -not (Test-Path -LiteralPath (Join-Path $work 'truncated\.local')) }

    # --- Python detection (simulated with PATH: git's directory plus fake interpreters) ---------------------------
    $gitDir = Split-Path -Parent (Get-Command git -CommandType Application | Select-Object -First 1).Source
    function FakePython([string]$Name, [string]$Body) {
        $d = Join-Path $work "$Name\fakebin"
        New-Item -ItemType Directory -Force -Path $d | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $d 'python.cmd'), "@echo off`r`n$Body`r`n")
        "$d;$gitDir"
    }
    RunInstaller oldpy @{ Path = (FakePython oldpy "echo 3.9.2^|C:\Python39\python.exe`r`nexit /b 0") }
    Check 'python too old: exits non-zero' { $status -ne 0 }
    Check 'python too old: names the required version and the one found' { Contains 'Python 3.11 or newer is required; found Python 3.9.2 (python)' }
    Check 'python too old: nothing installed' { -not (Test-Path -LiteralPath (Join-Path $work 'oldpy\.local')) -and (NoBenchmaniaIn oldpy) }

    RunInstaller store @{ Path = (FakePython store 'exit /b 9009') }
    Check 'Store placeholder: does not count as Python' { Contains 'Python 3.11 or newer is required but was not found' }
    Check 'Store placeholder: exits non-zero, nothing installed' { $status -ne 0 -and -not (Test-Path -LiteralPath (Join-Path $work 'store\.local')) }

    RunInstaller nopy @{ Path = $gitDir }
    Check 'python absent: exits non-zero' { $status -ne 0 }
    Check 'python absent: says so' { Contains 'Python 3.11 or newer is required but was not found' }
    Check 'python absent: nothing installed' { -not (Test-Path -LiteralPath (Join-Path $work 'nopy\.local')) -and (NoBenchmaniaIn nopy) }

    # --- The user Path, for real: only on an ephemeral CI machine -------------------------------------------------
    if ($env:CI) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
        $hadPath = $key.GetValueNames() -contains 'Path'
        $savedValue = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $savedKind = $(if ($hadPath) { $key.GetValueKind('Path') } else { $null })
        try {
            # The runner's own value may be missing or empty: no trailing separator then.
            $before = (@('%SystemRoot%\benchmania-ci-entry', ([string]$savedValue).Trim(';')) | Where-Object { $_ }) -join ';'
            $key.SetValue('Path', $before, [Microsoft.Win32.RegistryValueKind]::ExpandString)
            $pbin = Join-Path $work 'pathtest\.local\bin'
            RunInstaller pathtest @{ BENCHMANIA_NO_MODIFY_PATH = $null }
            Check 'user Path: install exits 0' { $status -eq 0 }
            Check 'user Path: says it added the directory' { Contains "Added $pbin to your user Path" }
            RunInstaller pathtest @{ BENCHMANIA_NO_MODIFY_PATH = $null }
            Check 'user Path: second run exits 0 and adds nothing' { $status -eq 0 -and (Lacks 'to your user Path') }
            $after = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            Check 'user Path: entry appended exactly once' { $after -eq "$before;$pbin" }
            Check 'user Path: value type REG_EXPAND_SZ kept' { $key.GetValueKind('Path') -eq [Microsoft.Win32.RegistryValueKind]::ExpandString }
            Check 'user Path: %VARIABLES% kept unexpanded' { $after.StartsWith('%SystemRoot%\benchmania-ci-entry') }
        } finally {
            if ($hadPath) { $key.SetValue('Path', $savedValue, $savedKind) } else { $key.DeleteValue('Path', $false) }
            $key.Close()
        }
    } else {
        Write-Host 'skip  user Path changes (run only when CI is set, on an ephemeral machine)'
    }
} finally {
    Set-Location $root
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "install_test: $script:passed passed, $script:failed failed"
if ($script:failed -ne 0) { exit 1 }
