# Invoice Rescue — Landing Page

Static landing page for [Invoice Rescue](https://invoicerescue.co.uk), a professional invoice recovery service for UK freelancers and small businesses.

## Local Development

No build step. No npm. No bundler.

Open `index.html` directly in a browser:

```
# macOS / Linux
open index.html

# Windows
start index.html
```

Or serve it with any static file server, e.g.:

```
npx serve .
# or
python -m http.server 8080
```

All styles are in `style.css`, all behaviour in `script.js`. Google Fonts are loaded from CDN — an internet connection is required for fonts to render correctly in development.

## Deployment — Cloudflare Pages

### First deploy

1. Push this repo to GitHub (see git commands below).
2. Go to [pages.cloudflare.com](https://pages.cloudflare.com) and click **Create a project**.
3. Connect your GitHub account and select the `invoice-rescue-landing` repository.
4. Configure the build settings:
   - **Framework preset**: None
   - **Build command**: *(leave blank)*
   - **Build output directory**: `.` (a single dot — the repo root)
   - **Environment variables**: none required
5. Click **Save and Deploy**. Cloudflare builds and publishes in ~30 seconds.

### Custom domain (invoicerescue.co.uk)

After the first deploy:

1. In the Cloudflare Pages project, go to **Custom domains** → **Set up a custom domain**.
2. Enter `invoicerescue.co.uk` and follow the DNS instructions.
3. If your domain is already on Cloudflare, the CNAME/ALIAS is added automatically.
4. Wait for DNS propagation (usually instant on Cloudflare, up to 48 hrs elsewhere).

### Subsequent deploys

Push to the `main` branch — Cloudflare Pages auto-deploys on every push. No CI config needed.

## File Structure

```
invoice-rescue-landing/
├── index.html      ← Single-page site, all sections inline
├── style.css       ← Design system, layout, components, responsive
├── script.js       ← FAQ accordion, sticky nav, mailto CTAs, scroll animations
├── wrangler.toml   ← Cloudflare Pages config (static site, no Workers)
├── .gitignore
└── README.md
```

## Git Commands

Initialise the repo and push to GitHub:

```bash
cd D:\Dev\Workspaces\Active\invoice-rescue-landing

git init
git add .
git commit -m "Initial commit — Invoice Rescue landing page"

# Create the repo on GitHub first (github.com/new), then:
git remote add origin https://github.com/YOUR_USERNAME/invoice-rescue-landing.git
git branch -M main
git push -u origin main
```

Replace `YOUR_USERNAME` with your GitHub username.
