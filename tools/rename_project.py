#!/usr/bin/env python3
"""Rename the project everywhere.

Code reads the name from the config file at runtime, so the CLI, container names and the website follow the
config automatically. This tool updates the config itself plus the places where the name is plain text
(documentation, workflows, the wrapper script and the config file name).

    python3 tools/rename_project.py "NewName" [--slug newname] [--dry-run]

Result bundles and generated site data are left untouched; regenerate the site data with `publish`.
"""

import argparse
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", "node_modules", "dist", ".astro", "results", "__pycache__", ".pytest_cache", "data"}
TEXT_SUFFIXES = {".md", ".toml", ".py", ".yml", ".yaml", ".json", ".ts", ".tsx", ".astro", ".mjs", ".js", ".css",
                 ".html", ".txt", ".sh", ""}


def current_config():
    configs = [p for p in ROOT.glob("*.toml") if p.name != "pyproject.toml"]
    for p in configs:
        with open(p, "rb") as f:
            data = tomllib.load(f)
        if "project" in data and "slug" in data["project"]:
            return p, data["project"]["name"], data["project"]["slug"]
    sys.exit("project config not found")


def files():
    for p in ROOT.rglob("*"):
        if p.is_file() and not (set(p.relative_to(ROOT).parts[:-1]) & SKIP_DIRS) and p.suffix in TEXT_SUFFIXES:
            if p.name in ("package-lock.json", "Cargo.lock", "mix.lock", "go.sum"):
                continue
            yield p


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name")
    ap.add_argument("--slug", help="lowercase identifier (default: name lowercased, non-alphanumerics removed)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    config, old_name, old_slug = current_config()
    new_name = args.name
    new_slug = args.slug or re.sub(r"[^a-z0-9-]", "", new_name.lower())
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", new_slug):
        sys.exit(f"invalid slug {new_slug!r}")
    pairs = [(old_name, new_name), (old_slug.upper(), new_slug.upper()), (old_slug, new_slug)]
    changed = 0
    for p in files():
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, PermissionError):
            continue
        new = text
        for a, b in pairs:
            new = new.replace(a, b)
        if new != text:
            changed += 1
            print(f"update {p.relative_to(ROOT)}")
            if not args.dry_run:
                p.write_text(new, encoding="utf-8", newline="\n")
    renames = [(ROOT / old_slug, ROOT / new_slug), (config, ROOT / f"{new_slug}.toml")]
    for a, b in renames:
        if a.exists() and a != b:
            print(f"rename {a.relative_to(ROOT)} -> {b.relative_to(ROOT)}")
            if not args.dry_run:
                a.rename(b)
    print(f"{'would update' if args.dry_run else 'updated'} {changed} files: {old_name} -> {new_name}, "
          f"{old_slug} -> {new_slug}. Then run `python3 {new_slug} publish` to refresh the website data.")


if __name__ == "__main__":
    main()
