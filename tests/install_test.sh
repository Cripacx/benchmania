#!/bin/sh
# End-to-end tests for install.sh against a local bare repository built from the working tree
# (committed and uncommitted files, as git sees them, .gitignore respected). Needs sh, git and python3 3.11+.
#
#   sh tests/install_test.sh
#
# Everything happens below a temporary directory (in $TMPDIR when set); the working tree is not changed.
# The snapshot commit's objects are written to this repository's object store, where git gc removes them.

set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
installer=$root/install.sh
work=$(mktemp -d "${TMPDIR:-/tmp}/benchmania-install-test.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM
sh_bin=$(command -v sh)
passed=0
failed=0

pass() { passed=$((passed + 1)); printf 'ok    %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL  %s\n' "$1"; [ ! -f "$work/out" ] || tail -n 8 "$work/out" | sed "s/^/      | /"; }
check() { # check "description" command...
    what=$1
    shift
    if "$@"; then pass "$what"; else fail "$what"; fi
}
contains() { grep -qF -- "$1" "$work/out"; }
lacks() { ! grep -qF -- "$1" "$work/out"; }

# --- A bare upstream repository with one commit: a snapshot of the working tree ---------------------------
upstream=$work/upstream.git
git init --quiet --bare "$upstream"
git -C "$upstream" symbolic-ref HEAD refs/heads/main
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
index=$work/snapshot.index
GIT_INDEX_FILE=$index git -C "$root" read-tree HEAD
GIT_INDEX_FILE=$index git -C "$root" -c core.safecrlf=false add -A
tree=$(GIT_INDEX_FILE=$index git -C "$root" write-tree)
first=$(git -C "$root" commit-tree "$tree" -m "snapshot of the working tree")
git -C "$root" push --quiet "$upstream" "$first:refs/heads/main" "$first:refs/tags/v-test"
case $upstream in
    /*) repo_url=file://$upstream ;; # file:// so that --depth applies as it does for a remote
    *) repo_url=$upstream ;;
esac

# A developer clone that moves the upstream forward.
git clone --quiet "$upstream" "$work/dev"
advance() {
    printf '%s\n' "$1" >"$work/dev/UPSTREAM_CHANGE.txt"
    git -C "$work/dev" add UPSTREAM_CHANGE.txt
    git -C "$work/dev" commit --quiet -m "$1"
    git -C "$work/dev" push --quiet origin HEAD:main
}

# clean_env NAME [VAR=value...] command...: runs the command with HOME=$work/NAME and none of the installer's
# settings except the given ones.
clean_env() {
    name=$1
    shift
    mkdir -p "$work/$name"
    env -u BENCHMANIA_HOME -u BENCHMANIA_BIN -u BENCHMANIA_REF -u XDG_DATA_HOME -u BENCHCORE_ROOT \
        HOME="$work/$name" BENCHMANIA_REPO="$repo_url" "$@"
}
# run_installer NAME [VAR=value...]: runs install.sh that way; its output goes to $work/out, its exit code to $status.
run_installer() {
    status=0
    clean_env "$@" "$sh_bin" "$installer" >"$work/out" 2>&1 || status=$?
    return 0
}
home_of() { printf '%s' "$work/$1/.local/share/benchmania"; }
launcher_of() { printf '%s' "$work/$1/.local/bin/benchmania"; }
head_of() { git -C "$(home_of "$1")" rev-parse HEAD; }

# --- Fresh install with the default paths ------------------------------------------------------------------
run_installer a
H=$(home_of a)
L=$(launcher_of a)
check "fresh install exits 0" [ "$status" -eq 0 ]
check "checkout is a git repository at the default path" [ -d "$H/.git" ]
check "checkout is at the snapshot commit" [ "$(head_of a)" = "$first" ]
check "launcher is executable" [ -x "$L" ]
check "launcher carries the marker" grep -qF "written by the Benchmania installer" "$L"
check "summary names the checkout" contains "Benchmania installed: $H"
check "summary prints the PATH line" contains "export PATH='$work/a/.local/bin':\"\$PATH\""
if [ "$(uname -s)" = Linux ] && command -v docker >/dev/null 2>&1; then
    check "summary shows a run with --label" contains '--label "My workstation"'
else # not a machine that can measure: the summary says so and suggests no run
    check "summary notes that this machine cannot measure" contains "Note: "
    check "summary suggests no run where measuring is impossible" lacks '--label "My workstation"'
fi
check "summary says how to uninstall" contains "rm -rf '$H' '$L'"

mkdir -p "$work/elsewhere"
(cd "$work/elsewhere" && "$L" --version) >"$work/out" 2>&1 || true
check "launcher runs --version from an unrelated directory" contains "Benchmania engine"
(cd "$work/elsewhere" && "$L" list) >"$work/out" 2>&1 || true
check "launcher runs list from an unrelated directory" contains "implementations:"

# --- Second run without changes ----------------------------------------------------------------------------
run_installer a
check "second run exits 0" [ "$status" -eq 0 ]
check "second run reports up to date" contains "Benchmania is up to date: $H"
check "second run keeps the commit" [ "$(head_of a)" = "$first" ]

# --- Update after the upstream moved; an untracked result bundle survives ------------------------------------
mkdir -p "$H/results/example/test-machine"
echo '{"kept": true}' >"$H/results/example/test-machine/run.json"
advance "second commit"
second=$(git -C "$work/dev" rev-parse HEAD)
run_installer a
check "update exits 0" [ "$status" -eq 0 ]
check "update fast-forwards to the new upstream commit" [ "$(head_of a)" = "$second" ]
check "update reports old and new commit" contains "Updated "
check "untracked result bundle survives the update" grep -qF '"kept": true' "$H/results/example/test-machine/run.json"

# --- Refusal when a tracked file is modified -----------------------------------------------------------------
echo "local edit" >>"$H/README.md"
advance "third commit"
run_installer a
check "modified tracked file: exits non-zero" [ "$status" -ne 0 ]
check "modified tracked file: says so" contains "modified tracked files"
check "modified tracked file: names the file" contains "README.md"
check "modified tracked file: checkout not moved" [ "$(head_of a)" = "$second" ]
check "modified tracked file: edit kept" grep -qF "local edit" "$H/README.md"
git -C "$H" checkout --quiet -- README.md
run_installer a
check "after reverting the edit the update succeeds" [ "$(head_of a)" = "$(git -C "$work/dev" rev-parse HEAD)" ]

# --- An ignored local file is kept when the upstream starts tracking its path ---------------------------------
mkdir -p "$H/.git/info"
echo "local-notes.txt" >>"$H/.git/info/exclude"
echo "mine" >"$H/local-notes.txt"
before=$(head_of a)
echo "upstream" >"$work/dev/local-notes.txt"
git -C "$work/dev" add local-notes.txt
advance "upstream tracks local-notes.txt"
run_installer a
check "ignored file in the way: exits non-zero" [ "$status" -ne 0 ]
check "ignored file in the way: file kept" [ "$(cat "$H/local-notes.txt")" = mine ]
check "ignored file in the way: checkout not moved" [ "$(head_of a)" = "$before" ]
check "ignored file in the way: says what to do" contains "Move it away"
rm "$H/local-notes.txt"
run_installer a
check "after moving the file away the update succeeds" [ "$(head_of a)" = "$(git -C "$work/dev" rev-parse HEAD)" ]

# --- Pinning a tag with BENCHMANIA_REF --------------------------------------------------------------------
run_installer pinned BENCHMANIA_REF=v-test
check "pinned install exits 0" [ "$status" -eq 0 ]
check "pinned install is at the tag" [ "$(head_of pinned)" = "$first" ]
run_installer pinned BENCHMANIA_REF=v-test
check "pinned re-run exits 0" [ "$status" -eq 0 ]
check "pinned re-run stays at the tag" [ "$(head_of pinned)" = "$first" ]
run_installer pinned
check "unpinned re-run exits 0" [ "$status" -eq 0 ]
check "unpinned re-run moves to the default branch" [ "$(head_of pinned)" = "$(git -C "$work/dev" rev-parse HEAD)" ]
check "unpinned re-run is on the branch" [ "$(git -C "$(home_of pinned)" symbolic-ref --short HEAD)" = main ]

# --- Custom paths through BENCHMANIA_HOME and BENCHMANIA_BIN ---------------------------------------------
run_installer custom BENCHMANIA_HOME="$work/custom/checkout" BENCHMANIA_BIN="$work/custom/bin" PATH="$work/custom/bin:$PATH"
check "custom paths: exits 0" [ "$status" -eq 0 ]
check "custom paths: launcher in BENCHMANIA_BIN" [ -x "$work/custom/bin/benchmania" ]
check "custom paths: checkout in BENCHMANIA_HOME" [ -d "$work/custom/checkout/.git" ]
check "custom paths: no PATH line when BENCHMANIA_BIN is on PATH" lacks "export PATH="

# --- Paths with a space, a quote and (where it is not a path separator) a backslash ---------------------------
case $(uname -s) in
    # Git Bash: a backslash separates directories, and a path with a quote is not translated for git.exe.
    MINGW* | MSYS* | CYGWIN*) odd="$work/odd dir" ;;
    # A literal backslash followed by n: echo would turn it into a line break in some shells.
    *) odd="$work/o'dd dir/back\\name" ;;
esac
run_installer odd BENCHMANIA_HOME="$odd/checkout" BENCHMANIA_BIN="$odd/bin"
check "odd paths: exits 0" [ "$status" -eq 0 ]
(cd "$work/elsewhere" && "$odd/bin/benchmania" --version) >"$work/out" 2>&1 || true
check "odd paths: launcher works" contains "Benchmania engine"

# --- Refusal when the launcher path holds a foreign file -----------------------------------------------------
mkdir -p "$work/foreign/.local/bin"
echo "#!/bin/sh" >"$(launcher_of foreign)"
run_installer foreign
check "foreign launcher: exits non-zero" [ "$status" -ne 0 ]
check "foreign launcher: explains" contains "was not written by this installer"
check "foreign launcher: file unchanged" [ "$(cat "$(launcher_of foreign)")" = "#!/bin/sh" ]
check "foreign launcher: nothing cloned" [ ! -e "$(home_of foreign)" ]

# --- Refusal when the home directory is a checkout of another repository ------------------------------------
other=$(home_of other)
mkdir -p "$other"
git init --quiet "$other"
git -C "$other" remote add origin https://example.invalid/other.git
run_installer other
check "other repository: exits non-zero" [ "$status" -ne 0 ]
check "other repository: explains" contains "is a checkout of https://example.invalid/other.git"
check "other repository: no launcher written" [ ! -e "$(launcher_of other)" ]

# --- Refusal when the home directory exists and is not a checkout ------------------------------------------
mkdir -p "$(home_of plain)"
echo "mine" >"$(home_of plain)/notes.txt"
run_installer plain
check "non-checkout directory: exits non-zero" [ "$status" -ne 0 ]
check "non-checkout directory: file kept" [ "$(cat "$(home_of plain)/notes.txt")" = mine ]

# --- A failing clone leaves no launcher ----------------------------------------------------------------------
run_installer broken BENCHMANIA_REPO="$work/does-not-exist.git"
check "failing clone: exits non-zero" [ "$status" -ne 0 ]
check "failing clone: no launcher" [ ! -e "$(launcher_of broken)" ]
check "failing clone: no checkout or partial directory" [ -z "$(ls -A "$work/broken/.local/share" 2>/dev/null)" ]

# --- A repository value that starts with a dash is not read as an option -------------------------------------
run_installer dash BENCHMANIA_REPO=--upload-pack=touch-dash-marker
check "dash repository: exits non-zero" [ "$status" -ne 0 ]
check "dash repository: reported as a repository that could not be cloned" contains "could not clone --upload-pack=touch-dash-marker"
check "dash repository: git saw it as the repository, not as an option" contains "repository '--upload-pack=touch-dash-marker' does not exist"
check "dash repository: no checkout or partial directory" [ -z "$(ls -A "$work/dash/.local/share" 2>/dev/null)" ]

# --- The checkout directory as launcher directory: the checkout's own benchmania file is not replaced --------
run_installer same BENCHMANIA_HOME="$work/same/dir" BENCHMANIA_BIN="$work/same/dir"
check "launcher directory is the checkout: exits non-zero" [ "$status" -ne 0 ]
check "launcher directory is the checkout: explains" contains "was not written by this installer"
check "launcher directory is the checkout: checkout unchanged" [ -z "$(git -C "$work/same/dir" status --porcelain)" ]

# --- Execution through a pipe -------------------------------------------------------------------------------
status=0
# shellcheck disable=SC2002 # the point is a pipe, as in curl ... | sh
cat "$installer" | clean_env piped "$sh_bin" >"$work/out" 2>&1 || status=$?
check "piped install exits 0" [ "$status" -eq 0 ]
check "piped install writes the launcher" [ -x "$(launcher_of piped)" ]
(cd "$work/elsewhere" && "$(launcher_of piped)" --version) >"$work/out" 2>&1 || true
check "piped install: launcher works" contains "Benchmania engine"

# --- A download that ends inside the last line, after the function's name, runs nothing ----------------------
status=0
# shellcheck disable=SC2016 # the text of the script's last line, cut before its closing brace
{ sed '$d' "$installer" && printf '%s' '{ benchmania_install "$@";'; } | clean_env truncated "$sh_bin" >"$work/out" 2>&1 || status=$?
check "truncated download: exits non-zero" [ "$status" -ne 0 ]
check "truncated download: nothing installed" [ ! -e "$work/truncated/.local" ]
check "the cut is where the test assumes: the last line calls the function inside braces" \
    [ "$(tail -n 1 "$installer")" = '{ benchmania_install "$@"; }' ]

# --- A required tool is missing (simulated with PATH) -------------------------------------------------------
mkdir -p "$work/oldpy/bin"
# shellcheck disable=SC2016 # the fake python3 expands $1 itself
printf '#!/bin/sh\n[ "${1:-}" = --version ] && echo "Python 3.9.2"\nexit 1\n' >"$work/oldpy/bin/python3"
chmod 755 "$work/oldpy/bin/python3"
run_installer oldpy PATH="$work/oldpy/bin:$PATH"
check "python3 too old: exits non-zero" [ "$status" -ne 0 ]
check "python3 too old: names the required version and the one found" contains "Python 3.11 or newer is required; python3 is Python 3.9.2"
check "python3 too old: nothing installed" [ ! -e "$work/oldpy/.local" ]

mkdir -p "$work/nopy/bin"
cp "$(command -v git)" "$work/nopy/bin/" # git only, so that the python3 check is the one that fails
run_installer nopy PATH="$work/nopy/bin"
check "python3 absent: exits non-zero" [ "$status" -ne 0 ]
check "python3 absent: says so" contains "python3 is required but was not found"
check "python3 absent: nothing installed" [ ! -e "$work/nopy/.local" ]

echo
echo "install_test: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
