# Deploying a private VibeConductor studio

This is a recipe for a single Linux host with Docker, a domain name, persistent disk and an HTTPS reverse proxy. It does not depend on a particular hosting provider. No live service is deployed by the repository or CI. The repository being private does not itself protect a hosted app; the owner password protects editing and saving, while explicit snapshot links are public to people who hold them.

The Docker image was built and exercised locally on 2026-09-23: private login, secure cookies, missing-key behavior, Host validation, static assets, container health, restart session invalidation, public snapshots and persistent saves across container replacement passed. Public DNS, a real certificate and a live host have not been configured or verified.

## Configuration

Production requires `OWNER_PASSWORD` (16+ characters), `SESSION_SECRET` (32+ characters) and the exact public HTTPS `APP_ORIGIN`. For example, use `https://instrument.example.com`, without a path. The server refuses to start with invalid configuration. `npm start` activates these requirements even on a local machine.

Create a local `.env.production` once. The following commands generate random secrets directly into the ignored file, do not print them, and refuse to overwrite an existing file. Open the file in a trusted local editor, replace the example domain, and put the generated owner password in your password manager. Leave `OPENAI_API_KEY` empty to keep live AI disabled.

POSIX shell:

```sh
umask 077
node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {writeFileSync} from "node:fs"; const lines = ["NODE_ENV=production", "HOST=0.0.0.0", "PORT=4310", "APP_ORIGIN=https://instrument.example.com", "DATABASE_PATH=/app/data/vibeconductor.sqlite", "OWNER_PASSWORD=" + randomBytes(24).toString("base64url"), "SESSION_SECRET=" + randomBytes(32).toString("hex"), "OPENAI_API_KEY=", "OPENAI_MODEL=gpt-4.1-mini"]; writeFileSync(".env.production", lines.join("\n") + "\n", {flag:"wx", mode:0o600});'
```

PowerShell 7 (for preparing the file on Windows):

```powershell
$vibeConfigScript = @'
import {randomBytes} from "node:crypto";
import {writeFileSync} from "node:fs";
const lines = ["NODE_ENV=production", "HOST=0.0.0.0", "PORT=4310", "APP_ORIGIN=https://instrument.example.com", "DATABASE_PATH=/app/data/vibeconductor.sqlite", "OWNER_PASSWORD=" + randomBytes(24).toString("base64url"), "SESSION_SECRET=" + randomBytes(32).toString("hex"), "OPENAI_API_KEY=", "OPENAI_MODEL=gpt-4.1-mini"];
writeFileSync(".env.production", lines.join("\n") + "\n", {flag:"wx"});
'@
node --input-type=module -e $vibeConfigScript
icacls .env.production /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):(F)"
Remove-Variable vibeConfigScript
```

Keep this file off GitHub and out of Docker build context. Both `.gitignore` and `.dockerignore` exclude it. Copy it securely to the server, restrict it to the deployment owner, and retain a private backup. Docker administrators can inspect container environment values; only trusted administrators should have access to the Docker daemon.

## Build and start the container

From the repository on the host:

```sh
docker build -t vibeconductor:local .
docker volume create vibeconductor-data
docker run -d --name vibeconductor --restart unless-stopped --init \
  --env-file .env.production \
  --publish 127.0.0.1:4310:4310 \
  --mount type=volume,source=vibeconductor-data,target=/app/data \
  vibeconductor:local
```

PowerShell uses the same Docker arguments on one line:

```powershell
docker build -t vibeconductor:local .
docker volume create vibeconductor-data
docker run -d --name vibeconductor --restart unless-stopped --init --env-file .env.production --publish 127.0.0.1:4310:4310 --mount type=volume,source=vibeconductor-data,target=/app/data vibeconductor:local
```

The image uses Node 24, builds the browser in a separate stage, installs only production dependencies in the runtime, and runs as the unprivileged `node` user. A new named volume inherits the writable data directory. Existing bind-mounted directories must be writable by container UID 1000. The built-in health check sends the configured Host header to `/api/session` and requires HTTP 200.

Keep the published port bound to `127.0.0.1`, as shown. The app listens on `0.0.0.0` inside the container so Docker can reach it, but requires owner login. A direct request to the local port with an unconfigured Host is deliberately rejected; access the public domain through the proxy.

## HTTPS reverse proxy

Point the domain's DNS to this host and allow inbound TCP ports 80/443. Install Caddy as a host service using its [official instructions](https://caddyserver.com/docs/install), then use this Caddyfile with your actual domain:

```caddyfile
instrument.example.com {
    reverse_proxy 127.0.0.1:4310
}
```

Validate and reload the Caddy configuration through the host's normal service mechanism. Caddy's [reverse-proxy guide](https://caddyserver.com/docs/quick-starts/reverse-proxy) describes its HTTPS behavior. Preserve the original Host header: it must match `APP_ORIGIN`. With another proxy, apply the same rule and terminate TLS before forwarding to the loopback port.

Visit `https://instrument.example.com`, sign in, save a composition and reload it. Create a snapshot and open it in a signed-out browser: it should play after a click while the private library remains inaccessible. Check container health with `docker ps`; inspect logs with `docker logs vibeconductor`. Logs report startup mode and generic error categories, without printing passwords, keys, prompts or model outputs. Dotenv loads quietly.

Do not proxy the password-free development server to the public internet. A proxy's TCP connection is local, so local-development bypass would treat it as the owner. Use this production configuration for all hosted access.

## Storage, upgrades and recovery

The persistent volume contains compositions and immutable snapshots. Browser recovery is device-local and is not a substitute for server backups. Use one app process: sessions, throttles and request-id cache are in memory; restarting signs the owner out and clears that cache. Multiple replicas would need shared session and idempotency storage.

Before an upgrade, stop the container and back up the entire data directory, including SQLite WAL-related files if any. For example, on the Linux host:

```sh
mkdir -p backups
chmod 700 backups
umask 077
docker stop vibeconductor
docker run --rm --user 0 --entrypoint tar \
  --mount type=volume,source=vibeconductor-data,target=/data,readonly \
  vibeconductor:local -czf - -C /data . \
  > "backups/vibeconductor-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
docker start vibeconductor
```

Move the archive to protected off-host storage and retain dated copies. Test restoration on a separate empty volume before relying on the backup. Avoid copying only the main SQLite file while the app is running.

For an upgrade, build a new tagged image, stop and remove only the old container, then run the new image with the same named volume and configuration. Keep the previous image tag and backup until the upgrade is verified. This version has an initial schema only; future incompatible schema changes must document migration and rollback before deployment. Never delete the data volume during an ordinary redeploy.

Secrets can be rotated by updating the private environment file and recreating the container. Changing the session secret invalidates sessions. A provider key is optional; enabling it makes deliberate Conduct actions and opt-in live evaluation billable. See [the evaluation guide](evaluation.md) before enabling or changing a model.
