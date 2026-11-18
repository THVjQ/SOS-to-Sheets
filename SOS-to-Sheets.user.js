// SOS
// ==UserScript==
// @name         SOS to Sheets
// @namespace    https://github.com/THVjQ
// @version      1.4.0
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
  const SCRIPT_VERSION = '1.4.0';

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
  //   J  Contacted            "SMS" / "YES" — see contactCell()
  //   K  Total after discount
  //   L  Book                 blank
  //   M  "PIN"
  //   N  Name - Number - Email - Device - Issues - Part Warranty $cost …    |   Walkin - #SKU $595 Model - Item $40 - Item $20

  const STATUS = 'Paid & Collected';

  /**
   * Both sections share this row. The only difference is D: the collected section is all
   * "Paid & Collected", the payments section shows whatever status the ticket is in now.
   */
  function sheetRow(t, ctx) {
    const pay = ctx.paymentsFor(t);
    return [
      sheetDate(`${ctx.day}T12:00:00`),
      '',
      t.ticket_number,
      t.status || '',
      money(pay.cash),
      money(pay.eftpos),
      '',
      '',
      '',
      contactCell(t, ctx.notesFor(t)),
      money(totalAfterDiscount(t, ctx.addonsFor(t))),
      '',
      'PIN',
      isWalkin(t) ? describeWalkin(t, ctx.itemsFor(t), ctx.unitsFor(t)) : describeTicket(t, ctx.issuesFor(t), ctx.partsFor(t)),
    ].map(safeCell);
  }

  /**
   * Column J. A "Message sent dd/mm/yyyy - …" note is what the SMS panel leaves on a ticket when
   * a text goes out (`lib/sms-note.js`), so that is the one thing this can actually see.
   * Everything else is "YES" for now — NO has no rule yet.
   */
  function contactCell(t, notes) {
    if ((notes || []).some((n) => /^\s*message sent\b/i.test(n.text || ''))) return 'SMS';
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

  /**
   * Maisie Morrow - 0439 281 184 - maisie@… - Samsung A56 5G - Screen, Battery - Screen OLED LT $120 - Battery 6m $35
   *
   * Issues are the ticket's old single `issue` text plus its TicketIssue list (newer tickets only
   * fill the list), de-duplicated. Then one entry per fitted part: name, warranty, what it cost.
   * Blank pieces are skipped rather than leaving "- -" gaps.
   */
  function describeTicket(t, issueNames, parts) {
    const issues = [];
    for (const name of [t.issue || t.manual_issue, ...(issueNames || [])].map(cleanCell)) {
      if (name && !issues.some((i) => i.toLowerCase() === name.toLowerCase())) issues.push(name);
    }
    const fitted = (parts || []).map((p) => {
      const qty = Number(p.qty) || 1;
      const cost = p.cost == null ? '' : money(Number(p.cost) * qty);
      return [
        `${qty > 1 ? `${qty} × ` : ''}${cleanCell(p.name_snapshot)}`,
        cleanCell(p.warranty),
        cost ? `$${cost}` : '',
      ].filter(Boolean).join(' ');
    });
    return [
      t.customer_name_snapshot || t.customer_name,
      t.customer_phone_snapshot || t.customer_phone,
      t.customer_email_snapshot || t.customer_email,
      t.device,
      issues.join(', '),
    ].map(cleanCell).concat(fitted).filter(Boolean).join(' - ');
  }

  /**
   * Walkin - #SKU $595 Samsung Galaxy S23 128GB Black - Data transfer $30 - Silicon case $20.
   *
   * A refurb handset isn't a SaleItem — it's a RefurbSale row pointing at RefurbStock — so it
   * comes in as `units` and goes first, the way it reads on the docket. Accessories follow.
   */
  function describeWalkin(t, items, units) {
    const phones = (units || []).map((u) => {
      const price = money(u.price);
      return [u.sku ? `#${cleanCell(u.sku)}` : '', price ? `$${price}` : '', cleanCell(u.label)]
        .filter(Boolean).join(' ');
    }).filter(Boolean);
    const parts = (items || [])
      .slice()
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .map((i) => {
        const price = money(i.price);
        return `${cleanCell(i.item_name)}${price ? ` $${price}` : ''}`;
      });
    if (!parts.length && !phones.length && cleanCell(t.device)) {
      const price = money(t.quote_amount);
      parts.push(`${cleanCell(t.device)}${price ? ` $${price}` : ''}`);
    }
    return ['Walkin', ...phones, ...parts].join(' - ');
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

  /**
   * @returns {{collected: Row[], paid: Row[]}} — `collected` is everything Paid & Collected on
   * the day; `paid` is every other ticket that took a payment that day (deposits, part payments,
   * a ticket collected another day), each once, never in both.
   */
  function buildRows(data) {
    const group = (rows, key) => {
      const out = {};
      for (const r of rows || []) (out[r[key]] ||= []).push(r);
      return out;
    };
    const notes = group(data.notes, 'ticket_id');
    const addons = group(data.addons, 'ticket_id');
    const items = group(data.items, 'sale_id');
    const units = group(data.units, 'ticket_id');
    const parts = group(data.parts, 'ticket_id');
    const issueName = Object.fromEntries((data.issueCatalogue || []).map((i) => [i.id, i.issue_name]));
    const issues = {};
    for (const ti of data.ticketIssues || []) {
      if (issueName[ti.issue_id]) (issues[ti.ticket_id] ||= []).push(issueName[ti.issue_id]);
    }
    const ctx = {
      day: data.day,
      partsFor: (t) => (parts[t.id] || []).slice().sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || ''))),
      issuesFor: (t) => issues[t.id] || [],
      unitsFor: (t) => units[t.id] || [],
      paymentsFor: paymentsIndex(data.transactions),
      notesFor: (t) => notes[t.id] || [],
      addonsFor: (t) => addons[t.id] || [],
      itemsFor: (t) => (t.sale_id && items[t.sale_id]) || [],
    };

    const toRow = (t) => {
      const p = ctx.paymentsFor(t);
      return {
        ticket: t,
        row: sheetRow(t, ctx),
        warnings: [
          p.fallback && 'no payment records that day — cash/EFTPOS taken from the ticket totals',
          p.other && `$${money(p.other)} by transfer/other isn't in E or F`,
        ].filter(Boolean),
      };
    };

    const collected = (data.tickets || []).filter((t) => t.status === STATUS);
    const taken = new Set(collected.map((t) => t.id));
    const paid = (data.paidTickets || []).filter((t) => !taken.has(t.id) && (taken.add(t.id), true));

    return {
      collected: sortRows(collected.map(toRow), 'ticket'),
      paid: sortRows(paid.map(toRow), 'ticket'),
    };
  }

  /** "A5490" before "A5517", and A999 before A1000 — numeric-aware, not plain text order. */
  const byTicket = (a, b) =>
    String(a.ticket.ticket_number || '').localeCompare(String(b.ticket.ticket_number || ''), undefined, { numeric: true });
  const byTime = (a, b) =>
    String(a.ticket.collected_at || '').localeCompare(String(b.ticket.collected_at || '')) || byTicket(a, b);

  /** 'manual' leaves the order as it stands — that is the order someone dragged it into. */
  function sortRows(rows, mode) {
    if (mode === 'ticket') return rows.slice().sort(byTicket);
    if (mode === 'time') return rows.slice().sort(byTime);
    return rows;
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

  /**
   * The handsets on refurb sales, one entry per unit: { ticket_id, sku, price, label }.
   *
   * A sale can carry several units, each its own RefurbSale with `ticket_id` set. Older ones may
   * predate that link, so the ticket's own `refurb_sale_id` is read as well and pinned to it.
   */
  async function loadRefurbUnits(tickets) {
    const ticketIds = tickets.map((t) => t.id);
    const saleFields = 'id,ticket_id,stock_id,sell_price_at_sale,total,created_date';
    const [linked, direct] = await Promise.all([
      filterIn('RefurbSale', 'ticket_id', ticketIds, saleFields),
      filterIn('RefurbSale', 'id', tickets.map((t) => t.refurb_sale_id), saleFields),
    ]);
    const owner = Object.fromEntries(tickets.map((t) => [t.refurb_sale_id, t.id]));
    const sales = new Map();
    for (const rs of [...linked, ...direct]) sales.set(rs.id, { ...rs, ticket_id: rs.ticket_id || owner[rs.id] });

    const stockIds = [...new Set([...sales.values()].map((rs) => rs.stock_id).filter(Boolean))];
    const stock = stockIds.length
      ? Object.fromEntries((await filterIn('RefurbStock', 'id', stockIds, 'id,sku,brand,model,storage,colour,sell_price'))
        .map((u) => [u.id, u]))
      : {};

    return [...sales.values()]
      .sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || '')))
      .map((rs) => {
        const u = stock[rs.stock_id] || {};
        return {
          ticket_id: rs.ticket_id,
          sku: u.sku,
          price: rs.sell_price_at_sale || rs.total || u.sell_price,
          label: [u.brand, u.model, u.storage, u.colour].map(cleanCell).filter(Boolean).join(' '),
        };
      });
  }

  async function load(day) {
    const store_id = storeId();
    if (!store_id) throw new Error('No active store selected.');

    const fields = [
      'id', 'ticket_number', 'row_type', 'status', 'sale_id', 'refurb_sale_id', 'device', 'issue',
      'manual_issue', 'customer_name', 'customer_phone', 'customer_email', 'customer_name_snapshot',
      'customer_phone_snapshot', 'customer_email_snapshot', 'quote_amount', 'checkout_discount',
      'final_amount_due', 'payment_cash', 'payment_eftpos', 'collected_at',
    ].join(',');

    const [tickets, transactions] = await Promise.all([
      filter('Ticket', {
        store_id,
        status: STATUS,
        collected_at: {
          $gte: new Date(`${day}T00:00:00`).toISOString(),
          $lte: new Date(`${day}T23:59:59.999`).toISOString(),
        },
      }, fields),
      filter('Transaction', { store_id, date: day }, 'ticket_id,ticket_number,type,method,amount'),
    ]);

    // Every other ticket that took a payment that day. Refund-only days don't count — the
    // section is "paid on this day". Older Transactions can lack ticket_id, so match on number too.
    const collectedIds = new Set(tickets.map((t) => t.id));
    const payments = transactions.filter((tx) => tx.type === 'payment');
    const payIds = [...new Set(payments.map((tx) => tx.ticket_id).filter((id) => id && !collectedIds.has(id)))];
    const payNumbers = [...new Set(payments.filter((tx) => !tx.ticket_id && tx.ticket_number).map((tx) => tx.ticket_number))];
    const [byId, byNumber] = await Promise.all([
      payIds.length ? filterIn('Ticket', 'id', payIds, fields) : [],
      payNumbers.length ? filter('Ticket', { store_id, ticket_number: { $in: payNumbers } }, fields) : [],
    ]);
    const paidTickets = [...byId, ...byNumber].filter((t) => !collectedIds.has(t.id));

    const all = [...tickets, ...paidTickets];
    const ids = all.map((t) => t.id);
    const saleIds = all.map((t) => t.sale_id).filter(Boolean);
    const refurbTickets = all.filter((t) => t.refurb_sale_id);
    const repairIds = all.filter((t) => !isWalkin(t)).map((t) => t.id);
    const [notes, addons, items, units, parts, ticketIssues] = await Promise.all([
      ids.length ? filterIn('TicketNote', 'ticket_id', ids, 'ticket_id,text') : [],
      ids.length ? filterIn('TicketAddon', 'ticket_id', ids, 'ticket_id,item_name,qty,unit_price,line_total') : [],
      saleIds.length ? filterIn('SaleItem', 'sale_id', saleIds, 'sale_id,item_name,price,position') : [],
      refurbTickets.length ? loadRefurbUnits(refurbTickets) : [],
      repairIds.length ? filterIn('PartUsage', 'ticket_id', repairIds, 'ticket_id,name_snapshot,qty,warranty,cost,created_date') : [],
      repairIds.length ? filterIn('TicketIssue', 'ticket_id', repairIds, 'ticket_id,issue_id,created_date') : [],
    ]);
    const issueIds = [...new Set(ticketIssues.map((ti) => ti.issue_id).filter(Boolean))];
    const issueCatalogue = issueIds.length ? await filterIn('IssueCatalogue', 'id', issueIds, 'id,issue_name') : [];

    return {
      ...buildRows({ day, tickets, paidTickets, transactions, notes, addons, items, units, parts, ticketIssues, issueCatalogue }),
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
    .s2s-copy { background:#16a34a; border-color:#16a34a; color:#fff; padding:8px 18px; }
    .s2s-copy:hover { background:#15803d; }
    .s2s-copy:disabled { opacity:.4; cursor:default; }
    .s2s-body { padding:0 18px 12px; overflow:auto; flex:1; min-height:80px; }
    .s2s-table { border-collapse:collapse; font-size:12px; width:max-content; }
    .s2s-section { margin-bottom:18px; }
    .s2s-sechead { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
    .s2s-sechead h3 { margin:0; font-size:14px; font-weight:700; }
    .s2s-count { color:#94a3b8; flex:1; }
    .s2s-sort { color:#94a3b8; font-size:12px; display:flex; align-items:center; gap:6px; }
    .s2s-sort select { padding:5px 6px; border-radius:8px; border:1px solid #334155; background:#1e293b; color:#e2e8f0; }
    .s2s-scroll { overflow:auto; max-height:40vh; border:1px solid #1e293b; border-radius:8px; }
    .s2s-move { white-space:nowrap; }
    .s2s-move button { background:none; border:none; color:#94a3b8; cursor:pointer; padding:0 3px; font-size:13px; }
    .s2s-move button:hover:not(:disabled) { color:#fff; }
    .s2s-move button:disabled { opacity:.25; cursor:default; }
    .s2s-grip { cursor:grab; color:#64748b; padding-right:4px; }
    .s2s-table tr.dragging td { opacity:.4; }
    .s2s-table tr.over td { border-top:2px solid #16a34a; }
    .s2s-table th { position:sticky; top:0; background:#1e293b; padding:5px 8px; text-align:left; color:#94a3b8; }
    .s2s-table td { padding:5px 8px; border-top:1px solid #1e293b; max-width:320px; overflow:hidden;
      text-overflow:ellipsis; white-space:nowrap; }
    .s2s-table tr.warn td { background:rgba(245,158,11,.12); }
    .s2s-foot { padding:10px 18px; border-top:1px solid #1e293b; font-size:11px; color:#64748b; }
    .s2s-msg { padding:10px 0; }
  `;
  document.head.appendChild(style);

  let latest = null;

  /** The two sections, in the order they appear. Sort choice is remembered per section. */
  const SECTIONS = [
    { key: 'collected', title: 'Paid & Collected', empty: `Nothing marked ${STATUS} on this day.` },
    { key: 'paid', title: 'Other payments taken this day', empty: 'No other tickets took a payment this day.' },
  ];
  const SORT_KEY = 's2s_sort';
  const sortPrefs = (() => { try { return JSON.parse(localStorage.getItem(SORT_KEY) || '{}'); } catch { return {}; } })();
  const sortFor = (key) => sortPrefs[key] || 'ticket';
  function setSort(key, mode) {
    sortPrefs[key] = mode;
    try { localStorage.setItem(SORT_KEY, JSON.stringify(sortPrefs)); } catch { /* not fatal */ }
  }

  function renderInto(container) {
    container.innerHTML = `
      <div class="s2s-bar">
        <input class="s2s-day" type="date" value="${ymd(new Date())}">
        <button class="s2s-btn s2s-fetch">↻ Refresh</button>
      </div>
      <div class="s2s-body"><div class="s2s-msg">Reading…</div></div>
      <div class="s2s-foot">v${SCRIPT_VERSION} · Copy a section, then click column A of the first blank row in the sheet and press Ctrl+V. Drag ⠿ or use ↑↓ to put rows in your own order.</div>
    `;
    const day = container.querySelector('.s2s-day');
    container.querySelector('.s2s-fetch').addEventListener('click', () => refresh(container, day.value));
    day.addEventListener('change', () => refresh(container, day.value));
  }

  async function refresh(container, day) {
    const body = container.querySelector('.s2s-body');
    body.innerHTML = '<div class="s2s-msg">Reading…</div>';
    try {
      latest = await load(day);
    } catch (err) {
      latest = null;
      body.innerHTML = `<div class="s2s-msg" style="color:#f87171">Couldn't read the tickets: ${esc(err.message)}</div>`;
      return;
    }
    for (const s of SECTIONS) latest[s.key] = sortRows(latest[s.key], sortFor(s.key));
    paint(container);
  }

  function paint(container) {
    const body = container.querySelector('.s2s-body');
    body.innerHTML = `
      ${latest.truncated ? `<div class="s2s-msg" style="color:#f59e0b">The server capped this read at ${MAX_ROWS} rows — the day is cut short.</div>` : ''}
      ${SECTIONS.map((s) => sectionHTML(s, latest[s.key])).join('')}
    `;
    wire(container);
  }

  function sectionHTML(s, rows) {
    const n = rows.length;
    const mode = sortFor(s.key);
    const warned = rows.filter((r) => r.warnings.length);
    return `
      <div class="s2s-section" data-section="${s.key}">
        <div class="s2s-sechead">
          <h3>${esc(s.title)}</h3>
          <span class="s2s-count">${n} row${n === 1 ? '' : 's'}</span>
          <label class="s2s-sort">Sort
            <select class="s2s-sortsel">
              <option value="ticket"${mode === 'ticket' ? ' selected' : ''}>Ticket #</option>
              <option value="time"${mode === 'time' ? ' selected' : ''}>Time collected</option>
              <option value="manual"${mode === 'manual' ? ' selected' : ''}>Manual</option>
            </select>
          </label>
          <button class="s2s-btn s2s-copy"${n ? '' : ' disabled'}>📋 Copy ${n} row${n === 1 ? '' : 's'}</button>
        </div>
        ${n ? `
        <div class="s2s-scroll">
          <table class="s2s-table">
            <thead><tr><th></th>${LETTERS.map((l) => `<th>${l}</th>`).join('')}</tr></thead>
            <tbody>${rows.map(({ row, warnings }, i) => `
              <tr class="${warnings.length ? 'warn' : ''}" draggable="true" data-i="${i}">
                <td class="s2s-move"><span class="s2s-grip" title="Drag to move">⠿</span><button class="s2s-up" title="Move up"${i ? '' : ' disabled'}>↑</button><button class="s2s-down" title="Move down"${i < n - 1 ? '' : ' disabled'}>↓</button></td>
                ${row.map((c) => `<td title="${esc(c)}">${esc(c)}</td>`).join('')}
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${warned.length ? `<div class="s2s-msg" style="color:#f59e0b">
          ${warned.map((r) => `<div><b>${esc(r.ticket.ticket_number)}</b>: ${esc(r.warnings.join('; '))}</div>`).join('')}
        </div>` : ''}` : `<div class="s2s-msg" style="color:#94a3b8">${esc(s.empty)}</div>`}
      </div>`;
  }

  /** Moving a row by hand switches that section to Manual, so a re-sort doesn't undo it. */
  function move(container, key, from, to) {
    const rows = latest[key];
    if (to < 0 || to >= rows.length || from === to) return;
    const [r] = rows.splice(from, 1);
    rows.splice(to, 0, r);
    setSort(key, 'manual');
    paint(container);
  }

  function wire(container) {
    container.querySelectorAll('.s2s-section').forEach((sec) => {
      const key = sec.dataset.section;
      sec.querySelector('.s2s-sortsel').addEventListener('change', (e) => {
        setSort(key, e.target.value);
        latest[key] = sortRows(latest[key], e.target.value);
        paint(container);
      });
      sec.querySelector('.s2s-copy').addEventListener('click', (e) => copy(e.currentTarget, latest[key]));

      let dragFrom = null;
      sec.querySelectorAll('tbody tr').forEach((tr) => {
        const i = Number(tr.dataset.i);
        tr.querySelector('.s2s-up').addEventListener('click', () => move(container, key, i, i - 1));
        tr.querySelector('.s2s-down').addEventListener('click', () => move(container, key, i, i + 1));
        tr.addEventListener('dragstart', (e) => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; tr.classList.add('dragging'); });
        tr.addEventListener('dragend', () => tr.classList.remove('dragging'));
        tr.addEventListener('dragover', (e) => { if (dragFrom !== null) { e.preventDefault(); tr.classList.add('over'); } });
        tr.addEventListener('dragleave', () => tr.classList.remove('over'));
        tr.addEventListener('drop', (e) => {
          e.preventDefault();
          if (dragFrom !== null) move(container, key, dragFrom, i);
          dragFrom = null;
        });
      });
    });
  }

  async function copy(btn, sectionRows) {
    if (!sectionRows?.length) return;
    const rows = sectionRows.map((r) => r.row);
    const label = btn.textContent;
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
    setTimeout(() => { btn.textContent = label; }, 2500);
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
        <div class="s2s-head"><h2>📋 SOS → Sheets</h2><button class="s2s-x" title="Close">×</button></div>
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
