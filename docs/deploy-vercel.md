# Deploying Nile Mart on Vercel

This guide deploys the storefront to **Vercel**, the Express API to **Railway**
(or any long-lived Node host), and PostgreSQL to **Neon**. It is the recommended
topology for this codebase because the API relies on a few things serverless
functions do not provide: a persistent uploads disk, a long-lived process for
the stock-reservation sweep, and request bodies up to 5 MB.

```text
Browser
  │  https://shop.example.com
  ▼
Vercel (frontend/dist, SPA rewrites)
  │  /api/*, /uploads/*, /robots.txt, /sitemap.xml  →  proxy
  ▼
Railway (backend/dist, Express, uploads volume, cron sweep)
  │
  ▼
Neon PostgreSQL (RLS enforced)
```

The proxy keeps the API same-origin from the browser's point of view, so the
session cookie stays first-party and no CORS layer is needed. Only the API host
holds database and payment secrets; the Vercel project holds none.

`vercel.json` ships with `API-HOST.example.com` as a placeholder — replace it
with the real API domain in step 3.

---

## 1. Database (Neon)

1. Create a Neon project and copy the **direct** connection string (not the
   pooled one). It looks like
   `postgresql://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require`.
2. Install, build the backend, and apply migrations from the repository root:

   ```bash
   npm ci
   npm run build -w backend
   DATABASE_URL='postgresql://.../neondb?sslmode=require' \
     NODE_ENV=production node backend/dist/db/migrate.js
   ```

   Migration `002_rls.sql` creates the restricted `nilemart_app` role and all
   policies. Your Neon owner must be allowed to `CREATE ROLE` (the default Neon
   role has `CREATEROLE`) and to assume it.

3. Verify RLS before creating data:

   ```sql
   select pg_has_role(current_user, 'nilemart_app', 'member');

   begin;
   set local role nilemart_app;
   select set_config('app.user_id', '', true),
          set_config('app.perms', '', true),
          set_config('app.guest_token', '', true);
   select count(*) from orders;    -- must be 0
   select count(*) from profiles;  -- must be 0
   rollback;
   ```

   If `set local role` fails, grant membership once from the Neon SQL editor.
   The `SET TRUE` clause is required: a grant created with `SET FALSE` reports
   `pg_has_role(...) = true` yet still fails at runtime.

   ```sql
   grant nilemart_app to <your_neon_login> with set true;
   ```

4. Create the first administrator. Demo seeding is refused in production:

   ```bash
   DATABASE_URL='postgresql://.../neondb?sslmode=require' \
     NODE_ENV=production \
     ADMIN_EMAIL='ops@example.com' \
     ADMIN_PASSWORD='a-long-unique-password' \
     ADMIN_NAME='Operations lead' \
     node backend/dist/db/create-admin.js
   ```

   Do not run `db:seed` or `db:reset` against production.

---

## 2. API (Railway)

Create a Railway project from the same repository.

**Build**

```bash
npm ci --include=dev && npm run build -w backend
```

**Start**

```bash
node backend/dist/db/migrate.js && node backend/dist/index.js
```

Migrations are idempotent, so running them on boot is safe. Keep a single API
replica: concurrent boots can race on the migrations table, and the in-process
reservation sweep is designed for one instance.

**Health check:** `/health`

**Volume:** mount a volume at `/data` and set `UPLOADS_DIR=/data/uploads`.
Admin product images then survive redeploys. The development seed images in
`backend/uploads/seed` are not used in production.

**Variables**

```dotenv
NODE_ENV=production
DATABASE_URL=postgresql://.../neondb?sslmode=require
DATABASE_SSL=require

# Used for links, redirects and the Origin check
APP_URL=https://shop.example.com
# Public API origin used for payment callbacks and webhooks
API_URL=https://api.example.com
UPLOADS_DIR=/data/uploads

SESSION_COOKIE_NAME=nm_session
SESSION_TTL_DAYS=30

SMTP_HOST=smtp.provider.example
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
MAIL_FROM=Nile Mart <no-reply@example.com>
ORDER_NOTIFICATION_EMAIL=orders@example.com

PAYMENTS_COD_ENABLED=true
CHAPA_SECRET_KEY=
CHAPA_WEBHOOK_SECRET=
CHAPA_BASE_URL=https://api.chapa.co/v1

RESERVATION_MINUTES=120
REQUIRE_VERIFIED_EMAIL=true
SEED_DEMO_DATA=false
```

Do not set `PORT`; Railway injects it. Attach a custom domain such as
`api.example.com` and use its HTTPS URL below.

---

## 3. Storefront (Vercel)

1. Import the repository in Vercel. Keep the **Root Directory** at the
   repository root; `vercel.json` sets the install, build and output commands.
2. Set the production environment variable:

   ```dotenv
   APP_URL=https://shop.example.com
   ```

   The build bakes absolute Open Graph URLs into `index.html`. If `APP_URL` is
   absent, Vercel's `VERCEL_PROJECT_PRODUCTION_URL` is used as a fallback.
3. Replace both occurrences of `API-HOST.example.com` in
   [vercel.json](../vercel.json) with your Railway domain (for example
   `nile-mart-api.up.railway.app`). The rewrites proxy:

   | Path | Destination |
   | --- | --- |
   | `/api/*` | API `/api/*` |
   | `/uploads/*` | API `/uploads/*` |
   | `/robots.txt` | API `/robots.txt` |
   | `/sitemap.xml` | API `/sitemap.xml` |
   | everything else | SPA `index.html` |

4. Deploy, then attach `shop.example.com` in **Settings → Domains**.

`vercel.json` also sets immutable caching for hashed assets and a CSP that
matches the API's production policy. Keep `connect-src 'self'` — the proxy is
what makes that possible.

---

## 4. Payments

Cash on delivery and Chapa are the only implemented gateways. In the Chapa
dashboard set the webhook/callback URL to:

```text
https://api.example.com/api/webhooks/chapa
```

and configure `CHAPA_WEBHOOK_SECRET` on Railway. Do not enable Telebirr,
M-PESA, EPS, card or PayPal until an adapter has been implemented and tested
against the provider's sandbox. Returning to the success page never marks an
order paid; only a verified webhook does.

---

## 5. Go-live checks

```bash
curl -s https://api.example.com/health
curl -sI https://shop.example.com/api/products | head -1     # 200 through the proxy
curl -s https://shop.example.com/robots.txt | tail -3        # Sitemap points at the storefront
```

Then in a browser:

- Load the storefront and confirm the logo, favicons and OG tags (View Source)
  use the Vercel HTTPS origin.
- Sign in, add to cart, and place a COD order end to end.
- Open `/admin` with the first administrator and upload a product image; confirm
  it survives an API redeploy (volume) and loads through `/uploads/...`.
- Re-run the RLS queries from step 1 after the first order exists.

---

## Troubleshooting the first deploy

**A push creates two failed deployments named `client` and `server`.** Those are
two old Vercel projects created one per workspace before the repository was
restructured. This app needs a single project at the repository root; the
`server` project can never succeed as a static/Vite deployment because the
Express API belongs on Railway. Delete or ignore both projects, keep one project
with **Root Directory = repository root**, and deploy the API separately.

**A standalone workspace project fails on `vite.config.ts`.** The error looks
like `Cannot find name 'process'` or `Cannot find name 'node:url'`. It happens
when the project root is `frontend/`, so the workspace-hoisted `@types/node` is
not installed. Two fixes:

- preferred: point the project's Root Directory at the repository root so
  `vercel.json` and the workspace lockfile are used; or
- keep the standalone project and rely on the `@types/node` dev dependency that
  `frontend/package.json` now declares.

A standalone `frontend` project still has no API proxy or SPA fallback, because
the root `vercel.json` does not apply to it. That is why the repository-root
project is the supported setup.

**The build passes but the site calls `/api/...` and gets 404.** Replace
`API-HOST.example.com` in `vercel.json` with the deployed API domain and
redeploy.

To read a failed build log locally:

```bash
npx vercel login
npx vercel link --repo
npx vercel inspect dpl_XXXXXXXX --logs
```

## Limits and alternatives

- **Upload size:** Vercel proxies cap request bodies around 4.5 MB. Product
  images should stay below that (the API's own limit is 5 MB). Larger files must
  be uploaded directly to the API host.
- **Reservation sweep:** runs inside the long-lived API process every five
  minutes. It does not run on Vercel Functions.
- **All-in-one Vercel:** possible with Vercel Services, but this Express app
  would need Vercel Blob for uploads and a Cron endpoint for the sweep, and the
  build would need function packaging. That is a code change, not a config
  change; the split above avoids it.
- **Single-host alternative:** the Express server can serve both the SPA and the
  API from one machine; see [deployment.md](deployment.md).
