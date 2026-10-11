# portal

Deploys Docker services to the `portal` server. The server layout this tool assumes is described in [PLAN.md](PLAN.md):

- traffic arrives through a Cloudflare tunnel
- Caddy routes it, using `caddy/sites/*.caddy`
- services run with docker compose in `~/server`

A project only needs a Dockerfile and a `portal.toml`. `portal deploy` takes care of the rest:

1. builds the image for linux/amd64
2. copies it to the server
3. writes `services/<name>/compose.yaml` and adds it to the root `include:` list
4. starts the container and waits for it to come up
5. writes the Caddy route and reloads Caddy
6. commits the change to the server's git repo

## Install

```bash
bun install
bun run build
```

```bash
cp dist/portal ~/.local/bin/
```

Or run it straight from the source: `bun src/cli.ts <command>`.

Building on an arm64 Mac needs amd64 emulation in the Docker VM for Dockerfiles with `RUN` steps. Colima provides it with `colima start --vm-type vz --vz-rosetta`, or with qemu binfmt.

## Usage

```bash
portal init
portal deploy --dry-run
portal deploy
```

`init` writes `portal.toml`. `deploy --dry-run` prints the generated files without changing anything.

```toml
name   = "worthy"                 # service, directory, and container name
domain = "worthy.jason0x43.dev"   # or a list of domains
port   = 3000                     # port the container listens on

build = true                      # or { context = "server", dockerfile = "Dockerfile", target = "prod", args = { … } }
# image = "ghcr.io/you/app"       # deploy a prebuilt image instead
# static = "dist"                 # bake a directory into a static-web-server image

# host = "portal"                 # ssh host
# root = "~/server"               # server config directory
# hardened = true                 # read-only root filesystem, tmpfs /tmp

[env]                             # non-secret environment
NODE_ENV = "production"

[compose]                         # merged into the generated service
healthcheck = { test = ["CMD", "wget", "-qO-", "http://localhost:3000/health"] }

[caddy]
extra = "encode zstd gzip"        # extra directives in the site block
```

Every generated service:

- runs as `1000:1000`, with `no-new-privileges` and all capabilities dropped
- is attached only to the `server` network
- mounts `services/<name>/data` at `/data`. The server's backup script snapshots SQLite files there automatically.

`[compose]` can't publish ports, use named volumes, or mount paths outside the service directory. `portal.toml` validation rejects those settings.

### Secrets

Secrets are kept only on the server, in `services/<name>/.env` (mode 600), which compose loads with `env_file`:

```bash
portal env set API_KEY=abc123
```

```bash
pbpaste | portal env set API_KEY
```

```bash
portal env --show
```

```bash
portal env unset API_KEY
```

The second form reads the value from stdin, so it stays out of shell history. `env --show` lists values as well as keys. Changing a variable recreates the container; pass `--no-restart` to skip that.

### Other commands

```bash
portal status
portal logs -f
portal restart
portal rollback
portal remove
```

- `status` shows the container, deployed image tags and route.
- `logs -f` follows the logs.
- `restart` restarts the container.
- `rollback` switches to the previous image. `portal rollback <tag>` switches to a specific one.
- `remove` stops the service and removes its config but keeps its data. Add `--purge` to delete the data too.

These commands also work without a `portal.toml`, for example `portal status -s worthy`.

### How deploys behave

- **Image tags:** images are tagged `portal/<name>:<UTC timestamp>-<git sha>`, and the compose file runs `portal/<name>:latest`. The 3 most recent deploys are kept for rollback.
- **Image transfer:** images go to the server with `docker pussh` ([unregistry](https://github.com/psviderski/unregistry)) if that's installed, which only sends missing layers. Otherwise portal streams `docker save | docker load`. Set `PORTAL_TRANSFER=load` to force the second method.
- **Failed containers:** if the new container exits, restarts or reports unhealthy within `--timeout` (default 60s), portal prints its logs and puts back the previous image and compose file.
- **Failed Caddy validation:** if the new route doesn't validate, it's reverted before Caddy reloads.
- **Static sites:** `static = "dist"` builds an image from a generated Dockerfile: [static-web-server](https://static-web-server.net/) with the directory's contents baked in. The site is then deployed, rolled back and removed like any other service. Its container runs read-only, with no data volume.
  - **Caching:** every file is served with `Cache-Control: no-cache`, so browsers revalidate and pick up a new deploy immediately. static-web-server's own defaults would cache HTML for a day and JS and CSS for a year.
  - **Hashed asset directories** can opt in to long-lived caching: `static = { dir = "dist", immutable = ["assets/**"] }`.
  - **SPAs:** `fallback = "index.html"` serves that page for any path that doesn't exist.
  - **404 page:** a `404.html` in the directory is used as the error page.
  - **Excluded files:** `.git` (at any depth) and the project's `portal.toml` are always left out of the image. Add more with `ignore`, which follows `.gitignore` conventions:

    ```toml
    static = { dir = ".", ignore = ["*.md", ".DS_Store", "/drafts/"] }
    ```

    - A pattern without a `/` matches a file or directory name at any depth.
    - A pattern with a `/` matches from the site root.
    - Ignoring a directory leaves out everything in it.

### CI

The workflow builds and pushes the image to a registry as usual. A single step then deploys it:

```yaml
- run: ./portal deploy --image ghcr.io/${{ github.repository }}:sha-${{ github.sha }}
  env:
    PORTAL_REGISTRY_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Development

```bash
bun test
bun run typecheck
```
