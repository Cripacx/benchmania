# Benchmania installer for Windows: puts the benchmania command on this machine.
#
#   irm https://benchmania.cleson.dev/install.ps1 | iex
#
# The Windows counterpart of install.sh (Linux, macOS and WSL: curl -fsSL https://benchmania.cleson.dev/install.sh | sh).
# It clones the Benchmania repository (a normal git checkout: result bundles record its commit, and you open
# your results pull request from it) and writes a small launcher, benchmania.cmd. It needs git and Python 3.11
# or newer, never needs administrator rights and writes only the checkout, the launcher and, unless disabled,
# your user Path (never the machine Path). Running it again updates the checkout by fast-forward; untracked
# files such as your results are kept. Works in Windows PowerShell 5.1 and PowerShell 7+.
#
# On Windows the command can list, validate, scaffold and publish. Measuring needs Linux with Docker.
#
# Settings (environment variables):
#   BENCHMANIA_REPO            repository to clone      (default: https://github.com/Cripacx/benchmania)
#   BENCHMANIA_REF             branch or tag to install (default: the repository's default branch)
#   BENCHMANIA_HOME            checkout directory       (default: %LOCALAPPDATA%\benchmania)
#   BENCHMANIA_BIN             launcher directory       (default: %USERPROFILE%\.local\bin)
#   BENCHMANIA_NO_MODIFY_PATH  set to 1 to leave your user Path unchanged
#
# Uninstall: remove BENCHMANIA_HOME and BENCHMANIA_BIN\benchmania.cmd, and BENCHMANIA_BIN from your user Path.
#
# Everything happens inside the script block below, which is invoked as a whole: a truncated download does not
# parse and runs nothing. Through `iex` it runs in your session, so it never calls `exit` there and leaves no
# functions or variables behind; only when it runs as a file (powershell -File install.ps1) does a failure end
# the script with exit code 1.

& {
    Set-StrictMode -Version 2.0
    $ErrorActionPreference = 'Stop'
    $asFile = [bool]$MyInvocation.MyCommand.ScriptBlock.File
    $marker = 'Launcher written by the Benchmania installer.'

    function Say([string]$Text = '') { Write-Host $Text }
    # A failure: the message on the error stream, and a terminating signal that the handler below turns into
    # the end of the installation (never into `exit` inside your session).
    function Die([string]$Message, [string[]]$Details = @()) {
        $err = New-Object System.Exception $Message
        $err.Data['details'] = $Details
        throw $err
    }

    # Runs git; returns its output lines (stdout and stderr) and whether it succeeded. Native stderr must not
    # become a terminating error in Windows PowerShell 5.1, hence the local preference.
    function RunGit([string[]]$GitArgs) {
        $ErrorActionPreference = 'Continue'
        $out = @(& $gitExe -c core.longpaths=true @GitArgs 2>&1 | ForEach-Object { "$_" })
        [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0); Out = $out; Text = (($out -join "`n").Trim()) }
    }
    function G([string[]]$GitArgs) { RunGit (@('-C', $checkout) + $GitArgs) }
    # The URL without a trailing slash or .git, so that equivalent spellings compare equal.
    function Canonical([string]$Url) { ($Url -replace '/+$', '') -replace '\.git$', '' }
    function FullPath([string]$Path) {
        $cwd = (Get-Location -PSProvider FileSystem).ProviderPath
        [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($cwd, $Path)).TrimEnd('\')
    }
    function IsOurs([string]$Path) {
        (Test-Path -LiteralPath $Path -PathType Leaf) -and
            ([System.IO.File]::ReadAllText($Path).Contains($marker))
    }
    # Path entries, expanded, without trailing backslashes, for comparison.
    function PathEntries([string]$Value) {
        @(($Value -split ';') | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).Trim().TrimEnd('\') } |
            Where-Object { $_ })
    }
    function OnPath([string]$Value, [string]$Dir) { @(PathEntries $Value | Where-Object { $_ -ieq $Dir }).Count -gt 0 }

    # Python 3.11+: the first of `py -3`, `python`, `python3` that runs and reports a new enough version. The
    # Microsoft Store placeholder python.exe prints nothing and fails, so it does not count.
    function FindPython {
        $probe = "import sys; print('.'.join(map(str, sys.version_info[:3])) + '|' + sys.executable)"
        $found = @()
        foreach ($c in @(@('py', '-3'), @('python'), @('python3'))) {
            $cmd = Get-Command $c[0] -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $cmd) { continue }
            $pre = @($c | Select-Object -Skip 1)
            $ErrorActionPreference = 'Continue'
            $line = @(& $cmd.Source @pre -c $probe 2>$null) | Where-Object { "$_" -match '^\d+\.\d+\.\d+\|' } |
                Select-Object -First 1
            $ErrorActionPreference = 'Stop'
            if ($LASTEXITCODE -ne 0 -or -not $line) { continue }
            $version, $exe = "$line".Split('|', 2)
            $parts = $version.Split('.')
            if ([int]$parts[0] -gt 3 -or ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 11)) {
                if (Test-Path -LiteralPath $exe -PathType Leaf) { return [pscustomobject]@{ Exe = $exe; Found = @() } }
            }
            $found += "Python $version ($($c -join ' '))"
        }
        [pscustomobject]@{ Exe = $null; Found = $found }
    }

    function CloneCheckout {
        $what = $repo + $(if ($ref) { " ($ref)" } else { '' })
        Say "Cloning $what into $checkout"
        $parent = Split-Path -Parent $checkout
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        # Cloned next to the target and moved into place when complete. The name must be free, so that nothing
        # this run did not create is ever removed.
        $partial = "$checkout.partial.$PID"
        if (Test-Path -LiteralPath $partial) {
            Die "$partial already exists." @('If it is left over from an interrupted installation, remove it and run the installer again.')
        }
        $cloneArgs = @('-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1')
        if ($ref) { $cloneArgs += @('--branch', $ref) }
        $r = RunGit ($cloneArgs + @('--', $repo, $partial))
        if (-not $r.Ok) {
            if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Recurse -Force }
            $at = $(if ($ref) { " at $ref" } else { '' })
            Die "could not clone $repo$at." @($r.Out + 'Check the network, the URL (BENCHMANIA_REPO) and the branch or tag (BENCHMANIA_REF).')
        }
        # Paths in the checkout can exceed 260 characters; git needs this to work in it.
        $null = RunGit @('-C', $partial, 'config', 'core.longpaths', 'true')
        if (Test-Path -LiteralPath $checkout) { Remove-Item -LiteralPath $checkout -Force } # an empty directory
        Move-Item -LiteralPath $partial -Destination $checkout
    }

    function UpdateCheckout {
        $target = $ref
        if (-not $target) {
            $r = G @('ls-remote', '--symref', 'origin', 'HEAD')
            foreach ($l in $r.Out) { if ($l -match '^ref:\s+refs/heads/(\S+)\s+HEAD$') { $target = $Matches[1]; break } }
            if (-not $target) { Die "could not determine the default branch of $repo." }
        }
        if ((G @('ls-remote', 'origin', "refs/heads/$target")).Text) { $kind = 'branch' }
        elseif ((G @('ls-remote', 'origin', "refs/tags/$target")).Text) { $kind = 'tag' }
        else { Die "$repo has no branch or tag named '$target' (or it could not be reached)." }
        Say "Updating $checkout to $kind $target"
        $spec = $(if ($kind -eq 'branch') { "refs/heads/$target" } else { "refs/tags/$target" })
        if (-not (G @('fetch', '--quiet', 'origin', $spec)).Ok) { Die "could not fetch $target from $repo." }
        $new = (G @('rev-parse', 'FETCH_HEAD^{commit}')).Text
        $old = (G @('rev-parse', 'HEAD')).Text
        $current = (G @('symbolic-ref', '--quiet', '--short', 'HEAD')).Text
        $attach = $false
        if ($kind -eq 'branch' -and $current -ne $target) {
            if (-not $current -and -not (G @('show-ref', '--verify', '--quiet', "refs/heads/$target")).Ok) {
                $attach = $true # detached (e.g. installed from a tag) and no local branch of that name yet
            } else {
                $where = $(if ($current) { "branch '$current'" } else { 'a detached HEAD' })
                Die "$checkout is on $where, not on '$target', so it was not updated." @(
                    "Switch back with: git -C '$checkout' switch $target   (your own branches are kept), then run the installer again.")
            }
        }
        if ($old -ne $new -and -not (G @('merge-base', '--is-ancestor', $old, $new)).Ok) {
            $short = (G @('rev-parse', '--short', 'HEAD')).Text
            Die "$target is not a fast-forward of the installed commit $short, so it was not updated." @(
                "Local commits or a rewritten upstream history are kept as they are. Inspect with: git -C '$checkout' log --oneline -5")
        }
        # --no-overwrite-ignore: git stops for an untracked file that the new commit would replace, but by
        # default silently replaces an ignored one.
        if ($attach) {
            $r = G @('-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--no-overwrite-ignore', '-b', $target, $new)
        } elseif ($old -eq $new) {
            Say 'Already up to date.'
            return 'is up to date'
        } elseif ($kind -eq 'branch') {
            $r = G @('merge', '--quiet', '--ff-only', '--no-overwrite-ignore', $new)
        } else {
            $r = G @('-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--no-overwrite-ignore', '--detach', $new)
        }
        if (-not $r.Ok) {
            Die "could not move $checkout to $target, so it was not updated." @($r.Out + 'A file of yours that is in the way is kept. Move it away, then run the installer again.')
        }
        if ($old -eq $new) { Say "Now on branch $target." }
        else { Say "Updated $((G @('rev-parse', '--short', $old)).Text) -> $((G @('rev-parse', '--short', 'HEAD')).Text)" }
        'updated'
    }

    # Appends $bin to the user Path in the registry, keeping its value type (REG_EXPAND_SZ) and any %VARIABLES%
    # in it unexpanded, and tells running programs that the environment changed. Never touches the machine Path.
    function AddToUserPath([string]$Dir) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        if (-not $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }
        try {
            $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
            if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
            if (OnPath $raw $Dir) { return $false }
            $value = $(if ($raw.Trim(';')) { $raw.TrimEnd(';') + ';' + $Dir } else { $Dir })
            $key.SetValue('Path', $value, $kind)
        } finally { $key.Close() }
        # Setting a user variable through .NET broadcasts WM_SETTINGCHANGE ("Environment"), so that Explorer and
        # new terminals see the new Path. Removing a variable that does not exist changes nothing else.
        [Environment]::SetEnvironmentVariable('BENCHMANIA_INSTALLER_NOTIFY', $null, 'User')
        $true
    }

    function Install {
        if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
            Die 'this installer is for Windows.' @(
                'On Linux and macOS use: curl -fsSL https://benchmania.cleson.dev/install.sh | sh')
        }
        $repo = $(if ($env:BENCHMANIA_REPO) { $env:BENCHMANIA_REPO } else { 'https://github.com/Cripacx/benchmania' })
        $ref = "$env:BENCHMANIA_REF"
        if (-not $env:LOCALAPPDATA -or -not $env:USERPROFILE) { Die 'LOCALAPPDATA and USERPROFILE must be set.' }
        # %NAME% is cmd.exe syntax: PowerShell would create a directory with that literal name, and Windows
        # would expand it again in the user Path.
        foreach ($name in 'BENCHMANIA_HOME', 'BENCHMANIA_BIN') {
            if ("$([Environment]::GetEnvironmentVariable($name))".Contains('%')) {
                Die "$name contains a % sign; PowerShell does not expand %NAME%." @("Write `$env:NAME instead, for example: `$env:$name = `"`$env:USERPROFILE\tools`"")
            }
        }
        $checkout = FullPath $(if ($env:BENCHMANIA_HOME) { $env:BENCHMANIA_HOME } else { Join-Path $env:LOCALAPPDATA 'benchmania' })
        $bin = FullPath $(if ($env:BENCHMANIA_BIN) { $env:BENCHMANIA_BIN } else { Join-Path $env:USERPROFILE '.local\bin' })
        $launcher = Join-Path $bin 'benchmania.cmd'

        # --- Requirements ---------------------------------------------------------------------------------
        $gitCmd = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $gitCmd) {
            Die 'git is required but was not found.' @('Install Git for Windows (https://git-scm.com/download/win, or: winget install Git.Git), open a new terminal and run the installer again.')
        }
        $gitExe = $gitCmd.Source
        $py = FindPython
        if (-not $py.Exe) {
            if ($py.Found.Count) {
                Die "Python 3.11 or newer is required; found $($py.Found -join ', ')." @('Install a newer Python (https://www.python.org/downloads/windows/, or: winget install Python.Python.3.13), open a new terminal and run the installer again.')
            }
            Die 'Python 3.11 or newer is required but was not found (tried py -3, python and python3).' @('Install it (https://www.python.org/downloads/windows/, or: winget install Python.Python.3.13), open a new terminal and run the installer again.', 'The python.exe placeholder of the Microsoft Store does not count.')
        }

        # --- Refuse to overwrite a file that is not ours, before doing any work --------------------------
        if ((Test-Path -LiteralPath $launcher) -and -not (IsOurs $launcher)) {
            Die "$launcher already exists and was not written by this installer." @(
                'Remove or rename it, or choose another directory with BENCHMANIA_BIN, then run the installer again.')
        }

        # --- Install or update the checkout ----------------------------------------------------------------
        if (Test-Path -LiteralPath (Join-Path $checkout '.git')) {
            if (-not (G @('rev-parse', '--git-dir')).Ok) { Die "$checkout\.git exists but is not a usable git checkout." }
            $origin = (G @('config', '--get', 'remote.origin.url')).Text
            if ((Canonical $origin) -ne (Canonical $repo)) {
                $what = $(if ($origin) { $origin } else { 'a repository without an origin' })
                Die "$checkout is a checkout of $what, not of $repo." @(
                    'Choose another directory with BENCHMANIA_HOME, or set BENCHMANIA_REPO to that repository.')
            }
            $changed = G @('status', '--porcelain', '--untracked-files=no')
            if (-not $changed.Ok) { Die "could not read the state of $checkout." $changed.Out }
            if ($changed.Text) {
                Die "$checkout has modified tracked files, so it was not updated:" @($changed.Out + "Commit, stash or revert them (git -C '$checkout' status), then run the installer again.")
            }
            $null = G @('config', 'core.longpaths', 'true')
            $action = UpdateCheckout
        } elseif ((Test-Path -LiteralPath $checkout) -and
                  (-not (Test-Path -LiteralPath $checkout -PathType Container) -or @(Get-ChildItem -LiteralPath $checkout -Force).Count)) {
            Die "$checkout exists and is not a git checkout." @('Remove it, or choose another directory with BENCHMANIA_HOME.')
        } else {
            CloneCheckout
            $action = 'installed'
        }

        # --- Launcher: written in the console code page that cmd.exe reads it in --------------------------
        New-Item -ItemType Directory -Force -Path $bin | Out-Null
        $oem = [System.Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
        $wrapper = Join-Path $checkout 'benchmania'
        $text = "@echo off`r`nrem $marker Run the installer again to update.`r`n" +
                "`"$($py.Exe -replace '%', '%%')`" `"$($wrapper -replace '%', '%%')`" %*`r`n"
        if ($oem.GetString($oem.GetBytes($text)) -ne $text) {
            Die "the path $wrapper or $($py.Exe) cannot be written in a cmd.exe launcher (code page $($oem.CodePage))." @(
                'Choose a checkout directory with plain ASCII characters with BENCHMANIA_HOME.')
        }
        $tmp = "$launcher.tmp." + [guid]::NewGuid().ToString('N')
        [System.IO.File]::WriteAllBytes($tmp, $oem.GetBytes($text))
        Move-Item -LiteralPath $tmp -Destination $launcher -Force

        # --- PATH --------------------------------------------------------------------------------------------
        $pathNote = @()
        if ($env:BENCHMANIA_NO_MODIFY_PATH -eq '1') {
            if (-not (OnPath $env:Path $bin)) {
                $pathNote = @("$bin is not on your PATH (BENCHMANIA_NO_MODIFY_PATH=1). For this window:",
                    "  `$env:Path += ';$bin'",
                    'To keep it, add it under "Edit environment variables for your account", or call the command by its full path.')
            }
        } else {
            $machine = [string][Environment]::GetEnvironmentVariable('Path', 'Machine')
            if (-not (OnPath $machine $bin) -and (AddToUserPath $bin)) {
                $pathNote = @("Added $bin to your user Path. New terminals find benchmania, and so does this PowerShell session.")
            }
            if (-not (OnPath $env:Path $bin)) { $env:Path = $env:Path.TrimEnd(';') + ';' + $bin }
        }

        # --- Summary -------------------------------------------------------------------------------------------
        $commit = (G @('rev-parse', '--short', 'HEAD')).Text
        Say ''
        Say "Benchmania ${action}: $checkout (commit $commit)"
        Say "Command: $launcher"
        if ($pathNote) { Say ''; $pathNote | ForEach-Object { Say $_ } }
        Say ''
        Say 'Note: on Windows the command can list, validate, scaffold and publish. Measuring needs Linux with Docker.'
        Say '      Inside WSL2 use the Linux installer: curl -fsSL https://benchmania.cleson.dev/install.sh | sh'
        Say '      (measuring in WSL2 is untested).'
        Say ''
        Say 'Next:'
        Say '  benchmania doctor      check whether this machine can measure'
        Say '  benchmania list        show the domains, scenarios and implementations'
        Say '  benchmania validate    check the manifests and result bundles'
        Say ''
        Say 'Update:    run the installer again.'
        Say "Uninstall: Remove-Item -Recurse -Force '$checkout', '$launcher'   (copy your results\ first)"
        Say "           and remove $bin from your user Path if nothing else uses it."
    }

    try {
        Install
    } catch {
        $e = $_.Exception
        $details = $(if ($e.Data.Contains('details')) { @($e.Data['details']) } else { @() })
        if (-not $e.Data.Contains('details')) { $details = @($_.InvocationInfo.PositionMessage) }
        $Host.UI.WriteErrorLine("error: $($e.Message)")
        foreach ($d in $details) { if ("$d") { $Host.UI.WriteErrorLine("       $d") } }
        $Host.UI.WriteErrorLine('Benchmania was not installed or updated.')
        $global:LASTEXITCODE = 1
        if ($asFile) { exit 1 } # a script file run on its own; through iex this line is never reached
    }
}
