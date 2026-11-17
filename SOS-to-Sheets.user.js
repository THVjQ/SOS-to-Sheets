// SOS
// ==UserScript==
// @name         SOS to Sheets
// @namespace    https://github.com/THVjQ
// @version      1.0.1
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
  const SCRIPT_VERSION = '1.0.1';

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
  // Panel
  // ═════════════════════════════════════════════════════════════

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const toTSV = (rows) => rows.map((r) => r.join('\t')).join('\n');
  const toHTML = (rows) => `<table>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
  const LETTERS = 'ABCDEFGHIJKLMN'.split('');

  let latest = null;

  function renderInto(container) {
    container.innerHTML = `
      <div style="padding:14px;font-family:'Segoe UI',system-ui,sans-serif;font-size:13px">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input id="s2s-day" type="date" value="${ymd(new Date())}" style="padding:4px 6px;border-radius:6px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit">
          <button id="s2s-fetch" style="background:transparent;color:inherit;border:1px solid rgba(128,128,128,.4);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px">Fetch</button>
          <button id="s2s-copy" disabled style="background:#4f46e5;color:#fff;border:none;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px">Copy rows</button>
        </div>
        <div id="s2s-body" style="margin-top:12px;opacity:.7">Pick a day and press Fetch.</div>
        <div style="margin-top:10px;font-size:11px;opacity:.55">v${SCRIPT_VERSION} · paste into column A of the first blank row</div>
      </div>
    `;
    const dayInput = container.querySelector('#s2s-day');
    container.querySelector('#s2s-fetch').addEventListener('click', () => refresh(container, dayInput.value));
    container.querySelector('#s2s-copy').addEventListener('click', () => copy(container));
  }

  async function refresh(container, day) {
    const body = container.querySelector('#s2s-body');
    body.style.opacity = '.7';
    body.textContent = 'Reading…';
    try {
      latest = await load(day);
    } catch (err) {
      latest = null;
      body.innerHTML = `<div style="color:#f87171">Couldn't read the tickets: ${esc(err.message)}</div>`;
      container.querySelector('#s2s-copy').disabled = true;
      return;
    }
    paint(container, day);
  }

  function paint(container, day) {
    const body = container.querySelector('#s2s-body');
    const copyBtn = container.querySelector('#s2s-copy');
    body.style.opacity = '1';
    copyBtn.disabled = !latest.rows.length;

    if (!latest.rows.length) {
      body.innerHTML = `<div style="color:#f59e0b">Nothing marked ${STATUS} on ${esc(day)}.</div>`;
      return;
    }

    const warned = latest.rows.filter((r) => r.warnings.length);
    body.innerHTML = `
      <div style="margin-bottom:6px">${latest.rows.length} row${latest.rows.length === 1 ? '' : 's'}</div>
      ${latest.truncated ? `<div style="margin-bottom:8px;color:#f59e0b">The server capped this read at ${MAX_ROWS} rows — the day is cut short.</div>` : ''}
      <div style="max-height:260px;overflow:auto;border:1px solid rgba(128,128,128,.3);border-radius:8px">
        <table style="border-collapse:collapse;font-size:11px;width:max-content">
          <thead><tr>${LETTERS.map((l) => `<th style="position:sticky;top:0;background:rgba(128,128,128,.2);padding:3px 6px;text-align:left">${l}</th>`).join('')}</tr></thead>
          <tbody>${latest.rows.map(({ row, warnings }) => `
            <tr style="${warnings.length ? 'background:rgba(245,158,11,.12)' : ''}">
              ${row.map((c) => `<td title="${esc(c)}" style="padding:3px 6px;border-top:1px solid rgba(128,128,128,.2);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c)}</td>`).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${warned.length ? `<div style="margin-top:8px;font-size:12px;color:#f59e0b">
        ${warned.map((r) => `<div><b>${esc(r.ticket.ticket_number)}</b>: ${esc(r.warnings.join('; '))}</div>`).join('')}
      </div>` : ''}
    `;
  }

  async function copy(container) {
    if (!latest?.rows.length) return;
    const rows = latest.rows.map((r) => r.row);
    const btn = container.querySelector('#s2s-copy');
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
      btn.textContent = `Copied ${rows.length}`;
    } catch {
      btn.textContent = 'Copy blocked — select the table';
    }
    setTimeout(() => { btn.textContent = 'Copy rows'; }, 2000);
  }

  // ═════════════════════════════════════════════════════════════
  // Dock registration
  // ═════════════════════════════════════════════════════════════

  const config = {
    id: 'sos-to-sheets',
    title: 'SOS → Sheets',
    icon: '📋',
    order: 15,
    onOpen(container) { renderInto(container); },
  };

  /**
   * Without the SOS Dock there is nothing to draw the chip, so the script brings its own round
   * button, bottom left in the same row as the Sales Loader (224px) and Ticket Loader (280px).
   */
  function mountLegacyFab() {
    const fab = document.createElement('button');
    fab.id = 's2s-fab';
    fab.title = 'SOS → Sheets';
    fab.textContent = '📋';
    fab.style.cssText = 'position:fixed;bottom:20px;left:336px;width:44px;height:44px;border-radius:50%;'
      + 'background:#16a34a;box-shadow:0 3px 14px rgba(22,163,74,.55);border:none;cursor:pointer;'
      + 'z-index:99999;font-size:20px;display:flex;align-items:center;justify-content:center';

    const panel = document.createElement('div');
    panel.id = 's2s-panel';
    panel.style.cssText = 'position:fixed;bottom:72px;left:20px;width:min(720px,calc(100vw - 40px));'
      + 'background:#0f172a;color:#e2e8f0;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.7);'
      + 'z-index:99998;display:none';
    renderInto(panel);

    fab.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    document.body.append(panel, fab);
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
