// SOS
// ==UserScript==
// @name         SOS to Sheets
// @namespace    https://github.com/THVjQ
// @version      1.1.0
// @description  Every ticket and walk-in sale marked Paid & Collected on a day, laid out as tracking-sheet rows (A–N) ready to paste. Read-only: it changes nothing in SOS POS.
// @author       THVjQ
// @match        https://app.sospos.com.au/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  if (window.__sosToSheetsLoaded__) return;
  window.__sosToSheetsLoaded__ = true;

  // Keep in lock-step with @version — the TM Script Manager strips the header before eval.
  const SCRIPT_VERSION = '1.1.0';

  const API = '/api/entities';
  /** The filter route caps `take` here and truncates silently past it. */
  const MAX_ROWS = 2000;

  // ═════════════════════════════════════════════════════════════
  // The row — one place to change when the sheet changes
  // ═════════════════════════════════════════════════════════════
  //
  //   A  Date paid            DD.MM.YY
  //   B  (blank)
  //   C  Ticket number
  //   D  Status               always "Paid & Collected"
  //   E  Cash taken that day
  //   F  EFTPOS taken that day
  //   G  User                 blank — filled in by hand
  //   H  User                 blank
  //   I  User                 blank
  //   J  Contacted            "Message sent" / "YES" — see contactCell()
  //   K  Total after discount
  //   L  Book                 blank
  //   M  "PIN"
  //   N  Name - Number - Email - Device - Issue    |   Walkin - Item $40 - Item $20

  const STATUS = 'Paid & Collected';

  function sheetRow(t, ctx) {
    const pay = ctx.paymentsFor(t);
    return [
      sheetDate(t.collected_at),
      '',
      t.ticket_number,
      STATUS,
      money(pay.cash),
      money(pay.eftpos),
      '',
      '',
      '',
      contactCell(t, ctx.notesFor(t)),
      money(totalAfterDiscount(t, ctx.addonsFor(t))),
      '',
      'PIN',
      isWalkin(t) ? describeWalkin(t, ctx.itemsFor(t)) : describeTicket(t),
    ].map(safeCell);
  }

  /**
   * Column J. A "Message sent dd/mm/yyyy - …" note is what the SMS panel leaves on a ticket when
   * a text goes out (`lib/sms-note.js`), so that is the one thing this can actually see.
   * Everything else is "YES" for now — NO has no rule yet.
   */
  function contactCell(t, notes) {
    if ((notes || []).some((n) => /^\s*message sent\b/i.test(n.text || ''))) return 'Message sent';
    return 'YES';
  }

  // ═════════════════════════════════════════════════════════════
  // Cells
  // ═════════════════════════════════════════════════════════════

  /** A tab or newline inside a cell shifts every later cell one column right in a live sheet. */
  const cleanCell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

  /** Sheets reads a leading = + - @ as a formula. Numbers are left alone. */
  function safeCell(v) {
    const s = cleanCell(v);
    if (!s || !/^[=+\-@]/.test(s) || /^-?\d/.test(s)) return s;
    return `'${s}`;
  }

  /** Plain number, no $, blank for zero, trailing zeros dropped: 220, 49.5. */
  function money(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || Math.abs(v) < 0.005) return '';
    return (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
  }

  const pad = (n) => String(n).padStart(2, '0');

  /** Local yyyy-MM-dd — the till dates Transactions from the browser's clock, so this must too. */
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function sheetDate(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)}`;
  }

  // ═════════════════════════════════════════════════════════════
  // Ticket → values
  // ═════════════════════════════════════════════════════════════

  const isWalkin = (t) => t.row_type === 'Sale';

  function addonValue(a) {
    const line = Number(a?.line_total);
    if (Number.isFinite(line) && line !== 0) return line;
    return (Number(a?.unit_price) || 0) * (Number(a?.qty) || 1);
  }

  /** The app's own figure when it has one, which already has the discount taken off. */
  function totalAfterDiscount(t, addons) {
    const final = Number(t.final_amount_due);
    if (t.final_amount_due != null && Number.isFinite(final)) return final;
    const extras = (addons || []).reduce((s, a) => s + addonValue(a), 0);
    return (Number(t.quote_amount) || 0) + extras - (Number(t.checkout_discount) || 0);
  }

  /** Madelyn Vanderwalt - 0430 281 559 - Apple iPhone 11 - Screen LT (blank parts skipped). */
  function describeTicket(t) {
    return [
      t.customer_name_snapshot || t.customer_name,
      t.customer_phone_snapshot || t.customer_phone,
      t.customer_email_snapshot || t.customer_email,
      t.device,
      t.issue || t.manual_issue,
    ].map(cleanCell).filter(Boolean).join(' - ');
  }

  /** Walkin - Wireless charger $50 - Case $20. Falls back to the board label for refurb sales. */
  function describeWalkin(t, items) {
    const parts = (items || [])
      .slice()
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .map((i) => {
        const price = money(i.price);
        return `${cleanCell(i.item_name)}${price ? ` $${price}` : ''}`;
      });
    if (!parts.length && cleanCell(t.device)) {
      const price = money(t.quote_amount);
      parts.push(`${cleanCell(t.device)}${price ? ` $${price}` : ''}`);
    }
    return ['Walkin', ...parts].join(' - ');
  }

  /**
   * Cash and EFTPOS taken *on the day*, from that day's Transaction records — so a deposit taken
   * last week isn't counted again today. Refunds come off. A ticket with no Transactions that day
   * (old data, a loader import) falls back to the totals stored on the ticket.
   */
  function paymentsIndex(transactions) {
    const byKey = {};
    for (const tx of transactions || []) {
      const key = tx.ticket_id || `#${tx.ticket_number}`;
      const sign = tx.type === 'refund' ? -1 : tx.type === 'payment' ? 1 : 0;
      if (!sign) continue;
      const slot = (byKey[key] ||= { cash: 0, eftpos: 0, other: 0 });
      const m = String(tx.method || '').toLowerCase();
      const bucket = m === 'cash' ? 'cash' : m === 'eftpos' ? 'eftpos' : 'other';
      slot[bucket] += sign * (Number(tx.amount) || 0);
    }
    return (t) =>
      byKey[t.id] || byKey[`#${t.ticket_number}`] ||
      { cash: Number(t.payment_cash) || 0, eftpos: Number(t.payment_eftpos) || 0, other: 0, fallback: true };
  }

  function buildRows(data) {
    const group = (rows, key) => {
      const out = {};
      for (const r of rows || []) (out[r[key]] ||= []).push(r);
      return out;
    };
    const notes = group(data.notes, 'ticket_id');
    const addons = group(data.addons, 'ticket_id');
    const items = group(data.items, 'sale_id');
    const ctx = {
      paymentsFor: paymentsIndex(data.transactions),
      notesFor: (t) => notes[t.id] || [],
      addonsFor: (t) => addons[t.id] || [],
      itemsFor: (t) => (t.sale_id && items[t.sale_id]) || [],
    };

    // Oldest first: the sheet is a day log, and the API's default order is newest first.
    const tickets = (data.tickets || [])
      .filter((t) => t.status === STATUS)
      .sort((a, b) => String(a.collected_at || '').localeCompare(String(b.collected_at || '')));

    return tickets.map((t) => {
      const p = ctx.paymentsFor(t);
      return {
        ticket: t,
        row: sheetRow(t, ctx),
        warnings: [
          p.fallback && 'no payment records that day — cash/EFTPOS taken from the ticket totals',
          p.other && `$${money(p.other)} by transfer/other isn't in E or F`,
        ].filter(Boolean),
      };
    });
  }

  // ═════════════════════════════════════════════════════════════
  // Fetching
  // ═════════════════════════════════════════════════════════════

  const storeId = () => { try { return localStorage.getItem('active_store_id') || ''; } catch { return ''; } };

  async function filter(entity, filters, fields) {
    const res = await fetch(`${API}/${entity}/filter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ filters, take: MAX_ROWS, fields }),
    });
    if (!res.ok) throw new Error(`${entity}: HTTP ${res.status}`);
    return res.json();
  }

  /** `$in` over a long id list, chunked so no one request gets huge or hits the row cap. */
  async function filterIn(entity, key, ids, fields) {
    const out = [];
    for (let i = 0; i < ids.length; i += 200) {
      out.push(...await filter(entity, { [key]: { $in: ids.slice(i, i + 200) } }, fields));
    }
    return out;
  }

  async function load(day) {
    const store_id = storeId();
    if (!store_id) throw new Error('No active store selected.');

    const tickets = await filter('Ticket', {
      store_id,
      status: STATUS,
      collected_at: {
        $gte: new Date(`${day}T00:00:00`).toISOString(),
        $lte: new Date(`${day}T23:59:59.999`).toISOString(),
      },
    }, [
      'id', 'ticket_number', 'row_type', 'status', 'sale_id', 'refurb_sale_id', 'device', 'issue',
      'manual_issue', 'customer_name', 'customer_phone', 'customer_email', 'customer_name_snapshot',
      'customer_phone_snapshot', 'customer_email_snapshot', 'quote_amount', 'checkout_discount',
      'final_amount_due', 'payment_cash', 'payment_eftpos', 'collected_at',
    ].join(','));

    const ids = tickets.map((t) => t.id);
    const saleIds = tickets.map((t) => t.sale_id).filter(Boolean);
    const [transactions, notes, addons, items] = await Promise.all([
      filter('Transaction', { store_id, date: day }, 'ticket_id,ticket_number,type,method,amount'),
      ids.length ? filterIn('TicketNote', 'ticket_id', ids, 'ticket_id,text') : [],
      ids.length ? filterIn('TicketAddon', 'ticket_id', ids, 'ticket_id,item_name,qty,unit_price,line_total') : [],
      saleIds.length ? filterIn('SaleItem', 'sale_id', saleIds, 'sale_id,item_name,price,position') : [],
    ]);

    return {
      rows: buildRows({ tickets, transactions, notes, addons, items }),
      truncated: tickets.length >= MAX_ROWS || transactions.length >= MAX_ROWS,
    };
  }

  // ═════════════════════════════════════════════════════════════
  // Popup
  // ═════════════════════════════════════════════════════════════

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const toTSV = (rows) => rows.map((r) => r.join('\t')).join('\n');
  const toHTML = (rows) => `<table>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
  const LETTERS = 'ABCDEFGHIJKLMN'.split('');

  const style = document.createElement('style');
  style.textContent = `
    #s2s-fab { position:fixed; bottom:20px; left:336px; width:44px; height:44px; border-radius:50%;
      background:#16a34a; box-shadow:0 3px 14px rgba(22,163,74,.55); border:none; cursor:pointer;
      z-index:99999; font-size:20px; display:flex; align-items:center; justify-content:center; }
    #s2s-fab:hover { background:#15803d; }
    #s2s-overlay { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:100000;
      display:none; align-items:center; justify-content:center; padding:16px; }
    #s2s-overlay.open { display:flex; }
    #s2s-modal { background:#0f172a; color:#e2e8f0; border-radius:16px; width:min(1100px,100%);
      max-height:calc(100vh - 32px); display:flex; flex-direction:column;
      box-shadow:0 20px 60px rgba(0,0,0,.7); font-family:'Segoe UI',system-ui,sans-serif; font-size:13px; }
    .s2s-head { display:flex; align-items:center; gap:10px; padding:14px 18px; border-bottom:1px solid #1e293b; }
    .s2s-head h2 { margin:0; font-size:16px; font-weight:700; flex:1; }
    .s2s-x { background:none; border:none; color:#94a3b8; font-size:22px; cursor:pointer; line-height:1; }
    .s2s-x:hover { color:#fff; }
    .s2s-bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:12px 18px; }
    .s2s-bar input { padding:6px 8px; border-radius:8px; border:1px solid #334155; background:#1e293b; color:#e2e8f0; }
    .s2s-btn { border-radius:8px; padding:7px 14px; cursor:pointer; font-size:13px; font-weight:600;
      border:1px solid #334155; background:#1e293b; color:#e2e8f0; }
    .s2s-btn:hover { background:#334155; }
    .s2s-copy { background:#16a34a; border-color:#16a34a; color:#fff; padding:9px 22px; font-size:14px; margin-left:auto; }
    .s2s-copy:hover { background:#15803d; }
    .s2s-copy:disabled { opacity:.4; cursor:default; }
    .s2s-body { padding:0 18px 12px; overflow:auto; flex:1; min-height:80px; }
    .s2s-table { border-collapse:collapse; font-size:12px; width:max-content; }
    .s2s-table th { position:sticky; top:0; background:#1e293b; padding:5px 8px; text-align:left; color:#94a3b8; }
    .s2s-table td { padding:5px 8px; border-top:1px solid #1e293b; max-width:320px; overflow:hidden;
      text-overflow:ellipsis; white-space:nowrap; }
    .s2s-table tr.warn td { background:rgba(245,158,11,.12); }
    .s2s-foot { padding:10px 18px; border-top:1px solid #1e293b; font-size:11px; color:#64748b; }
    .s2s-msg { padding:10px 0; }
  `;
  document.head.appendChild(style);

  let latest = null;

  function renderInto(container) {
    container.innerHTML = `
      <div class="s2s-bar">
        <input class="s2s-day" type="date" value="${ymd(new Date())}">
        <button class="s2s-btn s2s-fetch">↻ Refresh</button>
        <span class="s2s-count" style="color:#94a3b8"></span>
        <button class="s2s-btn s2s-copy" disabled>📋 Copy for Sheets</button>
      </div>
      <div class="s2s-body"><div class="s2s-msg">Reading…</div></div>
      <div class="s2s-foot">v${SCRIPT_VERSION} · Copy, then click column A of the first blank row in the sheet and press Ctrl+V</div>
    `;
    const day = container.querySelector('.s2s-day');
    container.querySelector('.s2s-fetch').addEventListener('click', () => refresh(container, day.value));
    day.addEventListener('change', () => refresh(container, day.value));
    container.querySelector('.s2s-copy').addEventListener('click', () => copy(container));
  }

  async function refresh(container, day) {
    const body = container.querySelector('.s2s-body');
    container.querySelector('.s2s-copy').disabled = true;
    container.querySelector('.s2s-count').textContent = '';
    body.innerHTML = '<div class="s2s-msg">Reading…</div>';
    try {
      latest = await load(day);
    } catch (err) {
      latest = null;
      body.innerHTML = `<div class="s2s-msg" style="color:#f87171">Couldn't read the tickets: ${esc(err.message)}</div>`;
      return;
    }
    paint(container, day);
  }

  function paint(container, day) {
    const body = container.querySelector('.s2s-body');
    const n = latest.rows.length;
    container.querySelector('.s2s-copy').disabled = !n;
    container.querySelector('.s2s-count').textContent = n ? `${n} row${n === 1 ? '' : 's'}` : '';

    if (!n) {
      body.innerHTML = `<div class="s2s-msg" style="color:#f59e0b">Nothing marked ${STATUS} on ${esc(day)}.</div>`;
      return;
    }

    const warned = latest.rows.filter((r) => r.warnings.length);
    body.innerHTML = `
      ${latest.truncated ? `<div class="s2s-msg" style="color:#f59e0b">The server capped this read at ${MAX_ROWS} rows — the day is cut short.</div>` : ''}
      <table class="s2s-table">
        <thead><tr>${LETTERS.map((l) => `<th>${l}</th>`).join('')}</tr></thead>
        <tbody>${latest.rows.map(({ row, warnings }) => `
          <tr class="${warnings.length ? 'warn' : ''}">${row.map((c) => `<td title="${esc(c)}">${esc(c)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
      ${warned.length ? `<div class="s2s-msg" style="color:#f59e0b">
        ${warned.map((r) => `<div><b>${esc(r.ticket.ticket_number)}</b>: ${esc(r.warnings.join('; '))}</div>`).join('')}
      </div>` : ''}
    `;
  }

  async function copy(container) {
    if (!latest?.rows.length) return;
    const rows = latest.rows.map((r) => r.row);
    const btn = container.querySelector('.s2s-copy');
    try {
      if (navigator.clipboard?.write && typeof window.ClipboardItem === 'function') {
        // Both flavours: Sheets takes the HTML table and gets real cells.
        await navigator.clipboard.write([new window.ClipboardItem({
          'text/plain': new Blob([toTSV(rows)], { type: 'text/plain' }),
          'text/html': new Blob([toHTML(rows)], { type: 'text/html' }),
        })]);
      } else {
        await navigator.clipboard.writeText(toTSV(rows));
      }
      btn.textContent = `✓ Copied ${rows.length} row${rows.length === 1 ? '' : 's'}`;
    } catch {
      btn.textContent = 'Copy blocked — try again';
    }
    setTimeout(() => { btn.textContent = '📋 Copy for Sheets'; }, 2500);
  }

  // ═════════════════════════════════════════════════════════════
  // Launch: the dock chip if the SOS Dock is installed, else our own button
  // ═════════════════════════════════════════════════════════════

  const config = {
    id: 'sos-to-sheets',
    title: 'SOS → Sheets',
    icon: '📋',
    order: 15,
    onOpen(container) {
      container.style.cssText += ';background:#0f172a;color:#e2e8f0';
      renderInto(container);
      refresh(container, ymd(new Date()));
    },
  };

  /** Bottom left, in the same row as the Sales Loader (224px) and Ticket Loader (280px). */
  function mountLegacyFab() {
    const fab = document.createElement('button');
    fab.id = 's2s-fab';
    fab.title = 'SOS → Sheets';
    fab.textContent = '📋';

    const overlay = document.createElement('div');
    overlay.id = 's2s-overlay';
    overlay.innerHTML = `
      <div id="s2s-modal" role="dialog" aria-label="SOS to Sheets">
        <div class="s2s-head"><h2>📋 SOS → Sheets · Paid &amp; Collected</h2><button class="s2s-x" title="Close">×</button></div>
        <div class="s2s-content" style="display:flex;flex-direction:column;min-height:0;flex:1"></div>
      </div>`;
    const content = overlay.querySelector('.s2s-content');
    renderInto(content);

    const close = () => overlay.classList.remove('open');
    const open = () => {
      overlay.classList.add('open');
      // Fresh every time it opens — the sheet is filled from what is collected *now*.
      refresh(content, content.querySelector('.s2s-day').value);
    };

    fab.addEventListener('click', () => (overlay.classList.contains('open') ? close() : open()));
    overlay.querySelector('.s2s-x').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.body.append(overlay, fab);
  }

  if (window.SOSDock) window.SOSDock.register(config);
  else {
    window.__SOSDockQueue__ = window.__SOSDockQueue__ || [];
    window.__SOSDockQueue__.push(config);
    setTimeout(() => {
      if (window.SOSDock) return;
      console.warn('[SOS to Sheets] SOS Dock not present — using the legacy button.');
      mountLegacyFab();
    }, 3000);
  }

  // Exposed for the test and for checking a row by hand from the console.
  window.__sosToSheets = { buildRows, sheetRow, describeTicket, describeWalkin, contactCell, sheetDate, money, load };
})();
