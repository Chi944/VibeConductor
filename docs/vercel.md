# Vercel deployment

The repository is configured as a Vercel project named `vibeconductor`. Vercel serves the Vite output from `vercel-static/` and routes `/api/*` to [`api/[...path].ts`](../api/[...path].ts), which creates the existing Express app as a single Node function. The project is pinned to the Singapore region (`sin1`) to keep the small interactive API close to the intended audience.

## First deployment

Install the Vercel CLI, sign in, and link the repository once:

```sh
npm install --global vercel
vercel link
```

Production functions require a strong owner password and session secret. Generate both values in a password manager or another trusted local secret generator, then add them to the Vercel **Production** environment:

```sh
vercel env add OWNER_PASSWORD production
vercel env add SESSION_SECRET production
```

Paste each generated value only into the matching prompt. Leave `OPENAI_API_KEY` unset to keep live AI unconfigured. Vercel supplies `VERCEL_URL` and related deployment URLs automatically, so `APP_ORIGIN` is not required for this adapter.

Run the same Vercel build command locally when you want to inspect the static payload, then let Vercel build and deploy it in its Linux build environment:

```sh
vercel pull --yes --environment=production
npm run build:vercel
vercel deploy --prod
```

The deployment output includes the production URL. The owner password protects authoring, saving and version endpoints; snapshot links remain readable by anyone who has the link.

## Storage and payload choices

This deployment intentionally uses **zero Vercel Blob storage**. The app synthesizes audio in the browser, ships no samples or recordings, and has no upload route. The Vercel output is the hashed Vite client plus the favicon; source screenshots, tests, reports, Docker files and documentation are excluded by [`.vercelignore`](../.vercelignore). Font CSS references only the bundled Latin WOFF2 files, so the build does not upload the unused WOFF variants.

The optional SQLite database defaults to `/tmp/vibeconductor.sqlite` on Vercel. Function instances may be recycled and their temporary files are not a backup; a redeploy or a cold instance can start with an empty database. Use the Docker recipe with a persistent volume for durable compositions, or add an external database before treating the hosted instance as a long-lived authoring service.

## Verify or redeploy

After a deployment, check the static page and the protected API without putting credentials in shell history:

```sh
vercel inspect --prod
curl -I https://<deployment>.vercel.app/
curl -i https://<deployment>.vercel.app/api/session
```

`GET /api/session` should return a signed-out JSON response rather than a static-file error. To rotate credentials, update the two Vercel Production environment variables and redeploy; changing `SESSION_SECRET` revokes existing sessions.
