#!/bin/sh
# usage: fetch.sh <repository> <commit> <dir>: check out exactly one commit (shallow, no history).
set -eu
git init -q "$3"
git -C "$3" fetch -q --depth 1 "$1" "$2"
git -C "$3" checkout -q FETCH_HEAD
test "$(git -C "$3" rev-parse HEAD)" = "$2"
rm -rf "$3/.git"
