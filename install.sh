#!/bin/sh
# Benchmania installer: puts the benchmania command on this machine.
#
#   curl -fsSL https://benchmania.cleson.dev/install.sh | sh
#
# It clones the Benchmania repository (a normal git checkout: result bundles record its commit, and you open
# your results pull request from it) and writes a small launcher script. It needs git and Python 3.11 or newer,
# never uses sudo, never edits shell start-up files and writes only to the two paths below.
# Running it again updates the checkout by fast-forward; untracked files such as your results are kept.
#
# Settings (environment variables):
#   BENCHMANIA_REPO  repository to clone      (default: https://github.com/Cripacx/benchmania)
#   BENCHMANIA_REF   branch or tag to install (default: the repository's default branch)
#   BENCHMANIA_HOME  checkout directory       (default: ${XDG_DATA_HOME:-$HOME/.local/share}/benchmania)
#   BENCHMANIA_BIN   launcher directory       (default: $HOME/.local/bin)
#
# Uninstall: remove BENCHMANIA_HOME and BENCHMANIA_BIN/benchmania.
#
# Everything happens inside benchmania_install, which is called on the last line: a truncated download runs nothing.

set -eu

benchmania_install() {
    repo=${BENCHMANIA_REPO:-https://github.com/Cripacx/benchmania}
    ref=${BENCHMANIA_REF:-}
    if [ -z "${HOME:-}" ]; then
        echo "error: HOME is not set" >&2
        exit 1
    fi
    home=${BENCHMANIA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/benchmania}
    bin=${BENCHMANIA_BIN:-$HOME/.local/bin}
    case $home in /*) ;; *) home=$(pwd)/$home ;; esac
    case $bin in /*) ;; *) bin=$(pwd)/$bin ;; esac
    home=${home%/}
    bin=${bin%/}
    launcher=$bin/benchmania
    marker="# Launcher written by the Benchmania installer."

    say() { printf '%s\n' "$*"; }
    die() {
        printf 'error: %s\n' "$1" >&2
        shift
        for line in "$@"; do printf '       %s\n' "$line" >&2; done
        exit 1
    }
    # The URL without a trailing slash or .git, so that equivalent spellings compare equal.
    canonical() { printf '%s' "$1" | sed -e 's|/*$||' -e 's|\.git$||'; }
    # A value as one single-quoted shell word, for commands that are written to a file or printed for pasting.
    squote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

    clone_checkout() {
        say "Cloning $repo${ref:+ ($ref)} into $home"
        mkdir -p "$(dirname "$home")"
        # Cloned next to the target and moved into place when complete. mkdir fails if the name is taken, so
        # nothing that this run did not create is ever removed.
        partial=$home.partial.$$
        mkdir "$partial" || die "could not create $partial (see above)." \
            "If it is left over from an interrupted installation, remove it and run the installer again."
        if ! git -c advice.detachedHead=false clone --quiet --depth 1 ${ref:+--branch "$ref"} -- "$repo" "$partial"; then
            rm -rf "$partial"
            die "could not clone $repo${ref:+ at $ref}." "Check the network, the URL (BENCHMANIA_REPO) and the branch or tag (BENCHMANIA_REF)."
        fi
        if [ -d "$home" ]; then rmdir "$home"; fi # an empty directory
        mv "$partial" "$home"
    }

    update_checkout() {
        g() { git -C "$home" "$@"; }
        target=$ref
        if [ -z "$target" ]; then
            target=$(g ls-remote --symref origin HEAD | awk '$1 == "ref:" { sub("^refs/heads/", "", $2); print $2; exit }')
            [ -n "$target" ] || die "could not determine the default branch of $repo."
        fi
        if [ -n "$(g ls-remote origin "refs/heads/$target")" ]; then
            kind=branch
        elif [ -n "$(g ls-remote origin "refs/tags/$target")" ]; then
            kind=tag
        else
            die "$repo has no branch or tag named '$target' (or it could not be reached)."
        fi
        say "Updating $home to $kind $target"
        if [ "$kind" = branch ]; then spec=refs/heads/$target; else spec=refs/tags/$target; fi
        g fetch --quiet origin "$spec" || die "could not fetch $target from $repo."
        new=$(g rev-parse "FETCH_HEAD^{commit}")
        old=$(g rev-parse HEAD)
        current=$(g symbolic-ref --quiet --short HEAD || true)
        attach=""
        if [ "$kind" = branch ] && [ "$current" != "$target" ]; then
            if [ -z "$current" ] && ! g show-ref --verify --quiet "refs/heads/$target"; then
                attach=yes # detached (e.g. installed from a tag) and no local branch of that name yet
            else
                where="a detached HEAD"
                [ -z "$current" ] || where="branch '$current'"
                die "$home is on $where, not on '$target', so it was not updated." \
                    "Switch back with: git -C $(squote "$home") switch $target   (your own branches are kept), then run the installer again."
            fi
        fi
        if [ "$old" != "$new" ] && ! g merge-base --is-ancestor "$old" "$new"; then
            die "$target is not a fast-forward of the installed commit $(g rev-parse --short HEAD), so it was not updated." \
                "Local commits or a rewritten upstream history are kept as they are. Inspect with: git -C $(squote "$home") log --oneline -5"
        fi
        # --no-overwrite-ignore: git stops for an untracked file that the new commit would replace, but by
        # default silently replaces an ignored one.
        if [ -n "$attach" ]; then
            set -- checkout --quiet --no-overwrite-ignore -b "$target" "$new"
        elif [ "$old" = "$new" ]; then
            say "Already up to date."
            action="is up to date"
            return 0
        elif [ "$kind" = branch ]; then
            set -- merge --quiet --ff-only --no-overwrite-ignore "$new"
        else
            set -- checkout --quiet --no-overwrite-ignore --detach "$new"
        fi
        g -c advice.detachedHead=false "$@" || die "could not move $home to $target (see above), so it was not updated." \
            "A file of yours that is in the way is kept. Move it away, then run the installer again."
        if [ "$old" = "$new" ]; then
            say "Now on branch $target."
        else
            say "Updated $(g rev-parse --short "$old") -> $(g rev-parse --short HEAD)"
        fi
    }

    # --- Requirements -------------------------------------------------------------------------------------
    command -v git >/dev/null 2>&1 || die "git is required but was not found." "Install git with your package manager and run the installer again."
    command -v python3 >/dev/null 2>&1 || die "python3 is required but was not found." "Install Python 3.11 or newer and run the installer again."
    if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
        found=$(python3 --version 2>&1 || true)
        die "Python 3.11 or newer is required; python3 is ${found:-unusable}." "Install a newer Python so that python3 points to it, then run the installer again."
    fi
    notes=""
    if [ "$(uname -s 2>/dev/null || echo unknown)" != Linux ]; then
        notes="This is not Linux: measuring needs Linux with Docker. list, validate, scaffold and publish work here."
    elif ! command -v docker >/dev/null 2>&1; then
        notes="Docker was not found: measuring needs it. list, validate, scaffold and publish work without it."
    fi

    # --- Refuse to overwrite a file that is not ours, before doing any work ----------------------------------
    if { [ -e "$launcher" ] || [ -L "$launcher" ]; } && ! grep -qF "$marker" "$launcher" 2>/dev/null; then
        die "$launcher already exists and was not written by this installer." \
            "Remove or rename it, or choose another directory with BENCHMANIA_BIN, then run the installer again."
    fi

    # --- Install or update the checkout ----------------------------------------------------------------------
    if [ -e "$home/.git" ]; then
        git -C "$home" rev-parse --git-dir >/dev/null 2>&1 || die "$home/.git exists but is not a usable git checkout."
        origin=$(git -C "$home" config --get remote.origin.url || true)
        if [ "$(canonical "$origin")" != "$(canonical "$repo")" ]; then
            die "$home is a checkout of ${origin:-a repository without an origin}, not of $repo." \
                "Choose another directory with BENCHMANIA_HOME, or set BENCHMANIA_REPO to that repository."
        fi
        changed=$(git -C "$home" status --porcelain --untracked-files=no)
        if [ -n "$changed" ]; then
            die "$home has modified tracked files, so it was not updated:" "$changed" \
                "Commit, stash or revert them (git -C $(squote "$home") status), then run the installer again."
        fi
        action=updated
        update_checkout
    elif [ -e "$home" ] && [ -n "$(ls -A "$home" 2>/dev/null || echo x)" ]; then
        die "$home exists and is not a git checkout." "Remove it, or choose another directory with BENCHMANIA_HOME."
    else
        clone_checkout
        action=installed
    fi

    # --- Launcher ----------------------------------------------------------------------------------------------
    mkdir -p "$bin"
    tmp=$(mktemp "$launcher.tmp.XXXXXX")
    # printf, not echo: some shells' echo would interpret a backslash in the path.
    printf '%s\n' '#!/bin/sh' "$marker Run the installer again to update." \
        "exec python3 $(squote "$home/benchmania") \"\$@\"" >"$tmp"
    chmod 755 "$tmp"
    mv -f "$tmp" "$launcher"

    # --- Summary -----------------------------------------------------------------------------------------------
    commit=$(git -C "$home" rev-parse --short HEAD)
    domain=""
    for d in "$home"/domains/*/; do
        d=${d%/}
        d=${d##*/}
        case $d in _* | "*") continue ;; esac
        domain=$d
        break
    done
    say ""
    say "Benchmania $action: $home (commit $commit)"
    say "Command: $launcher"
    case ":${PATH:-}:" in
        *":$bin:"*) ;;
        *)
            say ""
            say "$bin is not on your PATH. Add this line to ~/.profile, ~/.bashrc or ~/.zshrc and open a new shell:"
            say "  export PATH=$(squote "$bin"):\"\$PATH\""
            ;;
    esac
    if [ -n "$notes" ]; then
        say ""
        say "Note: $notes"
    fi
    say ""
    say "Next:"
    say "  benchmania doctor      check that this machine can measure"
    say "  benchmania list        show the domains, scenarios and implementations"
    if [ -z "$notes" ]; then
        say "  benchmania run ${domain:-<domain>} --label \"My workstation\""
    else
        say "  benchmania validate    check the manifests and result bundles"
    fi
    say ""
    say "Update:    run the installer again."
    say "Uninstall: rm -rf $(squote "$home") $(squote "$launcher")   (copy your results/ first)"
}

benchmania_install "$@"
