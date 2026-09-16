/**
 * Invoice Rescue — Dashboard, Debtor Ledger & Approval Queue Engine
 * Handles REST API communication, client-side filtering/sorting, statutory interest
 * calculations, and graceful static preview fallback.
 */

(function () {
  "use strict";

  // Bank of England Base Rate default (statute base rate + 8% margin)
  let boeBaseRatePercent = 3.75;
  const STATUTORY_MARGIN_PERCENT = 8;

  // Session Storage keys for mock persistence across page navigations
  const STORAGE_KEY_INVOICES = "ir_dashboard_invoices";
  const STORAGE_KEY_DRAFTS = "ir_dashboard_drafts";
  const STORAGE_KEY_ACTIVITIES = "ir_dashboard_activities";
  const STORAGE_KEY_THEME = "invoice_rescue_theme";

  // Default Mock Datasets
  const DEFAULT_INVOICES = [
    {
      id: 1,
      invoice_number: "INV-2026-089",
      debtor_name: "Hartley & Co Ltd",
      debtor_email: "accounts@hartleyandco.co.uk",
      amount_pence: 485000,
      currency: "GBP",
      due_date: "2026-08-23",
      days_overdue: 24,
      stage: 4,
      stage_label: "Stage 4 (Final)",
      status: "overdue",
      last_contact: "2 days ago (Formal Notice)"
    },
    {
      id: 2,
      invoice_number: "INV-2026-104",
      debtor_name: "Meridian Build Partners",
      debtor_email: "finance@meridianbuild.co.uk",
      amount_pence: 1230000,
      currency: "GBP",
      due_date: "2026-08-29",
      days_overdue: 18,
      stage: 3,
      stage_label: "Stage 3 (Firm)",
      status: "overdue",
      last_contact: "4 days ago (Step 2 Follow-up)"
    },
    {
      id: 3,
      invoice_number: "INV-2026-072",
      debtor_name: "Foxglove Creative Studio",
      debtor_email: "billing@foxglovestudio.com",
      amount_pence: 215000,
      currency: "GBP",
      due_date: "2026-09-05",
      days_overdue: 11,
      stage: 2,
      stage_label: "Stage 2 (Follow-up)",
      status: "paid",
      last_contact: "Yesterday (Settled in full)"
    },
    {
      id: 4,
      invoice_number: "INV-2026-112",
      debtor_name: "Vantage Architecture",
      debtor_email: "invoices@vantagearch.co.uk",
      amount_pence: 640000,
      currency: "GBP",
      due_date: "2026-09-07",
      days_overdue: 9,
      stage: 2,
      stage_label: "Stage 2 (Follow-up)",
      status: "overdue",
      last_contact: "3 days ago (Polite Reminder)"
    },
    {
      id: 5,
      invoice_number: "INV-2026-121",
      debtor_name: "Kestrel Logistics UK",
      debtor_email: "ap@kestrellogistics.co.uk",
      amount_pence: 375000,
      currency: "GBP",
      due_date: "2026-09-11",
      days_overdue: 5,
      stage: 1,
      stage_label: "Stage 1 (Gentle)",
      status: "overdue",
      last_contact: "5 days ago (Initial dispatch)"
    },
    {
      id: 6,
      invoice_number: "INV-2026-095",
      debtor_name: "Blackwood Digital Media",
      debtor_email: "finance@blackwooddigital.co.uk",
      amount_pence: 890000,
      currency: "GBP",
      due_date: "2026-08-31",
      days_overdue: 16,
      stage: 3,
      stage_label: "Stage 3 (Firm)",
      status: "promised",
      last_contact: "2 days ago (Promise to pay Fri)"
    },
    {
      id: 7,
      invoice_number: "INV-2026-118",
      debtor_name: "Crestview Engineering Ltd",
      debtor_email: "accounts@crestview-eng.co.uk",
      amount_pence: 1520000,
      currency: "GBP",
      due_date: "2026-08-16",
      days_overdue: 31,
      stage: 4,
      stage_label: "Stage 4 (Final)",
      status: "overdue",
      last_contact: "1 day ago (Notice of Legal Claim)"
    },
    {
      id: 8,
      invoice_number: "INV-2026-130",
      debtor_name: "Solent Media Group",
      debtor_email: "pay@solentmediagroup.com",
      amount_pence: 185000,
      currency: "GBP",
      due_date: "2026-09-13",
      days_overdue: 3,
      stage: 1,
      stage_label: "Stage 1 (Gentle)",
      status: "overdue",
      last_contact: "3 days ago (Initial dispatch)"
    },
    {
      id: 9,
      invoice_number: "INV-2026-088",
      debtor_name: "Northstar Consulting",
      debtor_email: "ap@northstarconsulting.co.uk",
      amount_pence: 520000,
      currency: "GBP",
      due_date: "2026-09-02",
      days_overdue: 14,
      stage: 2,
      stage_label: "Stage 2 (Follow-up)",
      status: "disputed",
      last_contact: "4 days ago (Query on PO match)"
    },
    {
      id: 10,
      invoice_number: "INV-2026-102",
      debtor_name: "Amberley Retail Design",
      debtor_email: "accounts@amberleydesign.co.uk",
      amount_pence: 710000,
      currency: "GBP",
      due_date: "2026-09-04",
      days_overdue: 12,
      stage: 2,
      stage_label: "Stage 2 (Follow-up)",
      status: "paid",
      last_contact: "2 days ago (Settled via BACS)"
    },
    {
      id: 11,
      invoice_number: "INV-2026-135",
      debtor_name: "Halcyon Brand Works",
      debtor_email: "hello@halcyonbrandworks.co.uk",
      amount_pence: 95000,
      currency: "GBP",
      due_date: "2026-09-10",
      days_overdue: 6,
      stage: 1,
      stage_label: "Stage 1 (Gentle)",
      status: "overdue",
      last_contact: "6 days ago (Initial dispatch)"
    },
    {
      id: 12,
      invoice_number: "INV-2026-110",
      debtor_name: "Zenith Property Dev",
      debtor_email: "finance@zenithproperty.co.uk",
      amount_pence: 1150000,
      currency: "GBP",
      due_date: "2026-08-25",
      days_overdue: 22,
      stage: 4,
      stage_label: "Stage 4 (Final)",
      status: "overdue",
      last_contact: "3 days ago (Final statutory claim)"
    }
  ];

  const DEFAULT_DRAFTS = [
    {
      id: 101,
      invoice_id: 1,
      invoice_number: "INV-2026-089",
      debtor_name: "Hartley & Co Ltd",
      debtor_email: "accounts@hartleyandco.co.uk",
      company_name: "Apex Studio Ltd",
      amount_pence: 485000,
      currency: "GBP",
      days_overdue: 24,
      step: 4,
      step_label: "Stage 4 (Final Notice)",
      subject: "FINAL DEMAND — Overdue Invoice INV-2026-089 (Hartley & Co Ltd)",
      body: `Dear Accounts Team,

We write regarding outstanding invoice INV-2026-089 (£4,850.00), which matured on 23 August 2026 and is now 24 days overdue. Despite previous polite reminders, this sum remains unpaid on our ledger.

Under the Late Payment of Commercial Debts (Interest) Act 1998, statutory interest of £37.47 (calculated at 11.75% per annum) and fixed compensation of £70.00 have now accrued and are formally added to your balance.

The revised total payable is £4,957.47. Please arrange immediate settlement to our account within 48 hours to avoid formal escalation to legal proceedings and credit recovery.

Yours sincerely,
Tibor Rames
Invoice Rescue — on behalf of Apex Studio Ltd`,
      locked_sender: "hello@invoicerescue.co.uk"
    },
    {
      id: 102,
      invoice_id: 2,
      invoice_number: "INV-2026-104",
      debtor_name: "Meridian Build Partners",
      debtor_email: "finance@meridianbuild.co.uk",
      company_name: "Apex Studio Ltd",
      amount_pence: 1230000,
      currency: "GBP",
      days_overdue: 18,
      step: 3,
      step_label: "Stage 3 (Firm Notice)",
      subject: "OVERDUE PAYMENT — Invoice INV-2026-104 (£12,300.00)",
      body: `Dear Meridian Build Finance Team,

Invoice INV-2026-104 for £12,300.00 is now 18 days past its agreed due date of 29 August 2026.

As a reminder, statutory interest of £71.27 and statutory recovery compensation of £100.00 apply to commercial debts over £10,000 under the Late Payment of Commercial Debts Regulations. The current outstanding total is £12,471.27.

We request that you confirm payment scheduling by return or send remittance advice at your earliest convenience to maintain an uninterrupted working relationship.

Kind regards,
Tibor Rames
Invoice Rescue — on behalf of Apex Studio Ltd`,
      locked_sender: "hello@invoicerescue.co.uk"
    },
    {
      id: 103,
      invoice_id: 4,
      invoice_number: "INV-2026-112",
      debtor_name: "Vantage Architecture",
      debtor_email: "invoices@vantagearch.co.uk",
      company_name: "Apex Studio Ltd",
      amount_pence: 640000,
      currency: "GBP",
      days_overdue: 9,
      step: 2,
      step_label: "Stage 2 (Follow-up)",
      subject: "Follow-up: Overdue Invoice INV-2026-112",
      body: `Hello Vantage Accounts,

Just a quick follow-up regarding invoice INV-2026-112 (£6,400.00), which fell due on 07 September 2026.

We appreciate that invoice cycles can sometimes be delayed, so please let us know if you require another copy of the invoice or if this is currently queued in your next payment run.

Best regards,
Tibor Rames
Invoice Rescue — on behalf of Apex Studio Ltd`,
      locked_sender: "hello@invoicerescue.co.uk"
    }
  ];

  const DEFAULT_ACTIVITIES = [
    {
      id: "act-1",
      type: "sent",
      title: "Stage 2 Follow-up dispatched",
      detail: "INV-2026-104 to Meridian Build Partners",
      amount: "£12,300.00",
      time: "Today, 08:30"
    },
    {
      id: "act-2",
      type: "paid",
      title: "Invoice Settled in Full",
      detail: "INV-2026-072 paid by Foxglove Creative Studio",
      amount: "£2,150.00",
      time: "Yesterday, 14:15"
    },
    {
      id: "act-3",
      type: "draft",
      title: "3 AI escalation drafts generated",
      detail: "Awaiting human operator review in queue",
      amount: "£23,550.00",
      time: "Yesterday, 06:00"
    },
    {
      id: "act-4",
      type: "paid",
      title: "Payment cleared via BACS",
      detail: "INV-2026-102 paid by Amberley Retail Design",
      amount: "£7,100.00",
      time: "14 Sep, 11:20"
    },
    {
      id: "act-5",
      type: "dispute",
      detail: "INV-2026-088 query raised by Northstar Consulting",
      title: "Debtor query flagged for review",
      amount: "£5,200.00",
      time: "12 Sep, 16:45"
    }
  ];

  // Helper: Currency Formatter
  function formatMoney(pence, currency = "GBP") {
    const symbol = currency === "GBP" ? "£" : currency + " ";
    return `${symbol}${(pence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  // Helper: Statutory Interest & Compensation Math
  function computeFixedCompensationPence(amountPence) {
    if (amountPence < 100000) return 4000; // < £1,000 -> £40
    if (amountPence < 1000000) return 7000; // £1,000 to £9,999.99 -> £70
    return 10000; // >= £10,000 -> £100
  }

  function computeStatutoryInterestPence(amountPence, daysOverdue, baseRate = boeBaseRatePercent) {
    const annualRate = baseRate + STATUTORY_MARGIN_PERCENT;
    return Math.round(((amountPence * annualRate) / 100 / 365) * Math.max(0, daysOverdue));
  }

  // Load state from session or defaults
  function getStoredInvoices() {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY_INVOICES);
      if (stored) return JSON.parse(stored);
    } catch (e) {
      console.warn("Storage read error", e);
    }
    return DEFAULT_INVOICES;
  }

  function saveStoredInvoices(invoices) {
    try {
      sessionStorage.setItem(STORAGE_KEY_INVOICES, JSON.stringify(invoices));
    } catch (e) {
      console.warn("Storage save error", e);
    }
  }

  function getStoredDrafts() {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY_DRAFTS);
      if (stored) return JSON.parse(stored);
    } catch (e) {
      console.warn("Storage read error", e);
    }
    return DEFAULT_DRAFTS;
  }

  function saveStoredDrafts(drafts) {
    try {
      sessionStorage.setItem(STORAGE_KEY_DRAFTS, JSON.stringify(drafts));
    } catch (e) {
      console.warn("Storage save error", e);
    }
  }

  function getStoredActivities() {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY_ACTIVITIES);
      if (stored) return JSON.parse(stored);
    } catch (e) {
      console.warn("Storage read error", e);
    }
    return DEFAULT_ACTIVITIES;
  }

  function addActivity(item) {
    const activities = getStoredActivities();
    activities.unshift(item);
    try {
      sessionStorage.setItem(STORAGE_KEY_ACTIVITIES, JSON.stringify(activities));
    } catch (e) {
      console.warn("Storage save error", e);
    }
  }

  // Toast Notification System
  function showToast(message, type = "success") {
    let container = document.getElementById("toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "toast-container";
      container.className = "toast-container";
      container.setAttribute("aria-live", "polite");
      document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    const normalizedType = type === "error" ? "danger" : type;
    toast.className = `toast toast-${type} toast-${normalizedType}`;
    toast.setAttribute("role", "status");
    toast.innerHTML = `
      <span aria-hidden="true">${type === "success" ? "✓" : "!"}</span>
      <span>${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));

    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Theme Management
  function initTheme() {
    const themeToggleBtn = document.getElementById("theme-toggle-btn");
    const saved = localStorage.getItem(STORAGE_KEY_THEME);
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const currentTheme = saved || (prefersDark ? "dark" : "light");

    document.documentElement.setAttribute("data-theme", currentTheme);
    updateThemeButton(themeToggleBtn, currentTheme);

    if (themeToggleBtn) {
      themeToggleBtn.addEventListener("click", () => {
        const active = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", active);
        localStorage.setItem(STORAGE_KEY_THEME, active);
        updateThemeButton(themeToggleBtn, active);
      });
    }
  }

  function updateThemeButton(btn, theme) {
    if (!btn) return;
    const isDark = theme === "dark";
    btn.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
    btn.innerHTML = isDark
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  }

  // Update Pending Drafts Badge Across All Pages
  async function updateNavDraftBadge() {
    let drafts = getStoredDrafts();
    try {
      const res = await apiFetch("/api/admin/drafts");
      if (res.ok && res.data?.drafts) {
        drafts = res.data.drafts;
        saveStoredDrafts(drafts);
      }
    } catch {
      // Quiet fallback to session storage
    }

    const count = drafts.length;
    const badges = document.querySelectorAll(".nav-badge-drafts");
    badges.forEach((b) => {
      b.textContent = count;
      b.style.display = count > 0 ? "inline-block" : "none";
      b.setAttribute("aria-label", `${count} drafts awaiting review`);
    });

    const alertBanners = document.querySelectorAll(".alert-banner-pending");
    alertBanners.forEach((banner) => {
      banner.style.display = count > 0 ? "block" : "none";
      const counterSpan = banner.querySelector(".pending-draft-count");
      if (counterSpan) counterSpan.textContent = count;
    });
  }

  // Unified API Fetch wrapper with resilient fallback
  async function apiFetch(endpoint, options = {}) {
    try {
      const res = await fetch(endpoint, {
        headers: {
          Accept: "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });
      let data = null;
      try {
        const ct = res.headers ? res.headers.get("content-type") : null;
        if (ct && ct.includes("application/json")) {
          data = await res.json();
        } else if (res.status !== 204) {
          const text = await res.text();
          if (text && text.trim().startsWith("{")) {
            data = JSON.parse(text);
          }
        }
      } catch (_) {
        data = null;
      }
      if (!res.ok) {
        return { ok: false, status: res.status, data };
      }
      return { ok: true, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, error: err, data: null };
    }
  }

  // Try to load real base rate from API
  async function fetchStatutoryRate() {
    try {
      const res = await apiFetch("/api/statutory-rate");
      if (res.ok && res.data?.boeBaseRatePercent) {
        boeBaseRatePercent = Number(res.data.boeBaseRatePercent);
      }
    } catch (e) {
      // Quiet fallback to 3.75%
    }
  }

  // ==========================================================================
  // 1. Client Dashboard Logic (`index.html`)
  // ==========================================================================
  async function initOverviewDashboard() {
    const metricsGrid = document.querySelector(".metrics-grid");
    if (!metricsGrid) return;

    // 1. Attempt live API fetch
    const apiRes = await apiFetch("/api/portal/dashboard-data");
    if (apiRes.ok && apiRes.data) {
      const d = apiRes.data;
      const metrics = d.metrics || d.overdueTotals || {};
      const totalOverduePence = metrics.totalOverduePence ?? 0;
      const activeChasingPence = metrics.activeChasingPence ?? 0;
      const recoveredMonthPence = metrics.recoveredMonthPence ?? 0;
      const overdueCount = metrics.overdueCount ?? 0;

      // Populate Cards
      const elTotal = document.getElementById("metric-total-overdue");
      const elActive = document.getElementById("metric-active-chase");
      const elRecovered = document.getElementById("metric-recovered-month");
      const elCount = document.getElementById("metric-overdue-count");

      if (elTotal) elTotal.textContent = formatMoney(totalOverduePence);
      if (elActive) elActive.textContent = formatMoney(activeChasingPence);
      if (elRecovered) elRecovered.textContent = formatMoney(recoveredMonthPence);
      if (elCount) elCount.textContent = `${overdueCount} Invoices`;

      // Aging breakdown
      const aging = d.agingBreakdown || {};
      const b1 = aging.bucket1_to_7 || aging.bucket1 || { amountPence: 0, count: 0, percentage: 0 };
      const b2 = aging.bucket8_to_14 || aging.bucket2 || { amountPence: 0, count: 0, percentage: 0 };
      const b3 = aging.bucket15_to_21 || aging.bucket3 || { amountPence: 0, count: 0, percentage: 0 };
      const b4 = aging.bucket22_plus || aging.bucket4 || { amountPence: 0, count: 0, percentage: 0 };

      const p1 = b1.percentage ?? 0;
      const p2 = b2.percentage ?? 0;
      const p3 = b3.percentage ?? 0;
      const p4 = b4.percentage ?? 0;

      const seg1 = document.getElementById("gauge-seg-1");
      const seg2 = document.getElementById("gauge-seg-2");
      const seg3 = document.getElementById("gauge-seg-3");
      const seg4 = document.getElementById("gauge-seg-4");

      if (seg1) { seg1.style.width = `${p1}%`; seg1.title = `1-7d: ${p1}%`; }
      if (seg2) { seg2.style.width = `${p2}%`; seg2.title = `8-14d: ${p2}%`; }
      if (seg3) { seg3.style.width = `${p3}%`; seg3.title = `15-21d: ${p3}%`; }
      if (seg4) { seg4.style.width = `${p4}%`; seg4.title = `22d+: ${p4}%`; }

      // Dynamic aria-valuetext on .aging-gauge (WCAG 2.2 AA)
      const gauge = document.querySelector(".aging-gauge");
      if (gauge) {
        gauge.setAttribute("aria-valuetext", `Stage 1: ${p1}%, Stage 2: ${p2}%, Stage 3: ${p3}%, Stage 4: ${p4}%`);
      }

      // Text figures for aging buckets
      const elB1Amt = document.getElementById("b1-amount");
      const elB1Cnt = document.getElementById("b1-count");
      const elB2Amt = document.getElementById("b2-amount");
      const elB2Cnt = document.getElementById("b2-count");
      const elB3Amt = document.getElementById("b3-amount");
      const elB3Cnt = document.getElementById("b3-count");
      const elB4Amt = document.getElementById("b4-amount");
      const elB4Cnt = document.getElementById("b4-count");

      if (elB1Amt) elB1Amt.textContent = formatMoney(b1.amountPence);
      if (elB1Cnt) elB1Cnt.textContent = `${b1.count} overdue`;
      if (elB2Amt) elB2Amt.textContent = formatMoney(b2.amountPence);
      if (elB2Cnt) elB2Cnt.textContent = `${b2.count} overdue`;
      if (elB3Amt) elB3Amt.textContent = formatMoney(b3.amountPence);
      if (elB3Cnt) elB3Cnt.textContent = `${b3.count} overdue`;
      if (elB4Amt) elB4Amt.textContent = formatMoney(b4.amountPence);
      if (elB4Cnt) elB4Cnt.textContent = `${b4.count} overdue`;

      // Render Recent Activity Feed
      const activityFeed = document.getElementById("activity-feed-list");
      if (activityFeed) {
        if (Array.isArray(d.recentActivity) && d.recentActivity.length > 0) {
          activityFeed.innerHTML = d.recentActivity
            .map(
              (act) => `
              <div class="activity-item">
                <div class="activity-icon-wrap ${escapeHtml(act.type)}" aria-hidden="true">
                  ${
                    act.type === "paid"
                      ? "✓"
                      : act.type === "sent"
                      ? "✉"
                      : act.type === "draft"
                      ? "⚡"
                      : "!"
                  }
                </div>
                <div class="activity-body">
                  <div class="activity-line"><strong>${escapeHtml(act.title)}</strong></div>
                  <div class="activity-meta">
                    <span>${escapeHtml(act.detail)}</span>
                    <span>·</span>
                    <span>${escapeHtml(act.time || act.timestamp)}</span>
                  </div>
                </div>
                <div class="activity-amount">${escapeHtml(act.amount)}</div>
              </div>
            `
            )
            .join("");
        } else {
          activityFeed.innerHTML = `
            <div class="activity-item activity-empty" style="color:var(--ink-muted);font-style:italic;justify-content:center;padding:1.5rem 0;">
              No recent activity recorded yet.
            </div>
          `;
        }
      }
      return;
    }

    // 2. Fallback to session / mock data
    const invoices = getStoredInvoices();

    // 1. Calculate Metrics
    let totalOverduePence = 0;
    let activeChasingPence = 0;
    let recoveredMonthPence = 0;
    let overdueCount = 0;

    // Aging Buckets: 1-7d, 8-14d, 15-21d, 22d+
    let b1Pence = 0, b1Count = 0; // 1-7d
    let b2Pence = 0, b2Count = 0; // 8-14d
    let b3Pence = 0, b3Count = 0; // 15-21d
    let b4Pence = 0, b4Count = 0; // 22d+

    invoices.forEach((inv) => {
      if (inv.status === "paid") {
        recoveredMonthPence += inv.amount_pence;
      } else if (inv.status === "overdue" || inv.status === "disputed" || inv.status === "promised") {
        totalOverduePence += inv.amount_pence;
        overdueCount++;

        if (inv.status !== "disputed") {
          activeChasingPence += inv.amount_pence;
        }

        const days = inv.days_overdue;
        if (days <= 7) {
          b1Pence += inv.amount_pence;
          b1Count++;
        } else if (days <= 14) {
          b2Pence += inv.amount_pence;
          b2Count++;
        } else if (days <= 21) {
          b3Pence += inv.amount_pence;
          b3Count++;
        } else {
          b4Pence += inv.amount_pence;
          b4Count++;
        }
      }
    });

    // Populate Cards
    const elTotal = document.getElementById("metric-total-overdue");
    const elActive = document.getElementById("metric-active-chase");
    const elRecovered = document.getElementById("metric-recovered-month");
    const elCount = document.getElementById("metric-overdue-count");

    if (elTotal) elTotal.textContent = formatMoney(totalOverduePence);
    if (elActive) elActive.textContent = formatMoney(activeChasingPence);
    if (elRecovered) elRecovered.textContent = formatMoney(recoveredMonthPence);
    if (elCount) elCount.textContent = `${overdueCount} Invoices`;

    // Populate Aging Buckets
    const sumAging = b1Pence + b2Pence + b3Pence + b4Pence || 1;
    const p1 = Math.round((b1Pence / sumAging) * 100);
    const p2 = Math.round((b2Pence / sumAging) * 100);
    const p3 = Math.round((b3Pence / sumAging) * 100);
    const p4 = 100 - (p1 + p2 + p3);

    const seg1 = document.getElementById("gauge-seg-1");
    const seg2 = document.getElementById("gauge-seg-2");
    const seg3 = document.getElementById("gauge-seg-3");
    const seg4 = document.getElementById("gauge-seg-4");

    if (seg1) { seg1.style.width = `${p1}%`; seg1.title = `1-7d: ${p1}%`; }
    if (seg2) { seg2.style.width = `${p2}%`; seg2.title = `8-14d: ${p2}%`; }
    if (seg3) { seg3.style.width = `${p3}%`; seg3.title = `15-21d: ${p3}%`; }
    if (seg4) { seg4.style.width = `${p4}%`; seg4.title = `22d+: ${p4}%`; }

    // Dynamic aria-valuetext on .aging-gauge (WCAG 2.2 AA)
    const gauge = document.querySelector(".aging-gauge");
    if (gauge) {
      gauge.setAttribute("aria-valuetext", `Stage 1: ${p1}%, Stage 2: ${p2}%, Stage 3: ${p3}%, Stage 4: ${p4}%`);
    }

    // Text figures for aging buckets
    const elB1Amt = document.getElementById("b1-amount");
    const elB1Cnt = document.getElementById("b1-count");
    const elB2Amt = document.getElementById("b2-amount");
    const elB2Cnt = document.getElementById("b2-count");
    const elB3Amt = document.getElementById("b3-amount");
    const elB3Cnt = document.getElementById("b3-count");
    const elB4Amt = document.getElementById("b4-amount");
    const elB4Cnt = document.getElementById("b4-count");

    if (elB1Amt) elB1Amt.textContent = formatMoney(b1Pence);
    if (elB1Cnt) elB1Cnt.textContent = `${b1Count} overdue`;
    if (elB2Amt) elB2Amt.textContent = formatMoney(b2Pence);
    if (elB2Cnt) elB2Cnt.textContent = `${b2Count} overdue`;
    if (elB3Amt) elB3Amt.textContent = formatMoney(b3Pence);
    if (elB3Cnt) elB3Cnt.textContent = `${b3Count} overdue`;
    if (elB4Amt) elB4Amt.textContent = formatMoney(b4Pence);
    if (elB4Cnt) elB4Cnt.textContent = `${b4Count} overdue`;

    // Render Recent Activity Feed
    const activityFeed = document.getElementById("activity-feed-list");
    if (activityFeed) {
      const activities = getStoredActivities();
      activityFeed.innerHTML = activities
        .map(
          (act) => `
          <div class="activity-item">
            <div class="activity-icon-wrap ${escapeHtml(act.type)}" aria-hidden="true">
              ${
                act.type === "paid"
                  ? "✓"
                  : act.type === "sent"
                  ? "✉"
                  : act.type === "draft"
                  ? "⚡"
                  : "!"
              }
            </div>
            <div class="activity-body">
              <div class="activity-line"><strong>${escapeHtml(act.title)}</strong></div>
              <div class="activity-meta">
                <span>${escapeHtml(act.detail)}</span>
                <span>·</span>
                <span>${escapeHtml(act.time)}</span>
              </div>
            </div>
            <div class="activity-amount">${escapeHtml(act.amount)}</div>
          </div>
        `
        )
        .join("");
    }
  }

  // ==========================================================================
  // 2. Debtor Ledger Table Logic (`debtors.html`)
  // ==========================================================================
  async function initDebtorsTable() {
    const tableBody = document.getElementById("debtor-table-body");
    if (!tableBody) return;

    let invoices = getStoredInvoices();

    // Try live API fetch
    try {
      const apiRes = await apiFetch("/api/portal/debtors?limit=100");
      if (apiRes.ok && apiRes.data?.debtors && apiRes.data.debtors.length > 0) {
        invoices = apiRes.data.debtors;
        saveStoredInvoices(invoices);
      }
    } catch {
      // Fallback to stored invoices
    }

    let currentFilterStage = "all";
    let currentFilterStatus = "all";
    let currentSearchTerm = "";
    let sortColumn = "days_overdue";
    let sortDirection = "desc"; // desc = highest overdue days first

    const searchInput = document.getElementById("debtor-search");
    const stageSelect = document.getElementById("filter-stage");
    const statusSelect = document.getElementById("filter-status");
    const resetBtn = document.getElementById("btn-reset-filters");
    const countBadge = document.getElementById("table-results-count");
    const csvExportBtn = document.getElementById("btn-export-csv");

    function getFilteredInvoices() {
      return invoices.filter((inv) => {
        // Search matching debtor name or invoice number
        const term = currentSearchTerm.toLowerCase();
        const matchesSearch =
          !term ||
          inv.debtor_name.toLowerCase().includes(term) ||
          inv.invoice_number.toLowerCase().includes(term) ||
          (inv.debtor_email && inv.debtor_email.toLowerCase().includes(term));

        // Stage filter
        const matchesStage =
          currentFilterStage === "all" || String(inv.stage) === String(currentFilterStage);

        // Status filter
        const matchesStatus =
          currentFilterStatus === "all" || inv.status.toLowerCase() === currentFilterStatus.toLowerCase();

        return matchesSearch && matchesStage && matchesStatus;
      });
    }

    function sortInvoices(list) {
      return list.sort((a, b) => {
        let valA = a[sortColumn];
        let valB = b[sortColumn];

        if (typeof valA === "string") valA = valA.toLowerCase();
        if (typeof valB === "string") valB = valB.toLowerCase();

        if (valA < valB) return sortDirection === "asc" ? -1 : 1;
        if (valA > valB) return sortDirection === "asc" ? 1 : -1;
        return 0;
      });
    }

    function renderTable() {
      const filtered = getFilteredInvoices();
      const sorted = sortInvoices(filtered);

      if (countBadge) {
        countBadge.textContent = `Showing ${sorted.length} of ${invoices.length} invoices`;
      }

      if (sorted.length === 0) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="8">
              <div class="empty-state">
                <div class="empty-state-icon" aria-hidden="true">🔍</div>
                <h3 class="empty-state-title">No matching invoices found</h3>
                <p>Try adjusting your search criteria or clearing active filters.</p>
              </div>
            </td>
          </tr>
        `;
        return;
      }

      tableBody.innerHTML = sorted
        .map((inv) => {
          let urgencyClass = "gentle";
          if (inv.days_overdue > 21) urgencyClass = "urgent";
          else if (inv.days_overdue > 14) urgencyClass = "warning";

          return `
          <tr>
            <td>
              <div class="debtor-cell">
                <span class="debtor-primary-name">${escapeHtml(inv.debtor_name)}</span>
                <span class="debtor-email-sub">${escapeHtml(inv.debtor_email || "No email on file")}</span>
              </div>
            </td>
            <td>
              <span class="inv-code">${escapeHtml(inv.invoice_number)}</span>
            </td>
            <td>
              <span class="amount-main">${formatMoney(inv.amount_pence, inv.currency)}</span>
            </td>
            <td>
              <span class="num">${escapeHtml(inv.due_date)}</span>
            </td>
            <td>
              <span class="overdue-badge ${urgencyClass}">
                <span aria-hidden="true">⏱</span>
                ${inv.days_overdue} days
              </span>
            </td>
            <td>
              <span class="badge badge-stage-${inv.stage}">
                <span class="badge-dot" aria-hidden="true"></span>
                Stage ${inv.stage} (${getStageName(inv.stage)})
              </span>
            </td>
            <td>
              <span class="badge badge-status-${escapeHtml(inv.status)}">
                ${capitalize(inv.status)}
              </span>
            </td>
            <td>
              <span class="num" style="font-size:0.82rem; color:var(--muted);">${escapeHtml(inv.last_contact)}</span>
            </td>
          </tr>
        `;
        })
        .join("");
    }

    function getStageName(stage) {
      switch (stage) {
        case 1: return "Gentle";
        case 2: return "Follow-up";
        case 3: return "Firm";
        case 4: return "Final";
        default: return "Reminder";
      }
    }

    function capitalize(s) {
      if (!s) return "";
      return s.charAt(0).toUpperCase() + s.slice(1);
    }

    // Search Event with Debounce
    let debounceTimer;
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          currentSearchTerm = e.target.value.trim();
          renderTable();
        }, 150);
      });
    }

    if (stageSelect) {
      stageSelect.addEventListener("change", (e) => {
        currentFilterStage = e.target.value;
        renderTable();
      });
    }

    if (statusSelect) {
      statusSelect.addEventListener("change", (e) => {
        currentFilterStatus = e.target.value;
        renderTable();
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        if (searchInput) searchInput.value = "";
        if (stageSelect) stageSelect.value = "all";
        if (statusSelect) statusSelect.value = "all";
        currentSearchTerm = "";
        currentFilterStage = "all";
        currentFilterStatus = "all";
        renderTable();
        showToast("Filters reset to default view");
      });
    }

    // Sort Headers
    const sortHeaders = document.querySelectorAll(".debtor-table th.sortable");
    sortHeaders.forEach((th) => {
      if (!th.hasAttribute("aria-sort")) {
        th.setAttribute("aria-sort", "none");
      }

      function handleSortAction() {
        const col = th.getAttribute("data-sort");
        if (sortColumn === col) {
          sortDirection = sortDirection === "asc" ? "desc" : "asc";
        } else {
          sortColumn = col;
          sortDirection = "asc";
        }

        // Update ARIA attributes (WCAG 2.2 AA)
        sortHeaders.forEach((h) => {
          h.setAttribute("aria-sort", "none");
          const icon = h.querySelector(".sort-icon");
          if (icon) icon.textContent = "↕";
        });

        th.setAttribute("aria-sort", sortDirection === "asc" ? "ascending" : "descending");
        const icon = th.querySelector(".sort-icon");
        if (icon) icon.textContent = sortDirection === "asc" ? "↑" : "↓";

        renderTable();
      }

      th.addEventListener("click", handleSortAction);

      // WCAG 2.2 AA: Keyboard support for table sort headers
      th.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleSortAction();
        }
      });
    });

    // Export CSV
    if (csvExportBtn) {
      csvExportBtn.addEventListener("click", () => {
        const rows = [
          ["Debtor Name", "Debtor Email", "Invoice Number", "Amount (£)", "Due Date", "Days Overdue", "Stage", "Status", "Last Contact"]
        ];

        const sorted = sortInvoices(getFilteredInvoices());
        sorted.forEach((i) => {
          rows.push([
            `"${i.debtor_name.replace(/"/g, '""')}"`,
            `"${(i.debtor_email || "").replace(/"/g, '""')}"`,
            `"${i.invoice_number}"`,
            (i.amount_pence / 100).toFixed(2),
            `"${i.due_date}"`,
            i.days_overdue,
            `"Stage ${i.stage}"`,
            `"${i.status}"`,
            `"${i.last_contact.replace(/"/g, '""')}"`
          ]);
        });

        const csvContent = "data:text/csv;charset=utf-8," + rows.map((e) => e.join(",")).join("\n");
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `invoice_rescue_debtors_${new Date().toISOString().slice(0, 10)}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast("Debtor ledger exported to CSV");
      });
    }

    renderTable();
  }

  // ==========================================================================
  // 3. Draft-Approval Queue Logic (`approval-queue.html`)
  // ==========================================================================
  async function initApprovalQueue() {
    const queueList = document.getElementById("approval-queue-list");
    if (!queueList) return;

    let drafts = getStoredDrafts();
    const countDisplay = document.getElementById("queue-count-display");

    // Try live API fetch first
    try {
      const apiRes = await apiFetch("/api/admin/drafts");
      if (apiRes.ok && apiRes.data?.drafts) {
        drafts = apiRes.data.drafts;
        saveStoredDrafts(drafts);
      }
    } catch {
      // Fallback to session drafts
    }

    function renderQueue() {
      if (countDisplay) {
        countDisplay.textContent = drafts.length;
      }
      updateNavDraftBadge();

      if (drafts.length === 0) {
        queueList.innerHTML = `
          <div class="panel">
            <div class="empty-state">
              <div class="empty-state-icon" aria-hidden="true">🎉</div>
              <h3 class="empty-state-title">All caught up! No drafts awaiting review</h3>
              <p>Every staged escalation has been reviewed and dispatched. The daily scheduler checks for overdue transitions at 06:00 UTC.</p>
              <div style="margin-top: 20px;">
                <a href="debtors.html" class="btn btn-secondary">View Debtor Ledger</a>
              </div>
            </div>
          </div>
        `;
        return;
      }

      queueList.innerHTML = drafts
        .map((draft, idx) => {
          const compensationPence = computeFixedCompensationPence(draft.amount_pence);
          const interestPence = computeStatutoryInterestPence(draft.amount_pence, draft.days_overdue);
          const totalClaimPence = draft.amount_pence + compensationPence + interestPence;

          return `
          <article class="draft-card" id="draft-card-${draft.id}" aria-labelledby="draft-heading-${draft.id}">
            <header class="draft-card-header">
              <div class="draft-debtor-info">
                <h3 id="draft-heading-${draft.id}" class="draft-debtor-name">${escapeHtml(draft.debtor_name)}</h3>
                <span class="draft-inv-tag">${escapeHtml(draft.invoice_number)}</span>
                <span class="badge badge-stage-${draft.step}">
                  <span class="badge-dot" aria-hidden="true"></span>
                  ${escapeHtml(draft.step_label)}
                </span>
              </div>
              <div class="overdue-badge urgent">
                <span aria-hidden="true">⏱</span>
                ${draft.days_overdue} days overdue
              </div>
            </header>

            <!-- Statutory Claim Financial Ribbon -->
            <div class="claim-breakdown-ribbon" role="region" aria-label="Statutory claim financial breakdown">
              <div class="claim-item">
                <span class="claim-label">Principal Invoice</span>
                <span class="claim-val">${formatMoney(draft.amount_pence, draft.currency)}</span>
              </div>
              <div class="claim-item">
                <span class="claim-label">Days Overdue</span>
                <span class="claim-val">${draft.days_overdue} days</span>
              </div>
              <div class="claim-item">
                <span class="claim-label">Fixed Compensation</span>
                <span class="claim-val">${formatMoney(compensationPence)}</span>
              </div>
              <div class="claim-item">
                <span class="claim-label">Statutory Interest</span>
                <span class="claim-val">${formatMoney(interestPence)}</span>
              </div>
              <div class="claim-item">
                <span class="claim-label">Total Claim Owed</span>
                <span class="claim-val total-val">${formatMoney(totalClaimPence, draft.currency)}</span>
              </div>
            </div>

            <!-- Email Envelope & Message Body -->
            <div class="draft-body-wrapper">
              <div class="envelope-meta">
                <div class="meta-row">
                  <span class="meta-key">From</span>
                  <span class="meta-val">
                    Invoice Rescue &lt;${escapeHtml(draft.locked_sender)}&gt;
                    <span class="meta-lock-tag" title="Sender address is locked to our verified email sending domain">🔒 Verified Sender</span>
                  </span>
                </div>
                <div class="meta-row">
                  <span class="meta-key">To</span>
                  <span class="meta-val">${escapeHtml(draft.debtor_name)} &lt;${escapeHtml(draft.debtor_email)}&gt;</span>
                </div>
                <div class="meta-row">
                  <span class="meta-key">Subject</span>
                  <span class="meta-val" style="font-weight:600;">${escapeHtml(draft.subject)}</span>
                </div>
              </div>

              <!-- Message Body Preview or Edit Mode -->
              <div class="message-preview-container" id="container-msg-${draft.id}">
                <div class="message-view-mode" id="view-mode-${draft.id}">
                  <div class="message-body-text" id="body-text-${draft.id}">${escapeHtml(draft.body)}</div>
                </div>

                <div class="message-edit-mode" id="edit-mode-${draft.id}" style="display:none;">
                  <label for="textarea-msg-${draft.id}" class="sr-only">Edit chase message text</label>
                  <textarea id="textarea-msg-${draft.id}" class="message-edit-area">${escapeHtml(draft.body)}</textarea>
                  <div class="edit-controls">
                    <span id="char-count-${draft.id}">${draft.body.length} characters</span>
                    <button type="button" class="btn btn-sm btn-secondary" onclick="window.InvoiceRescue.saveDraftEdit(${draft.id})">Save Edit</button>
                  </div>
                </div>

                <div class="human-signoff-stamp">
                  <span class="stamp-badge">Operator Sign-Off</span>
                  <span>Drafted by AI, verified by <strong>Tibor Rames</strong> on behalf of ${escapeHtml(draft.company_name)}.</span>
                </div>
              </div>
            </div>

            <!-- Action Controls -->
            <footer class="draft-card-actions">
              <button type="button" class="btn btn-outline" id="btn-edit-toggle-${draft.id}" onclick="window.InvoiceRescue.toggleEdit(${draft.id})">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                Edit Message
              </button>

              <div class="action-buttons-group">
                <button type="button" class="btn btn-secondary" onclick="window.InvoiceRescue.skipDraft(${draft.id})">
                  Skip / Defer
                </button>
                <button type="button" class="btn btn-primary" id="btn-approve-${draft.id}" onclick="window.InvoiceRescue.approveDraft(${draft.id})">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
                  Approve &amp; Send
                </button>
              </div>
            </footer>
          </article>
        `;
        })
        .join("");
    }

    // Window-accessible handlers for queue action buttons
    window.InvoiceRescue = window.InvoiceRescue || {};

    window.InvoiceRescue.toggleEdit = function (id) {
      const viewMode = document.getElementById(`view-mode-${id}`);
      const editMode = document.getElementById(`edit-mode-${id}`);
      const toggleBtn = document.getElementById(`btn-edit-toggle-${id}`);
      const textarea = document.getElementById(`textarea-msg-${id}`);

      if (!viewMode || !editMode) return;

      const isEditing = editMode.style.display !== "none";
      if (isEditing) {
        editMode.style.display = "none";
        viewMode.style.display = "block";
        toggleBtn.textContent = "Edit Message";
        if (toggleBtn) toggleBtn.focus(); // WCAG 2.2 AA: Focus restoration
      } else {
        editMode.style.display = "block";
        viewMode.style.display = "none";
        toggleBtn.textContent = "Cancel Edit";
        if (textarea) {
          textarea.focus();
          textarea.addEventListener("input", () => {
            const counter = document.getElementById(`char-count-${id}`);
            if (counter) counter.textContent = `${textarea.value.length} characters`;
          });
        }
      }
    };

    window.InvoiceRescue.saveDraftEdit = async function (id) {
      const textarea = document.getElementById(`textarea-msg-${id}`);
      const bodyText = document.getElementById(`body-text-${id}`);
      const toggleBtn = document.getElementById(`btn-edit-toggle-${id}`);
      if (!textarea || !bodyText) return;

      const newContent = textarea.value.trim();
      if (!newContent) {
        showToast("Draft message cannot be empty", "danger");
        return;
      }

      const draft = drafts.find((d) => d.id === id);
      if (draft) {
        try {
          await apiFetch(`/api/admin/drafts/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: newContent }),
          });
        } catch {
          // Keep local fallback
        }

        draft.body = newContent;
        saveStoredDrafts(drafts);
        bodyText.textContent = newContent;
        window.InvoiceRescue.toggleEdit(id);
        if (toggleBtn) toggleBtn.focus(); // WCAG 2.2 AA: Focus restoration
        showToast("Draft message updated successfully");
      }
    };

    window.InvoiceRescue.approveDraft = async function (id) {
      const btn = document.getElementById(`btn-approve-${id}`);
      const draft = drafts.find((d) => d.id === id);
      if (!draft) return;

      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner" aria-hidden="true">⏳</span> Sending...`;
      }

      // Try actual REST call: live /api/admin/drafts/:id/approve with fallback to /api/chase/:id/approve
      let res = null;
      try {
        res = await apiFetch(`/api/admin/drafts/${id}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: draft.body }),
        });

        if (!res.ok && res.status === 404) {
          const formData = new URLSearchParams();
          formData.append("body", draft.body);
          res = await apiFetch(`/api/chase/${id}/approve`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formData.toString(),
          });
        }
      } catch (err) {
        console.warn("Backend call bypassed or offline, updating local queue state:", err);
      }

      if (res && !res.ok && res.status !== 404) {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = "Approve & Send";
        }
        showToast(res.data?.error || "Failed to approve draft: " + res.status, "error");
        return;
      }

      // Remove from drafts list
      drafts = drafts.filter((d) => d.id !== id);
      saveStoredDrafts(drafts);

      // Record in recent activity
      addActivity({
        id: `act-${Date.now()}`,
        type: "sent",
        title: `Stage ${draft.step} dispatched`,
        detail: `${draft.invoice_number} sent to ${draft.debtor_name}`,
        amount: formatMoney(draft.amount_pence, draft.currency),
        time: "Just now",
      });

      // Update corresponding invoice status
      const invoices = getStoredInvoices();
      const matchInv = invoices.find((i) => i.id === draft.invoice_id);
      if (matchInv) {
        matchInv.last_contact = "Just now (Sent)";
        saveStoredInvoices(invoices);
      }

      showToast(`Approved and dispatched chase message for ${draft.debtor_name}`);
      renderQueue();
    };

    window.InvoiceRescue.skipDraft = async function (id) {
      const draft = drafts.find((d) => d.id === id);
      if (!draft) return;

      try {
        let res = await apiFetch(`/api/admin/drafts/${id}/skip`, {
          method: "POST",
        });
        if (!res.ok && res.status === 404) {
          await apiFetch(`/api/chase/${id}/skip`, { method: "POST" });
        }
      } catch (e) {
        // Offline / mock fallback
      }

      drafts = drafts.filter((d) => d.id !== id);
      saveStoredDrafts(drafts);
      showToast(`Draft for ${draft.invoice_number} skipped`, "danger");
      renderQueue();
    };

    renderQueue();
  }

  // ==========================================================================
  // DOM Initialization
  // ==========================================================================
  document.addEventListener("DOMContentLoaded", async () => {
    initTheme();
    await fetchStatutoryRate();
    await updateNavDraftBadge();
    await initOverviewDashboard();
    await initDebtorsTable();
    await initApprovalQueue();
  });
})();
