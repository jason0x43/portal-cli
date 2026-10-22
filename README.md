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
- logs with Docker's `local` driver, which rotates and compresses them (5 files of 20MB). Read them with `portal logs`, or with `docker compose logs` in `services/<name>`.
- gets the client's IP in the `X-Real-IP` header, taken from Cloudflare's `CF-Connecting-IP`. `X-Forwarded-For` only ever holds the tunnel's address.

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
portal update
portal update --rollback
portal status
portal logs -f
portal restart
portal rollback
portal remove
portal doctor
```

- `ls` lists every service on the server, with its state, route and deployed image tag.
  - `--outdated` adds a column for each service's image: the version a pinned `image` is on, or the base image a built image names, with a newer version if the registry has one, or `(rebuilt upstream)` if its tag now points to a different image than the one it was built from. Images with no base image label show as `unlabeled` (see [Base images](#base-images)). Like `update`, this only works for public images.
- `update` pulls newer images for the shared infrastructure (the root compose project, such as cloudflared and caddy) and recreates only the containers whose image changed.
  - **Checks:** before pulling, it records the response status of every route, requested through Cloudflare. After recreating, it waits for the containers to be healthy and for every route to return its earlier status again.
  - **Automatic rollback:** if a container doesn't come up, or a route's status changes, portal restores the previous images and exits with an error. Pin a version in the root `compose.yaml` to keep a bad release from being pulled again.
  - **Later rollback:** the images an update replaced are kept as `<image>:<tag>-previous`, and `portal update --rollback` switches back to them for problems noticed after the update finished.
  - **Services aren't touched.** CI redeploys registry-built apps, and locally built services pick up base image fixes when you `portal deploy` them, so `update` lists any service that was last deployed more than 30 days ago, unless it can check the image's base digest (see [Base images](#base-images)). For services pinned to a versioned `image` (such as `ghcr.io/atuinsh/atuin:18.23.0`), it asks the registry for newer tags of the same form instead and lists any it finds, since redeploying a pinned image gets the same image again. It never changes the pin. This check needs the service to have been deployed by a portal version that records its image, and it only works for public images. Built images are checked the same way against the base image they name, and against the digest that base had when they were built (see [Base images](#base-images)).
- `status` shows the container, deployed image tags and route.
- `logs -f` follows the logs.
- `restart` restarts the container.
- `rollback` switches to the previous image. `portal rollback <tag>` switches to a specific one.
- `remove` stops the service and removes its config but keeps its data. Add `--purge` to delete the data too.
- `labels` prints the labels portal adds to images it builds, one `key=value` per line, for a build done elsewhere (see [CI](#ci)). Right now that's the base image's digest. A label it can't work out is left out with a warning, so the build still runs.
- `doctor` checks that a project is ready to deploy and reports problems without changing anything. It exits with an error if anything would stop a deploy.
  - **Project:** `portal.toml` is valid; the Dockerfile labels its base image, a versioned base is the newest version (an unversioned one is fine for built services, which record its digest), and `EXPOSE` matches `port`. Image services with a Dockerfile in the project, such as ones CI builds, are checked too.
  - **Static sites:** the directory exists, and so does the `fallback` page.
  - **Local tools:** Docker and buildx are available to build with.
  - **Pinned images:** the tag exists in its registry, and whether a newer one does.
  - **CI workflows:** steps in the repository's GitHub workflows that use the portal action are on its newest release tag, pass the required inputs and an existing `config`, and grant `packages: read` when they rely on the job's token.
  - **Server:** ssh and Docker work, caddy and cloudflared are running, and the `server` network exists.
  - **Service:** no other site already routes its domains, the container is healthy, the deployed image has base image name and digest labels, and its base image hasn't been rebuilt since.
  - `--fix` adds or corrects the Dockerfile's base image label (see [Base images](#base-images)), and moves workflow steps on an older release of the portal action to the newest one. Steps on a branch or commit are left alone.

These commands also work without a `portal.toml`, for example `portal status -s worthy`.

### How deploys behave

- **Image tags:** images are tagged `portal/<name>:<UTC timestamp>-<git sha>`, and the compose file runs `portal/<name>:latest`. The 3 most recent deploys are kept for rollback.
- **Image transfer:** locally built images go to the server as a gzipped `docker save` streamed over ssh into `docker load`.
- **Failed containers:** if the new container exits, restarts or reports unhealthy within `--timeout` (default 60s), portal prints its logs and puts back the previous image and compose file.
- **Failed Caddy validation:** if the new route doesn't validate, it's reverted before Caddy reloads.
- **Static sites:** `static = "dist"` builds an image from a generated Dockerfile: [static-web-server](https://static-web-server.net/) with the directory's contents baked in. The site is then deployed, rolled back and removed like any other service. Its container runs read-only, with no data volume.
  - **Caching:** every file is served with `Cache-Control: no-cache`, so browsers revalidate and pick up a new deploy immediately. static-web-server's own defaults would cache HTML for a day and JS and CSS for a year.
  - **Hashed asset directories** can opt in to long-lived caching: `static = { dir = "dist", immutable = ["assets/**"] }`.
  - **SPAs:** `fallback = "index.html"` serves that page for any path that doesn't exist.
  - **404 page:** a `404.html` in the directory is used as the error page.
  - **Logs:** every request is logged with its method, path and client IP (`x_real_ip`), and errors such as 404s get a second line with the status.
  - **Excluded files:** `.git` (at any depth) and the project's `portal.toml` are always left out of the image. Add more with `ignore`, which follows `.gitignore` conventions:

    ```toml
    static = { dir = ".", ignore = ["*.md", ".DS_Store", "/drafts/"] }
    ```

    - A pattern without a `/` matches a file or directory name at any depth.
    - A pattern with a `/` matches from the site root.
    - Ignoring a directory leaves out everything in it.

### Base images

A built image should name the image it was built from in the standard `org.opencontainers.image.base.name` label, so `portal update` can report newer versions of it. Declare the base as an `ARG` so the `FROM` line and the label share one version:

```dockerfile
ARG BASE_IMAGE=node:26.10.0-slim
FROM ${BASE_IMAGE} AS base
# ...
FROM base AS deploy
ARG BASE_IMAGE
LABEL org.opencontainers.image.base.name=${BASE_IMAGE}
```

The `LABEL` goes in the final stage, and that stage needs its own `ARG BASE_IMAGE` line to see the value. `portal doctor --fix` makes this change: it moves an inline base image into the `ARG`, or reuses the `ARG`s the `FROM` line already has, and corrects a label that doesn't match. `portal deploy` warns when a built image, or one deployed with `--image`, has no label. Static site images get the label automatically. Services pinned to a versioned `image` are checked by that version instead.

`portal deploy` always builds with `--pull`, so a deploy uses the current image behind the base's tag rather than a copy cached on your machine. It also records that image's digest for the server's platform in the `org.opencontainers.image.base.digest` label. `portal update` and `portal ls --outdated` compare it with the digest the tag points to now, so a base on a tag that moves, such as `debian:trixie-slim` or `node:26-slim`, is reported as rebuilt upstream when there's something new to deploy. A base pinned to a digest (`image@sha256:…`) never changes, so it isn't checked. Images built elsewhere, such as in CI, only get this check if their build sets the label; `portal labels` prints it (see [CI](#ci)).

### CI

This repo is also a GitHub Action. A workflow builds and pushes its image as usual, then deploys it with the action:

```yaml
- uses: actions/checkout@v7 # the action reads portal.toml from the repo
# ... build and push ghcr.io/owner/app:sha-<commit> ...
- uses: jason0x43/portal-cli@v0.7.0
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

To record the base image's digest the way `portal deploy` does (see [Base images](#base-images)), get the labels from the `labels` action and pass them to the build along with any others:

```yaml
- id: portal
  uses: jason0x43/portal-cli/labels@v0.7.0
  with:
    config: portal.toml
- uses: docker/build-push-action@v7
  with:
    labels: |
      ${{ steps.meta.outputs.labels }}
      ${{ steps.portal.outputs.labels }}
```

`portal doctor --fix` moves both actions to the newest release.

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
