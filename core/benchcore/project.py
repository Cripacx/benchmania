"""Project configuration (machbench.toml at the repository root).

All user-facing naming comes from here so the project can be renamed in one place.
"""

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_FILE = "machbench.toml"


@dataclass(frozen=True)
class Project:
    root: Path
    name: str
    slug: str
    tagline: str
    description: str
    repository: str
    site_url: str
    license: str
    data_license: str
    run: dict = field(default_factory=dict)

    def container(self, suffix):
        """Name for containers, images and labels owned by the platform."""
        return f"{self.slug}-{suffix}"

    @property
    def label(self):
        return f"{self.slug}.managed"

    def to_public(self):
        return {k: getattr(self, k) for k in
                ("name", "slug", "tagline", "description", "repository", "site_url", "license", "data_license")}


def find_root(start=None):
    """Walk up from `start` (default: cwd, then this file) to the directory holding the config file."""
    env = os.environ.get("BENCHCORE_ROOT")
    if env:
        return Path(env).resolve()
    for base in (Path(start or os.getcwd()), Path(__file__).resolve().parent):
        for p in (base, *base.parents):
            if (p / CONFIG_FILE).is_file():
                return p
    raise FileNotFoundError(f"{CONFIG_FILE} not found; run inside the repository or set BENCHCORE_ROOT")


def load(root=None):
    root = Path(root) if root else find_root()
    with open(root / CONFIG_FILE, "rb") as f:
        data = tomllib.load(f)
    p = data.get("project", {})
    missing = [k for k in ("name", "slug") if not p.get(k)]
    if missing:
        raise ValueError(f"{CONFIG_FILE}: [project] is missing {', '.join(missing)}")
    return Project(
        root=root,
        name=p["name"],
        slug=p["slug"],
        tagline=p.get("tagline", ""),
        description=p.get("description", ""),
        repository=p.get("repository", ""),
        site_url=p.get("site_url", ""),
        license=p.get("license", ""),
        data_license=p.get("data_license", ""),
        run=data.get("run", {}),
    )
