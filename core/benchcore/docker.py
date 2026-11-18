"""Thin wrapper around the docker CLI. Every container and image created here carries the project label."""

import json
import subprocess
import time


DEFAULT_TIMEOUT_S = 600
BUILD_TIMEOUT_S = 3600  # a cold GraalVM native-image build on a small machine takes a long time
# Implementation containers share the runner's network namespace, so they get no capabilities beyond
# binding a port (NET_RAW would let them sniff the loopback traffic), cannot gain privileges and cannot
# fork without limit. None of this costs measurable performance.
UNTRUSTED = ["--cap-drop", "ALL", "--cap-add", "NET_BIND_SERVICE", "--security-opt", "no-new-privileges",
             "--pids-limit", "4096"]


class DockerError(RuntimeError):
    pass


class Docker:
    def __init__(self, label, log=print):
        self.label = label
        self.log = log

    def _run(self, *args, check=True, capture=True, timeout=DEFAULT_TIMEOUT_S, input=None):
        try:
            p = subprocess.run(["docker", *args], capture_output=capture, text=True, timeout=timeout, input=input)
        except subprocess.TimeoutExpired:
            # A hung daemon call must not block a run that lasts hours.
            raise DockerError(f"docker {args[0]} did not finish within {timeout} s") from None
        if check and p.returncode != 0:
            # The cause of a failed build or start is at the end of the output.
            output = "\n".join(s.strip() for s in (p.stdout, p.stderr) if s and s.strip())
            raise DockerError(f"docker {args[0]} failed (exit {p.returncode}): ...{output[-1500:]}")
        return p

    def available(self):
        try:
            return self._run("version", "--format", "{{.Server.Version}}", timeout=20).stdout.strip()
        except (DockerError, FileNotFoundError, subprocess.TimeoutExpired):
            return None

    def info(self):
        out = self._run("info", "--format", "{{json .}}", timeout=30).stdout
        return json.loads(out)

    def build(self, tag, context, dockerfile=None, build_args=None, pull=False):
        args = ["build", "-q", "-t", tag, "--label", f"{self.label}=true"]
        if dockerfile:
            args += ["-f", str(dockerfile)]
        for k, v in (build_args or {}).items():
            args += ["--build-arg", f"{k}={v}"]
        if pull:
            args.append("--pull")
        start = time.monotonic()
        self._run(*args, str(context), timeout=BUILD_TIMEOUT_S)
        return time.monotonic() - start

    def image(self, tag):
        data = json.loads(self._run("image", "inspect", tag).stdout)[0]
        return {"id": data["Id"], "size_bytes": data.get("Size"), "created": data.get("Created"),
                "repo_digests": data.get("RepoDigests", []), "architecture": data.get("Architecture"),
                "os": data.get("Os")}

    def image_exists(self, tag):
        return self._run("image", "inspect", tag, check=False).returncode == 0

    def create(self, name, image, network=None, cpuset=None, cpus=None, memory=None, env=None,
               command=None, extra=None, untrusted=False):
        """`untrusted=True` is for containers that run contributed code (the implementations)."""
        self.remove(name)
        args = ["create", "--name", name, "--label", f"{self.label}=true"]
        if untrusted:
            args += UNTRUSTED
        if network:
            args += ["--network", network]
        if cpuset:
            args += ["--cpuset-cpus", cpuset]
        if cpus:
            args += ["--cpus", str(cpus)]
        if memory:
            args += ["--memory", str(memory), "--memory-swap", str(memory)]
        for k, v in (env or {}).items():
            args += ["-e", f"{k}={v}"]
        args += list(extra or [])
        args.append(image)
        args += list(command or [])
        return self._run(*args).stdout.strip()

    def start(self, name):
        self._run("start", name)

    def run(self, name, image, **kw):
        cid = self.create(name, image, **kw)
        self.start(name)
        return cid

    def stop(self, name, grace_s):
        """SIGTERM, then SIGKILL after `grace_s` seconds."""
        self._run("stop", "-t", str(grace_s), name, check=False, timeout=grace_s + 30)

    def remove(self, name):
        self._run("rm", "-f", name, check=False)

    def logs(self, name, tail=200):
        p = self._run("logs", "--tail", str(tail), name, check=False)
        return (p.stdout or "") + (p.stderr or "")

    def exec(self, name, *cmd, check=True, timeout=DEFAULT_TIMEOUT_S):
        return self._run("exec", name, *cmd, check=check, timeout=timeout)

    def inspect(self, name):
        return json.loads(self._run("inspect", name).stdout)[0]

    def container_id(self, name):
        return self.inspect(name)["Id"]

    def running(self, name):
        p = self._run("inspect", "-f", "{{.State.Running}}", name, check=False)
        return p.returncode == 0 and p.stdout.strip() == "true"

    def cleanup(self):
        """Remove every container that carries the project label (left over from an aborted run)."""
        ids = self._run("ps", "-aq", "--filter", f"label={self.label}=true", check=False).stdout.split()
        if ids:
            self._run("rm", "-f", *ids, check=False)
        return len(ids)
