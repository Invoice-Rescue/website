\# Invoice Rescue — Build Plan, Checklist & Focus Brief

\*Prepared 2026-07-23. Last updated 2026-07-31 (see Section 0 for what changed). Based on: live site audit (invoicerescue.co.uk), outreach-profile.md, UK-SoleTrader-Website-Legal-Requirements.md, and live PECR research. No assumptions — items marked "verify" haven't been directly confirmed.\*

\-----

\#\# 0\. Session update log

\*\*2026-07-31 (Claude Code ↔ Cowork sync)\*\* — Reconciling this session's view with the Claude Code project at \`D:\\Dev\\Workspaces\\Active\\invoice-rescue\`:  
\- \*\*Claude Code committed the credit-control backend.\*\* Commit \`51c7c4e\` ("feat: add credit-control backend, restructure site, add legal pages") landed on branch \`feat/credit-control-backend-and-legal-pages\` — the Worker+D1 restructure (leads/clients/invoices/chase\_log), CSV import, overdue detection, AI-drafted escalation, admin review queue, Friday cash report, plus the privacy/terms pages and this build-plan file, are now version-controlled. \*\*Not merged to \`main\`\*\* — \`main\` is still on the old static-site commit (\`edf226c\`); only the feature branch is up to date.  
\- \*\*Verified the CLAUDE.md deploy gap empirically, not just by reading the note.\*\* Pulled the live Worker via Cloudflare's API: \`invoice-rescue\` was last modified 2026-07-25 and its deployed bundle has no \`POST /api/clients\` route — confirmed by diffing against \`backend/src/index.ts\`, which has it at line 105. So the gap CLAUDE.md flagged ("production is currently running Worker code older than \`backend/src/index.ts\`") is still real today, and the 2026-07-29 Cloudflare-token widening hasn't yet been used to actually deploy — the live Worker predates that token change too. \*\*A2-dev's "Open" item below is not resolved; downgrading it back to explicitly open.\*\*  
\- \*\*Uncommitted working-tree changes found:\*\* \`Cloudflare-payload.json\` and \`Cloudflare-resource.terraform\` (the IAM policy/Terraform files for the Cloudflare API token) show a full reformat — 759 lines changed each, looks like key/whitespace reordering rather than a permission change, but not confirmed line-by-line. Sitting uncommitted in the working tree; needs a look next Claude Code session (\`git diff\` them, then commit or discard) before it's forgotten.  
\- No code or infra changes made from this session — read-only verification against git and the Cloudflare API.

\*\*2026-07-30\*\* — Checked actual DNS/Email Routing state via the Cloudflare API (now reachable directly from this session, not just D1/KV/R2 as previously noted — token has \`dns_records:edit\`/\`read\` on the zone):  
\- \*\*A2 (SPF/DKIM/DMARC) is partly stale.\*\* SPF already exists on invoicerescue.co.uk (\`v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all\`) and DMARC already exists (\`p=none\`, reports routed to Cloudflare's DMARC service). Cloudflare-side DKIM selectors (\`cf2024-1\`, \`cf-bounce\`) are also present. This checklist item is not "add from scratch" — it's narrower than previously assumed.  
\- \*\*Real gap found: no DKIM selector for Google.\*\* Confirmed send path: Cloudflare Email Routing forwards \`<tibor@invoicerescue.co.uk>\` → \`<tiborcc2@gmail.com>\`; outbound replies go out via Gmail's "Send mail as <tibor@invoicerescue.co.uk>". SPF includes \`_spf.google.com\` for this reason, but no matching Google DKIM record exists — and on a personal (non-Workspace) Gmail account, DKIM can't be made to align to a custom domain via DNS alone; that needs Google Workspace or a dedicated outbound sender.  
\- \*\*Practical risk for cold outreach at volume:\*\* personal Gmail "send mail as" is a known weak setup for bulk cold email — DKIM won't align, deliverability suffers regardless of DNS correctness, and Gmail's own sending caps apply.  
\- \*\*Next concrete step (unchanged from plan, now the real blocker):\*\* send a test email from Gmail \*as\* <tibor@invoicerescue.co.uk> to mail-tester.com and read the actual SPF/DKIM/DMARC pass/fail from real headers — empirical, settles the Gmail-alignment question definitively. This requires the user's own Gmail compose action; not something this session can do on their behalf.  
\- No DNS or Email Routing changes were made this session — investigation only.

\*\*2026-07-30 (cont.)\*\* — Ran the mail-tester.com test (user sent from Gmail as <tibor@invoicerescue.co.uk>): \*\*4.2/10\*\*. Confirms the diagnosis above with hard evidence:  
\- \*\*DKIM: not signed at all.\*\*  
\- \*\*SPF: passes, but only for \`<tiborcc2@gmail.com>\`\*\* — Bounce/Return-Path address is the raw Gmail account, not invoicerescue.co.uk.  
\- \*\*DMARC: fails\*\* — \`dmarc=fail (p=none dis=none) header.from=invoicerescue.co.uk\`.  
\- Minor/non-actionable: sending IP briefly on SpamCop's blocklist (shared Google IP, likely transient).  
\- \*\*Conclusion: personal Gmail "send mail as" cannot pass this test as configured — needs Google Workspace or a dedicated sending service before any real outreach volume goes out.\*\* Decision on which path pending user input.

\*\*2026-07-31\*\* — Deliverability fix in progress (Google Workspace path chosen) + parallel progress on legal/compliance and lead gen while DNS propagates:  
\- Google Workspace signed up for <tibor@invoicerescue.co.uk>; domain verified; \`google._domainkey\` DKIM TXT record added to Cloudflare and confirmed live (checked via public DNS); DKIM authentication confirmed \*\*ON\*\* in Google Admin. \`hello@\` and \`support@\` added as free Workspace aliases so nothing stops receiving.  
\- \*\*Still pending (user action required):\*\* MX cutover from Cloudflare Email Routing to Google (\`smtp.google.com\`, priority 1) — the Cloudflare API tool got blocked by this session's auto-mode permission classifier for this specific change (even a read-only MX lookup was blocked), so this needs to be done manually in the Cloudflare dashboard. Instructions given to user; awaiting confirmation.  
\- \*\*A4/A5 (legal footer) — confirmed genuine gap, not a fetch limitation.\*\* Live production site had zero Privacy Policy, zero Terms, zero legal name/address — worse than the previous (now-replaced) version, which at least had "Operated by Tibor Rames / United Kingdom" in the footer. Drafted \`frontend/privacy/index.html\` and \`frontend/terms/index.html\` from the actual D1 schema (leads/clients/invoices/chase_log), restored the legal-name footer line. \*\*Not deployed\*\* — needs the user's real registered address (privacy page has a clearly marked placeholder) and ideally a solicitor pass on the Terms liability clause before publishing.  
\- \*\*C1/C2 (prospect list + PECR segmentation) — first batch built, free method.\*\* User declined the paid Vibe Prospecting tool (£29.90+ for credits) in favor of free web research. Used Companies House Advanced Search (free, official) filtered to \`status=active, type=ltd\` across electrical/plumbing/building SIC codes — this inherently solves the PECR sole-trader restriction from §3 above, since Companies House only returns registered Ltd/PLC entities, never sole traders. Combined with Clutch.co agency/consultancy directory listings. Result: ~90 real companies (Ltd-confirmed trades + agencies/consultancies needing entity-type verification) in \`prospect-list-batch1.csv\`, sent to user.  
\- \*\*Contact enrichment — 90 of 90 done across five batches. This axis is complete.\*\* ~25 confirmed real emails total. Two dissolved companies caught and flagged for removal ("Make Us Care", "AGMA Studio" UK entity), several "proposal to strike off" flags (low-value targets), one flagged as likely dormant (registered at an insolvency practitioner's office), and roughly 8 name-collision risks caught and explicitly not used (wrong company, wrong country, or ambiguous match) rather than guessed. Remaining companies without a found email have phone numbers and/or contact-form URLs where available — real coverage limit of free search-based enrichment, not a stopping point for outreach itself (contact forms and phone still work). 6 confirmed real emails so far (M3.agency, Favoured, 777 Plumbing, Gambit Agency, Bird Marketing), several phone/website-only, and \*\*three caught mismatches\*\* worth remembering: "Headscape" vs. unrelated "Headspace Group", a Brighton contact returned for "Gas Smart Heating Ltd" (registered in Leigh-on-Sea, Essex), and "Diverge" matching at least 3 unrelated companies. Free/manual enrichment holds at roughly a 35% clean-email hit rate with real wrong-company risk needing a human eye each time — the practical ceiling for unsupervised automation. Continuing is a volume/pace call for the user.  
\- \*\*ICO registration — prep done, actual registration is not something this session can do.\*\* Wrote \`ico-registration-prep.md\` with every field pre-filled from the codebase (Tier 1, £52/yr; nature of processing; legal bases) except the registered address (same gap as the privacy policy) and payment/account creation, both of which are outside what this session does regardless of instruction, per its own operating rules — not a capability gap, a hard line.

\*\*2026-07-29\*\* — Dev environment progress on the Claude Code project at \`D:\\Dev\\Workspaces\\Active\\invoice-rescue\`:  
\- Cloudflare API token permissions widened to include read/write access to D1 and Worker secrets (previously narrower scope). This lets Claude Code manage the \`invoice-rescue-db\` D1 database and deploy/update Worker secrets directly from the local dev environment, without manual dashboard steps for those two resource types.  
\- \`.dev.vars\` now carries an OpenRouter API key in place of a Gemini API key, so AI model calls from this project route through OpenRouter (consistent with the custom OpenRouter MCP server already built for mid-session model delegation).  
\- Key values were not read or logged here (they live only in the user's local \`.dev.vars\`, which is gitignored) — this entry records \*what\* was configured, not the secrets themselves.  
\- Net effect: infrastructure/credential setup for local dev is a step closer to done. This doesn't move the Lead Generation or Monetization pillars below — those are still gated on deliverability (Section 2\) and outreach sending, not on Cloudflare/D1 permissions.

\*(Add new dated entries above this line each session so the log reads newest-first... actually keep newest at top of this section going forward.)\*

\-----

\#\# 1\\. Where you actually are (three-pillar status)

| | | |  
| :-: | :-: | :-: |  
| \*\*Pillar\*\* | \*\*Status\*\* | \*\*Evidence\*\* |  
| \*\*Offer\*\* | ✅ Locked | Live site confirms tagline, 3-step process, and 3-tier pricing (Foundation £349 / Engine £649 / Operator £1,250) exactly match outreach-profile.md. ICP is specific: UK agencies, consultancies, trades. |  
| \*\*Lead Generation\*\* | 🟡 Partial | Outreach templates are written and good. Sending is now confirmed working (\<<tibor@invoicerescue.co.uk>\> can send/receive/reply) — SPF/DKIM/DMARC and inbox-placement testing are still unconfirmed. Zero evidence of any outreach sent yet. |  
| \*\*Monetization\*\* | 🟡 Partial | Pricing and sales narrative exist. No CRM connected (HubSpot, QuickBooks, PayPal all show as unauthenticated/not connected in this session), so there's no tracking layer for replies, calls, or deals once outreach starts. |

\*\*Bottom line:\*\* this isn't a "find the idea" problem — the offer is done and validated against a live product. This is a \*\*lead-generation execution\*\* problem. Everything below is ordered around unblocking that.

\-----

\#\# 2\\. The one thing to focus on right now

\*\*Finish deliverability, then send.\*\* Sending is confirmed working (\<<tibor@invoicerescue.co.uk>\> sends, receives, and replies) — that part of the blocker is cleared. What's left before sending at any real volume:

1\.  Pick ONE sending method — done, confirmed working.  
2\.  Add SPF, DKIM, and DMARC records for invoicerescue.co.uk. Without these, cold email from a new custom domain lands in spam regardless of sender name or send capability — this isn't optional at any send volume.  
3\.  Send yourself a test email and confirm it lands in inbox, not spam (use mail-tester.com or similar).

I can't do step 2 for you — it requires your Cloudflare DNS dashboard, which isn't accessible from this session (no DNS/zone management tool connected, only Workers/D1/KV/R2 tools are available). If you want, I can walk you through it step-by-step next time you're at the Cloudflare dashboard.

\-----

\#\# 3\\. New finding: a real compliance risk in the outreach plan

I checked current UK PECR (Privacy and Electronic Communications Regulations) rules on cold email, and there's a distinction your outreach-profile.md doesn't currently account for:

  \- \*\*Limited companies / LLPs (corporate subscribers):\*\* cold email to a named individual at a corporate address is generally defensible under "legitimate interest." Your \*\*Agencies & Consultancies\*\* segment is mostly fine here.  
  \- \*\*Sole traders (individual subscribers):\*\* PECR treats sole traders like consumers — they need consent or a valid soft opt-in (Reg 22(3)), not just legitimate interest. A large share of your \*\*Trades & Contractors\*\* segment (electricians, builders, plumbers operating solo) are legally sole traders, not limited companies.

\*\*What this means practically:\*\* before running the trades/contractors outreach template at volume, either (a) restrict that segment to trades businesses registered as limited companies, which you can usually tell from Companies House lookup or a ".ltd"/"Limited" in the business name, or (b) get legal sign-off that your outreach qualifies for soft opt-in, or (c) treat that segment as warmer-touch only (referrals, LinkedIn, not cold email) until you've resolved this. This is exactly the kind of thing worth 20 minutes with a solicitor or a proper PECR checklist before you send 100+ emails to sole traders.

Sources: \[UK PECR Soft Opt-In Explained (2026)\](<https://yerman.uk/guide/uk-pecr-soft-opt-in-checklist-email-marketing/>), \[Cold Email in UK 2026: PECR \+ UK GDPR Compliance Rules\](<https://puzzleinbox.com/blog/cold-email-uk-pecr-2026>), \[Is Cold Email Legal in the UK? PECR & GDPR for B2B\](<https://ea.partners/post/is-cold-email-legal-in-the-uk>)

\-----

\#\# 4\\. Full build checklist

\#\#\# A. Technical / infrastructure (do first — everything else depends on this)

  \- Confirm sending method for \<<tibor@invoicerescue.co.uk>\> — \*\*confirmed working\*\*: \<<tibor@invoicerescue.co.uk>\> can send, receive, and reply.  
  \- Set SPF, DKIM, DMARC records for invoicerescue.co.uk  
  \- Send test email, verify inbox placement (not spam)  
  \- Verify: does the site currently have a Privacy Policy, Terms, and cookie consent linked in the footer? The live fetch of invoicerescue.co.uk didn't show these — could be a fetch limitation or a genuine gap. Check manually.  
  \- Verify: is your full legal name \+ a contact address for service of legal documents displayed anywhere on site? (Business Names Act requirement for sole traders trading under a name other than their own)  
  \- Decide \+ confirm: what actually happens when a client signs up today? Is the "escalating sequence" delivery (reminder → firm → formal notice) automated, semi-automated, or fully manual right now? This plan can't assess your backend since it isn't in the connected folder — worth writing down so you know your real capacity ceiling before outreach converts.

\#\#\# A2. Dev environment / Claude Code (D:\\Dev\\Workspaces\\Active\\invoice-rescue)

  \- \*\*Done (2026-07-29):\*\* Cloudflare API token widened to read/write D1 \+ Worker secrets, wired into \`.dev.vars\` — Claude Code can now manage the D1 database and Worker secrets directly from this project.  
  \- \*\*Done (2026-07-29):\*\* OpenRouter API key added to \`.dev.vars\` (replacing a Gemini key) — AI calls from this project route through OpenRouter.  
  \- Open: confirm the widened Cloudflare token is scoped to only this account/zone (least-privilege check) — worth a quick look next time you're in the Cloudflare dashboard, since "wider permissions" is a live security surface, not just a convenience.  
  \- \*\*Open, confirmed still open (2026-07-31):\*\* checked the live Worker via Cloudflare's API — deployed \`invoice-rescue\` bundle is from 2026-07-25, missing \`POST /api/clients\`, and predates even the 07-29 token widening. The token hasn't been used for a deploy yet. Next real step is still running an actual \`wrangler deploy\` (or Worker-secret write) through Claude Code to confirm the widened token works end-to-end.  
  \- \*\*New (2026-07-31):\*\* the credit-control backend is now committed to git (\`51c7c4e\`, branch \`feat/credit-control-backend-and-legal-pages\`) but \*\*not merged to \`main\` and not deployed\*\* — two separate gaps, don't conflate "committed" with "live."

\#\#\# B. Legal / compliance

  \- Resolve the PECR sole-trader issue above before scaling Trades & Contractors outreach  
  \- ICO registration (if not already done) — £52/yr (micro) or £78/yr (small/medium) at ico.org.uk  
  \- Privacy policy live \+ linked (mandatory — you collect name/email/company/overdue-amount via the audit form)  
  \- Terms of service linked (recommended given you're selling a subscription service)  
  \- Formal data-protection complaints process documented (required from 19 June 2026 under the Data (Use and Access) Act 2025 — you're past that date now, so this should already exist)  
  \- Confirm your own outreach tool's DPA if using one (e.g. Postiz)

\#\#\# C. Lead generation (once A is unblocked)

  \- Build a prospect list — target \\\~100-150 UK agencies/consultancies \+ limited-company trades for the first batch (vibe-prospecting or web search/Companies House for firmographic \+ contact data)  
  \- Segment list by entity type (Ltd vs. sole trader) per the PECR finding above  
  \- Send first batch using the two existing templates (Agencies & Consultancies / Trades & Contractors) from outreach-profile.md  
  \- Track sends \+ replies somewhere — even a simple spreadsheet — since no CRM is connected yet  
  \- Set a daily/weekly send cadence and stick to it (the pd-1-person-business framework's realistic math: \\\~1,000-1,500 outbound messages → 50-100 replies → 10-20 calls → 1-3 closes over 90 days for a first-time seller)

\#\#\# D. Monetization / tracking

  \- Decide on a lightweight CRM approach until HubSpot (or similar) is connected — even a tracked spreadsheet of prospect → sent → replied → audit sent → closed  
  \- Define the actual sales process for a reply: who answers, how fast, what the audit deliverable looks like in practice  
  \- Connect QuickBooks/PayPal/HubSpot in claude.ai connector settings when ready — this unlocks the small-business plugin's cash-flow, CRM, and pipeline skills for when Invoice Rescue itself has paying clients and receivables to manage

\#\#\# E. Open positioning decisions (carried over from outreach-profile.md — still unresolved)

  \- Bookkeeper/Accountant white-label reseller segment — not built, needs a white-label delivery mechanism before pitching  
  \- "Operator" tier human phone-call/negotiation feature — not in current product, site currently disclaims debt-collection-agency status  
  \- Construction milestone/retention billing — confirm whether the product actually handles staged invoices before using that angle in trades messaging

\-----

\#\# 5\\. Missing skills — what's actually worth building

I reviewed your installed skills against this business's actual recurring workflows. Most gaps aren't "missing skills," they're missing \*connectors\* (HubSpot/QuickBooks aren't authorized yet, which is why /small-business:smb-router's money and CRM skills can't run for Invoice Rescue itself right now). One real skill gap stands out:

\*\*Worth building:\*\* \*\*invoice-rescue-outreach\*\* — a dedicated skill that bakes in the ICP, tone rules, compliance guardrails (including the PECR sole-trader distinction above), CTA rules, and the two starter templates from outreach-profile.md, so every future outreach-drafting session doesn't require re-reading and re-deriving the same context. Right now that context lives in a markdown file I have to re-read each time; a skill makes it load automatically whenever you ask for outreach copy, and keeps the compliance guardrail from getting dropped in a future session.

\*\*Not worth building yet:\*\*

  \- A "client delivery / escalation sequence" skill — premature until you confirm how much of the actual chasing workflow is automated today (see checklist item A6). Building a skill around a process I can't verify exists risks encoding fiction.  
  \- A DNS/deliverability-setup skill — this is a one-time task, not a recurring workflow; doesn't meet the bar for a skill.

If you want the outreach skill built, say the word and I'll run it through /skill-creator properly — draft it, test it against a couple of realistic prompts, and let you review outputs before it's finalized, rather than shipping it untested.

\-----

\#\# 6\\. Sequencing summary

1\.  \*\*This week:\*\* Sending method confirmed (A1 ✅) — finish deliverability (A2-A3: SPF/DKIM/DMARC \+ inbox test). Resolve the PECR sole-trader question (B1). Verify legal footer requirements (A4-A5). Confirm the widened Cloudflare token actually works end-to-end for a D1 write / Worker secret deploy (A2-dev, open item).  
2\.  \*\*Once unblocked:\*\* Build prospect list, segment by entity type, send first batch (C1-C4).  
3\.  \*\*Ongoing:\*\* Track replies, hold audit calls/exchanges, close first client. Revisit CRM connection once volume justifies it.  
4\.  \*\*Parked, revisit later:\*\* White-label segment, Operator phone-call feature, construction-specific billing (E).  
