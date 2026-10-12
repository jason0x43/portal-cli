# portal

Deploys Docker services to the `portal` server, which is set up like this:

- traffic arrives through a Cloudflare tunnel
- Caddy routes it, using `caddy/sites/*.caddy`
- services run with docker compose in `~/server`

A project only needs a Dockerfile and a `portal.toml`. `portal deploy` takes care of the rest:

1. builds the image for linux/amd64
2. copies it to the server
3. writes `services/<name>/compose.yaml`, a compose project of its own
4. starts the container and waits for it to come up
5. writes the Caddy route and reloads Caddy

portal expects the server config directory (`~/server` by default) to contain:

- a root `compose.yaml` that runs a `caddy` service and creates a network named `server`. Services join it as an external network, and Caddy reaches them by name.
- a `caddy/Caddyfile` that imports `caddy/sites/*.caddy`

portal never edits the root `compose.yaml`. Everything it writes is generated, so a server config repo can gitignore `services/` and `caddy/sites/`.

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
portal ls
portal status
portal logs -f
portal restart
portal rollback
portal remove
```

- `ls` lists every service on the server, with its state, route and deployed image tag.
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

This repo is also a GitHub Action. A workflow builds and pushes its image as usual, then deploys it with the action:

```yaml
- uses: actions/checkout@v7 # the action reads portal.toml from the repo
# ... build and push ghcr.io/owner/app:sha-<commit> ...
- uses: jason0x43/portal-cli@v0.2.0
  with:
    config: portal.toml
    image: ghcr.io/${{ github.repository }}:sha-${{ github.sha }}
    host: ${{ vars.DEPLOY_HOST }}
    user: ${{ vars.DEPLOY_USER }}
    ssh-key: ${{ secrets.DEPLOY_KEY }}
    known-hosts: ${{ secrets.DEPLOY_HOST_KEY }}
```

The action:

1. installs Bun and runs portal from source at the referenced tag
2. sets up ssh with the given key and `known_hosts`
3. runs `portal deploy --image`

The server logs in to the registry with the job's `GITHUB_TOKEN` and logs out once the pull is done. The token needs `packages: read`.

## Design notes

These are the decisions behind the server layout. portal enforces most of them.

- **Routes are kept separate from services.** Caddy mounts only `caddy/`, so routes live in `caddy/sites/<name>.caddy`, not in each service's directory. Mounting `services/` would let Caddy read every service's `.env` and data, and Caddy is the container that handles traffic from the internet. portal keeps the two files together logically: `deploy` and `remove` handle both, and `status` shows both.
- **Caddy gets no Docker socket.** Routes are generated files, not container labels (the caddy-docker-proxy approach), because access to the socket is root-equivalent on the host.
- **Services can't publish ports.** A published port is reachable from outside the Cloudflare tunnel, and Docker's port publishing also bypasses host firewall rules. Services are reachable only through Caddy on the `server` network.
- **State is bind-mounted under the service directory.** Named volumes are rejected because they live outside the server config directory, where backups don't reach them. Everything a service stores is in `services/<name>/data`, where the backup script finds it, including its SQLite databases.
- **Each service is its own compose project.** Deploys never edit the shared root `compose.yaml`, so they can't break the infrastructure or other services. Everything portal writes is generated from each project's `portal.toml`, so the server config repo only tracks hand-written infrastructure.
- **Containers are hardened by default.** They run as `1000:1000` (the owner of `data/`), with all capabilities dropped and `no-new-privileges`. Overriding any of this means setting it explicitly in `[compose]`.
- **Static sites are containers.** Content is baked into a static-web-server image, so a static site deploys, rolls back and is removed like any other service. It's served with `no-cache` by default, because static-web-server's defaults (a day for HTML, a year for JS and CSS) would hide new deploys from returning visitors.

## Development

```bash
bun test
bun run typecheck
```
