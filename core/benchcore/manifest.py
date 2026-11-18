"""Declarative manifests: domains, scenarios, implementations and metrics.

Layout on disk (everything below `domains/<domain-id>/`):

    domain.toml                 identity, harness entry point, service limits, headline metrics
    metrics.toml                metric registry for this domain (merged with core metrics)
    scenarios/<id>.toml         one file per scenario
    implementations/<id>/impl.toml + Dockerfile + sources

Loading never imports domain code; `load_harness` does that explicitly.
"""

import importlib.util
import re
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
STATUSES = ("stable", "experimental", "example")
CATEGORIES = ("bare", "micro", "framework", "fullstack", "tool")
BETTER = ("higher", "lower", "neutral")
CORE_METRICS = Path(__file__).with_name("metrics.toml")


class ManifestError(Exception):
    def __init__(self, problems):
        self.problems = problems
        super().__init__("\n".join(problems))


def _read(path):
    with open(path, "rb") as f:
        return tomllib.load(f)


@dataclass
class Metric:
    id: str
    label: str
    unit: str
    better: str
    group: str
    description: str = ""
    decimals: int = 0
    visibility: str = "secondary"  # primary | secondary | diagnostic

    def to_public(self):
        return dict(self.__dict__)


@dataclass
class Scenario:
    id: str
    title: str
    kind: str
    order: int
    description: str
    params: dict
    path: Path

    def to_public(self):
        return {"id": self.id, "title": self.title, "kind": self.kind, "order": self.order,
                "description": self.description, "params": self.params}


@dataclass
class Implementation:
    id: str
    name: str
    language: str
    category: str
    data: dict
    path: Path

    @property
    def build(self):
        return self.data.get("build", {})

    @property
    def run(self):
        return self.data.get("run", {})

    @property
    def skip(self):
        return set(self.data.get("skip_scenarios", []))

    def to_public(self):
        public = {k: v for k, v in self.data.items() if k not in ("build", "run")}
        public.update(id=self.id, name=self.name, language=self.language, category=self.category)
        return public


@dataclass
class Domain:
    id: str
    title: str
    summary: str
    status: str
    harness: str
    data: dict
    path: Path
    scenarios: list = field(default_factory=list)
    implementations: list = field(default_factory=list)
    metrics: dict = field(default_factory=dict)

    @property
    def service(self):
        return self.data.get("service", {})

    @property
    def defaults(self):
        return self.data.get("defaults", {})

    @property
    def headline(self):
        return self.data.get("headline", [])

    def scenario(self, sid):
        return next(s for s in self.scenarios if s.id == sid)

    def implementation(self, iid):
        return next(i for i in self.implementations if i.id == iid)

    def to_public(self):
        return {"id": self.id, "title": self.title, "summary": self.summary, "status": self.status,
                "service": self.service, "headline": self.headline,
                "description": self.data.get("description", "")}


def load_metrics(*paths):
    metrics, problems = {}, []
    for path in paths:
        if not path.is_file():
            continue
        for mid, m in _read(path).items():
            where = f"{path}: [{mid}]"
            for key in ("label", "unit", "better", "group"):
                if key not in m:
                    problems.append(f"{where} missing '{key}'")
            if m.get("better") not in BETTER:
                problems.append(f"{where} better must be one of {BETTER}")
            if mid in metrics:
                problems.append(f"{where} duplicates metric '{mid}'")
            metrics[mid] = Metric(id=mid, **{k: v for k, v in m.items() if k in Metric.__dataclass_fields__})
    return metrics, problems


def _load_scenario(path, problems):
    d = _read(path)
    sid = d.get("id", path.stem)
    if sid != path.stem:
        problems.append(f"{path}: id '{sid}' must match the file name")
    for key in ("title", "kind"):
        if not d.get(key):
            problems.append(f"{path}: missing '{key}'")
    params = {k: v for k, v in d.items() if k not in ("id", "title", "kind", "order", "description")}
    return Scenario(id=sid, title=d.get("title", sid), kind=d.get("kind", ""), order=int(d.get("order", 100)),
                    description=d.get("description", ""), params=params, path=path)


def _load_implementation(path, problems):
    manifest = path / "impl.toml"
    d = _read(manifest)
    iid = d.get("id", path.name)
    if iid != path.name:
        problems.append(f"{manifest}: id '{iid}' must match the directory name")
    if not ID_RE.match(iid):
        problems.append(f"{manifest}: id must be lowercase letters, digits and dashes")
    for key in ("name", "language", "category"):
        if not d.get(key):
            problems.append(f"{manifest}: missing '{key}'")
    if d.get("category") and d["category"] not in CATEGORIES:
        problems.append(f"{manifest}: category must be one of {CATEGORIES}")
    dockerfile = path / d.get("build", {}).get("dockerfile", "Dockerfile")
    if not dockerfile.is_file():
        problems.append(f"{manifest}: Dockerfile not found at {dockerfile.name}")
    return Implementation(id=iid, name=d.get("name", iid), language=d.get("language", ""),
                          category=d.get("category", ""), data=d, path=path)


def load_domain(path):
    path = Path(path)
    problems = []
    d = _read(path / "domain.toml")
    did = d.get("id", path.name)
    if did != path.name.lstrip("_"):
        problems.append(f"{path}/domain.toml: id '{did}' must match the directory name")
    for key in ("title", "harness"):
        if not d.get(key):
            problems.append(f"{path}/domain.toml: missing '{key}'")
    if d.get("status", "stable") not in STATUSES:
        problems.append(f"{path}/domain.toml: status must be one of {STATUSES}")
    domain = Domain(id=did, title=d.get("title", did), summary=d.get("summary", ""),
                    status=d.get("status", "stable"), harness=d.get("harness", ""), data=d, path=path)
    domain.metrics, mp = load_metrics(CORE_METRICS, path / "metrics.toml")
    problems += mp
    for f in sorted((path / "scenarios").glob("*.toml")):
        domain.scenarios.append(_load_scenario(f, problems))
    domain.scenarios.sort(key=lambda s: (s.order, s.id))
    impl_dir = path / "implementations"
    for p in sorted(impl_dir.iterdir()) if impl_dir.is_dir() else []:
        if (p / "impl.toml").is_file():
            domain.implementations.append(_load_implementation(p, problems))
    ids = [i.id for i in domain.implementations]
    problems += [f"{path}: duplicate implementation id '{i}'" for i in set(ids) if ids.count(i) > 1]
    for h in domain.headline:
        if h.get("metric") not in domain.metrics:
            problems.append(f"{path}/domain.toml: headline metric '{h.get('metric')}' is not in the metric registry")
    if not str(d.get("methodology_version", "1")).isdigit():  # runs are ranked by it, newest first
        problems.append(f"{path}/domain.toml: methodology_version must be a whole number")
    for dv in d.get("derived", []):
        used = [dv.get("metric"), dv.get("valid_when", {}).get("metric", dv.get("metric"))]
        problems += [f"{path}/domain.toml: derived metric '{dv.get('id')}' uses '{m}', which is not in the "
                     f"metric registry" for m in used if m not in domain.metrics]
    if problems:
        raise ManifestError(problems)
    return domain


def discover(root):
    """All domain directories below <root>/domains (including example domains starting with '_')."""
    base = Path(root) / "domains"
    return [p for p in sorted(base.iterdir()) if (p / "domain.toml").is_file()]


def load_all(root):
    domains, problems = {}, []
    for p in discover(root):
        try:
            d = load_domain(p)
            domains[d.id] = d
        except ManifestError as e:
            problems += e.problems
    if problems:
        raise ManifestError(problems)
    return domains


def load_harness(domain):
    """Import `<module>:<Class>` from the domain directory and return the class."""
    module_name, _, class_name = domain.harness.partition(":")
    file = domain.path / f"{module_name}.py"
    where = f"{domain.path}/domain.toml: harness = \"{domain.harness}\""
    if not class_name or not file.is_file():
        raise ManifestError([f"{where} must be '<module>:<Class>' naming a Python file in the domain directory"])
    spec = importlib.util.spec_from_file_location(f"domains.{domain.id}.{module_name}", file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    if not hasattr(module, class_name):
        raise ManifestError([f"{where}: {file.name} defines no class '{class_name}'"])
    return getattr(module, class_name)
