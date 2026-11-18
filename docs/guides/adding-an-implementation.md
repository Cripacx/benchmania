# Adding an implementation

An implementation is a directory below `domains/<domain>/implementations/<id>/`. For the backend domain it
serves the API on port 8080 and connects to PostgreSQL at `127.0.0.1:5432` (user, password and database:
`bench`).

## 1. Start from an existing one

```sh
./machbench scaffold backend my-framework --from go-nethttp
```

This copies the directory and sets the id. The id is lowercase letters, digits and dashes, usually
`<language>-<framework>[-<variant>]`.

## 2. Describe it in `impl.toml`

```toml
id = "my-framework"
name = "Language · Framework"          # shown on the website
language = "Language"
runtime = "Runtime"
framework = "Framework"
variant = "JIT"                        # optional, for several builds of the same code
category = "framework"                 # see "Categories" below
description = "One sentence: server, database driver, notable choices."
maintainers = ["your-github-name"]     # shown on the website; mention them in pull requests that touch this directory
notes = ["2 worker processes, one per CPU.", "Pool of 16 connections."]

[versions]                             # exact versions, all shown on the website
language = "1.2.3"
framework = "4.5.6"

[build]
dockerfile = "Dockerfile"              # relative to this directory
# context = "../../sources/shared"     # optional: build context shared by several variants
# args = { KEY = "value" }             # optional: docker build args

[run]
env = {}                               # optional: extra environment variables
```

Categories, so that readers compare like with like:

| `category` | Meaning | Examples |
|---|---|---|
| `bare` | standard library or runtime built-ins only, no web framework | net/http, Bun.serve, plain PHP |
| `micro` | small routing library | Express, Fastify, axum, Plug, ASP.NET minimal APIs |
| `framework` | batteries-included web framework | FastAPI |
| `fullstack` | full application framework | Spring Boot |

## 3. Implement the API

| Endpoint | Behaviour |
|---|---|
| `GET /json` | `{"message":"Hello, World!"}` |
| `GET /db` | one random row (`id` 1–10000) of table `world` as `{"id":…, "randomNumber":…}` |
| `GET /queries` | 20 random rows, read with 20 separate queries sent one after another (no batching, no IN list), as a JSON array |
| `GET /updates` | 5 random rows; give each a new random `randomNumber` (1–10000), write each with its own `UPDATE`, return the updated rows |
| `GET /list` | 100 consecutive rows starting at a random id (1–9901), each as `{"id", "randomNumber", "isEven"}` |
| `POST /orders` | parse `{"customerId", "items":[{"sku","quantity","unitPrice"}]}`; reject an empty list, `quantity < 1`, negative prices or empty SKUs with 400/422; return `{"customerId","itemCount","totalQuantity","total"}` with `total` rounded to cents |

Rules for every implementation:

- All JSON responses use `Content-Type: application/json`.
- Use prepared statements. Most drivers do so by default; enable it where they do not (for example
  Npgsql's `Max Auto Prepare`).
- Use a connection pool of 16 database connections in total across all worker processes, and let requests
  wait for a free connection instead of failing.
- Do not enable pipelining, multiplexing or batching options of the driver. A driver's default behaviour is
  fine; describe it in `notes` if it differs from one statement per round trip.
- Whether a request keeps one pooled connection for all its statements or checks one out per statement is up
  to what is idiomatic for the stack; say which in `notes`.
- Use the worker count that fits 2 CPUs.
- `total` in `/orders` is rounded to cents and returned as a JSON number.

Read [CONTRIBUTING.md](../../CONTRIBUTING.md#rules-for-implementations) for the fairness rules.

## 4. Pin everything

Exact base image tags (`golang:1.27.4-trixie`, not `golang:1`), exact dependency versions and a lockfile.
Base images without a moving tag policy (for example distroless) are pinned by digest
(`image@sha256:…`).
For the built-in stacks, `python3 tools/update_lockfiles.py <id>` regenerates the lockfile inside the
toolchain image.

## 5. Test

```sh
./machbench validate                                         # manifest
./machbench check backend --impl my-framework                # build + functional checks
./machbench run backend --impl my-framework go-nethttp --quick --passes 1
```

Open a pull request. CI runs the same checks and a short end-to-end run of the changed implementation.
