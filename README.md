# Invoice Rescue — Landing Site

Professional invoice recovery for UK freelancers and small businesses. 12% success fee, no win no fee.

**Live at:** [invoicerescue.co.uk](https://invoicerescue.co.uk)

## Site Structure

```
invoice-rescue-landing/
├── index.html                  Home
├── how-it-works/index.html     How It Works
├── pricing/index.html          Pricing
├── who-we-help/index.html      Who We Help
├── about/index.html            About
├── contact/index.html          Contact / Case Review Form
├── style.css                   Shared stylesheet
├── script.js                   Shared JavaScript
├── sitemap.xml                 XML Sitemap
├── robots.txt                  Robots.txt
├── .gitignore                  Git ignore rules
└── README.md                   This file
```

## Deployment

Static site hosted on **Cloudflare Pages**. No build step — plain HTML/CSS/JS.

All pages reference shared assets with root-absolute paths (`/style.css`, `/script.js`), and all internal navigation uses root-absolute links (`/pricing/`, `/contact/`, etc.) for correct resolution from any folder depth.

## Contact Form

The contact page uses [Web3Forms](https://web3forms.com) for form submission (free, no backend required).

**To activate the form:**
1. Go to [web3forms.com](https://web3forms.com)
2. Get a free access key
3. Replace `YOUR_WEB3FORMS_ACCESS_KEY` in `contact/index.html` with your real key

## Design System

- **Colours:** `--ink:#1C2128` `--slate:#2D3748` `--cloud:#F7F8FA` `--white:#FFFFFF` `--gold:#D4A853` `--gold-light:#F0C97A` `--muted:#6B7280` `--border:#E2E8F0`
- **Display font:** Playfair Display (h1/h2)
- **Body font:** Inter
- **Signature element:** Ghost "£" watermark

## Contact

hello@invoicerescue.co.uk
