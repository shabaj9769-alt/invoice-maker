import React, { useState, useEffect, useContext, useMemo, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Linking, Share, Modal, Keyboard,
  useColorScheme, Platform, KeyboardAvoidingView, Switch, Alert, BackHandler, Dimensions, AppState,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { TERMS, TERMS_VERSION, TERMS_UPDATED } from './terms';
import qrcode from 'qrcode-generator';
import QRCode from 'react-native-qrcode-svg';
import { captureRef } from 'react-native-view-shot';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

/* =====================================================================
   UTILS
   ===================================================================== */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = (n, l = 2) => String(n).padStart(l, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => ymd(new Date());
const fmtD = (d) => (d ? d.split('-').reverse().join('-') : '');
const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const inr = (n, dec) => {
  const v = r2(n), neg = v < 0;
  const [i, f] = Math.abs(v).toFixed(2).split('.');
  const g = i.length > 3 ? i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + i.slice(-3) : i;
  return (neg ? '-' : '') + '₹' + g + (dec ? '.' + f : '');
};
const money = (n) => { const v = r2(n); return inr(v, v % 1 !== 0); };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// CSV: quote fields, and neutralise spreadsheet formulas (=, +, -, @) in text so Excel/Sheets never runs them
const csvQ = (v) => {
  v = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(v) && !/^[+-]?\d+(\.\d+)?$/.test(v)) v = "'" + v;
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};

/* ---- validation helpers ---- */
const UPI_RE = /^[\w.\-]{2,}@[A-Za-z][\w.\-]{1,}$/;
const upiOk = (cfg) => !!cfg && typeof cfg.upi === 'string' && cfg.upi.trim().length <= 100 && UPI_RE.test(cfg.upi.trim());
const safeAccent = (a) => (ACCENTS.includes(a) ? a : ACCENTS[0]);
const waLink = (phone, text) => {
  let ph = String(phone || '').replace(/\D/g, '');
  if (ph.length === 10) ph = '91' + ph;
  if (ph.length < 11 || ph.length > 15) return null;
  return 'https://wa.me/' + ph + '?text=' + encodeURIComponent(text);
};
const sendWa = (phone, text) => {
  const fb = () => { Share.share({ message: text }).catch(() => {}); };
  const u = waLink(phone, text);
  if (!u) { fb(); return; }
  Linking.openURL(u).catch(fb);
};

/* ---- PIN: stored hashed + salted in the device keystore (never in AsyncStorage, never in backups) ---- */
const PIN_KEY = 'inv_pin_v1';
const secGet = async () => {
  try { const v = await SecureStore.getItemAsync(PIN_KEY); return v ? JSON.parse(v) : null; } catch (e) { return { err: true }; }
};
const secSet = (o) => SecureStore.setItemAsync(PIN_KEY, JSON.stringify(o), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
const hashPin = (pin, salt) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, salt + ':' + pin);
const newSalt = () => Array.from(Crypto.getRandomBytes(16)).map((x) => x.toString(16).padStart(2, '0')).join('');
const sameStr = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let k = 0; k < a.length; k++) r |= a.charCodeAt(k) ^ b.charCodeAt(k); return r === 0; };
const savePin = async (pin) => { const salt = newSalt(); await secSet({ salt, hash: await hashPin(pin, salt), len: pin.length, fails: 0, until: 0 }); };
const removePin = async () => { try { await SecureStore.deleteItemAsync(PIN_KEY); } catch (e) { /* ignore */ } };
const weakPin = (p) => /^(\d)\1+$/.test(p) || '0123456789'.includes(p) || '9876543210'.includes(p);
// Verifies a PIN. After 5 wrong tries the app makes you wait 30s, doubling each time up to 15 minutes.
const checkPin = async (pin) => {
  const s = await secGet();
  if (!s || s.err) return { ok: false, err: true };
  const now = Date.now();
  if (s.until && s.until > now) return { ok: false, wait: Math.ceil((s.until - now) / 1000) };
  if (sameStr(await hashPin(pin, s.salt), s.hash)) { if (s.fails || s.until) await secSet({ ...s, fails: 0, until: 0 }); return { ok: true }; }
  const fails = (s.fails || 0) + 1;
  const wait = fails >= 5 ? Math.min(30 * Math.pow(2, fails - 5), 900) : 0;
  await secSet({ ...s, fails, until: wait ? now + wait * 1000 : 0 });
  return { ok: false, wait, left: wait ? 0 : 5 - fails };
};

/* ---- backup sanitiser: whitelist fields, force types, cap sizes. Nothing from a pasted backup is trusted. ---- */
const MAX_BACKUP = 5000000, MAX_ROWS = 10000;
const S = (v, n = 200) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, n) : '');
const N = (v) => { const x = +v; return Number.isFinite(x) ? Math.max(-1e12, Math.min(1e12, x)) : 0; };
const NSb = (v) => (v === '' || v == null ? '' : String(N(v)));
const D = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
const arr = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
const obj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const cleanCust = (x) => {
  if (!obj(x)) return null;
  const id = S(x.id, 40); if (!id) return null;
  return { id, name: S(x.name, 100), phone: S(x.phone, 20), addr: S(x.addr, 500), gstin: S(x.gstin, 15) };
};
const cleanProd = (x) => {
  if (!obj(x)) return null;
  const id = S(x.id, 40); if (!id) return null;
  return { id, name: S(x.name, 100), rate: NSb(x.rate), unit: S(x.unit, 20), hsn: S(x.hsn, 20), gst: NSb(x.gst), track: !!x.track, stock: NSb(x.stock), low: NSb(x.low) };
};
const cleanBill = (x) => {
  if (!obj(x)) return null;
  const id = S(x.id, 40); if (!id) return null;
  return {
    id, type: ['invoice', 'quote', 'cn'].includes(x.type) ? x.type : 'invoice', no: S(x.no, 40), dt: D(x.dt) || today(), due: D(x.due),
    cid: S(x.cid, 40), cust: S(x.cust, 100), cph: S(x.cph, 20), caddr: S(x.caddr, 500), cgstin: S(x.cgstin, 15), supply: S(x.supply, 40),
    items: arr(x.items, 200).filter(obj).map((it) => ({ n: S(it.n, 200), q: NSb(it.q), r: NSb(it.r), u: S(it.u, 20), hsn: S(it.hsn, 20), g: NSb(it.g), pid: S(it.pid, 40) })),
    dis: NSb(x.dis), disT: x.disT === '%' ? '%' : '₹', notes: S(x.notes, 1000),
    payments: arr(x.payments, 200).filter(obj).map((p) => ({ amt: N(p.amt), dt: D(p.dt) || today(), mode: MODES.includes(p.mode) ? p.mode : 'Cash' })),
    gst: !!x.gst, rnd: !!x.rnd, inter: !!x.inter,
  };
};
const CFG_TXT = { name: 100, phone: 20, addr: 500, gstin: 15, btype: 100, prefix: 10, email: 100, bankName: 100, bankAcc: 30, ifsc: 15, terms: 2000, sign: 60 };
const cleanCfg = (c) => {
  const o = {};
  if (!obj(c)) return o;
  Object.keys(CFG_TXT).forEach((k) => { if (k in c) o[k] = S(c[k], CFG_TXT[k]); });
  ['gstOn', 'round'].forEach((k) => { if (k in c) o[k] = !!c[k]; });
  if ('accent' in c) o.accent = safeAccent(c.accent);
  if ('defGst' in c) o.defGst = NSb(c.defGst);
  if (typeof c.upi === 'string' && c.upi.trim().length <= 100 && UPI_RE.test(c.upi.trim())) o.upi = c.upi.trim();
  return o; // 'pin' is never accepted from a backup
};
const parseBackup = (txt) => {
  try {
    if (typeof txt !== 'string' || txt.length > MAX_BACKUP) return null;
    let d = JSON.parse(txt);
    if (obj(d) && Array.isArray(d.hist)) { const m = migrateOld(obj(d.cfg) ? d.cfg : {}, d.hist); d = { cfg: m.cfg, bills: m.bills, custs: [], prods: [] }; }
    if (!obj(d) || !Array.isArray(d.bills)) return null;
    return {
      cfg: cleanCfg(d.cfg),
      bills: arr(d.bills, MAX_ROWS).map(cleanBill).filter(Boolean),
      custs: arr(d.custs, MAX_ROWS).map(cleanCust).filter(Boolean),
      prods: arr(d.prods, MAX_ROWS).map(cleanProd).filter(Boolean),
    };
  } catch (e) { return null; }
};
const qtyTxt = (l) => (+l.q || 0) + (l.u ? ' ' + l.u : '');

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const w2 = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''));
const w3 = (n) => (n >= 100 ? ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' : '') : '') + (n % 100 ? w2(n % 100) : '');
const words = (n) => {
  if (n === 0) return 'Zero';
  const out = [];
  [[1e7, 'Crore'], [1e5, 'Lakh'], [1e3, 'Thousand']].forEach(([d, nm]) => {
    const q = Math.floor(n / d);
    if (q) out.push(w3(q) + ' ' + nm);
    n %= d;
  });
  if (n) out.push(w3(n));
  return out.join(' ');
};
const rupeesWords = (amt) => {
  const a = Math.abs(r2(amt)), r = Math.floor(a), p = Math.round((a - r) * 100);
  return words(r) + ' Rupees' + (p ? ' and ' + words(p) + ' Paise' : '') + ' Only';
};

const mix = (a, b, t) => {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const x = p(a), y = p(b);
  return '#' + x.map((v, i) => pad(Math.round(v + (y[i] - v) * t).toString(16))).join('');
};
const ACCENTS = ['#0f4c3a', '#1d4ed8', '#8b1d2c', '#6d28d9', '#111827'];
const palette = (dark, acc) => dark
  ? { bg: '#0e1512', paper: '#17211c', ink: '#e9f0ec', mute: '#9db0a6', line: '#2c3f35', g: mix(acc, '#ffffff', 0.55), btn: mix(acc, '#ffffff', 0.55), btnt: '#0d1511', red: '#ff8d78', y: '#e8a317', ok: '#5fd0a5' }
  : { bg: '#f3f4f1', paper: '#ffffff', ink: '#17211c', mute: '#5e6b65', line: '#dde2de', g: acc, btn: acc, btnt: '#ffffff', red: '#b3341f', y: '#e8a317', ok: '#1b7f4b' };

const GST_RATES = ['0', '0.25', '3', '5', '12', '18', '28'];
const UNITS = ['', 'pcs', 'kg', 'g', 'L', 'ml', 'plate', 'dozen', 'pkt', 'box', 'hr', 'day', 'mtr', 'sq.ft'];
const MODES = ['Cash', 'UPI', 'Card', 'Bank', 'Cheque'];
const TYPE_NAME = { invoice: 'Invoice', quote: 'Quotation', cn: 'Credit Note' };

/* ---- bill math ---- */
const interOf = (b, cfg) => {
  if (b.supply === 'inter') return true;
  if (b.supply === 'intra') return false;
  return !!(cfg.gstin && b.cgstin && cfg.gstin.slice(0, 2) !== b.cgstin.slice(0, 2));
};
const calc = (b) => {
  const lines = (b.items || []).map((l) => ({ ...l, amt: (+l.q || 0) * (+l.r || 0) }));
  const sub = lines.reduce((s, l) => s + l.amt, 0);
  const dv = +b.dis || 0;
  const disc = b.disT === '%' ? (sub * Math.min(dv, 100)) / 100 : Math.min(dv, sub);
  const f = sub > 0 ? (sub - disc) / sub : 0;
  let taxable = 0, tax = 0;
  const slabs = {};
  lines.forEach((l) => {
    l.tv = l.amt * f;
    l.gr = b.gst ? +l.g || 0 : 0;
    l.tx = (l.tv * l.gr) / 100;
    taxable += l.tv; tax += l.tx;
    if (b.gst) { const s = (slabs[l.gr] = slabs[l.gr] || { tv: 0, tx: 0 }); s.tv += l.tv; s.tx += l.tx; }
  });
  const raw = taxable + tax;
  const total = b.rnd ? Math.round(raw) : r2(raw);
  const inter = !!b.inter;
  return { lines, sub, disc, taxable, tax, cgst: inter ? 0 : tax / 2, sgst: inter ? 0 : tax / 2, igst: inter ? tax : 0, raw, ro: total - raw, total, inter, slabs };
};
const info = (b) => {
  const c = calc(b);
  const paid = (b.payments || []).reduce((s, p) => s + (+p.amt || 0), 0);
  let bal = 0, status = 'Quote';
  if (b.type === 'invoice') {
    bal = Math.max(0, r2(c.total - paid));
    status = bal <= 0.005 ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid';
  } else if (b.type === 'cn') status = 'Credit';
  const overdue = b.type === 'invoice' && bal > 0.005 && !!b.due && b.due < today();
  return { c, total: c.total, paid, bal, status, overdue };
};
const nextNo = (bills, type, cfg) => {
  const prefix = type === 'invoice' ? cfg.prefix || 'INV-' : type === 'quote' ? 'QT-' : 'CN-';
  const max = bills.filter((b) => b.type === type).reduce((m, b) => { const x = /(\d+)$/.exec(b.no || ''); return Math.max(m, x ? parseInt(x[1], 10) : 0); }, 0);
  return prefix + pad(max + 1, 3);
};
const stockApply = (prods, b, mult) => {
  if (b.type === 'quote') return prods;
  const sign = (b.type === 'cn' ? 1 : -1) * mult;
  return prods.map((p) => {
    if (!p.track) return p;
    const q = (b.items || []).filter((it) => it.pid === p.id).reduce((s, it) => s + (+it.q || 0), 0);
    return q ? { ...p, stock: String(r2((+p.stock || 0) + sign * q)) } : p;
  });
};

/* ---- migration from the old single-page app ---- */
const migrateOld = (oc = {}, oh = []) => {
  const cfg = { name: oc.sname || '', phone: oc.sph || '', addr: oc.sad || '', gstin: oc.sgst || '', gstOn: !!oc.sgst, upi: oc.supi || '', btype: oc.scus || '', prefix: 'INV-', accent: ACCENTS[0], defGst: '18', round: true };
  const bills = (oh || []).filter((b) => b && b.no && Array.isArray(b.items)).map((b) => {
    const items = b.items.map((it) => ({ n: it[0], q: String(it[1]), r: String(it[2]), u: it[3] || '', hsn: '', g: cfg.gstOn ? String(+b.gst || 0) : '0', pid: '' }));
    const tmp = { type: 'invoice', items, dis: String(b.dis || 0), disT: '₹', gst: cfg.gstOn, rnd: false, inter: false };
    const total = calc(tmp).total;
    return { id: uid(), type: 'invoice', no: 'INV-' + String(b.no).padStart(3, '0'), dt: b.dt || today(), due: '', cid: '', cust: b.cust || '', cph: b.cph || '', caddr: '', cgstin: '', supply: '', items, dis: String(b.dis || 0), disT: '₹', notes: b.edt ? 'Table ' + b.edt : '', payments: [{ amt: total, dt: b.dt || today(), mode: b.gu || 'Cash' }], gst: cfg.gstOn, rnd: false, inter: false };
  });
  return { cfg, bills };
};

/* ---- documents ---- */
const docTitle = (b) => (b.type === 'quote' ? 'QUOTATION' : b.type === 'cn' ? 'CREDIT NOTE' : b.gst ? 'TAX INVOICE' : 'INVOICE');
const upiLink = (cfg, b, amt) => {
  const pa = String(cfg.upi || '').trim(), a = +amt;
  if (!UPI_RE.test(pa) || pa.length > 100 || !Number.isFinite(a) || a <= 0) return '';
  return 'upi://pay?pa=' + encodeURIComponent(pa).replace(/%40/g, '@') + '&pn=' + encodeURIComponent((cfg.name || 'Shop').slice(0, 25)) + '&am=' + a.toFixed(2) + '&cu=INR';
};

const billText = (b, cfg) => {
  const i = info(b), c = i.c, L = [];
  L.push('*' + (cfg.name || 'Shop') + '*');
  if (cfg.addr) L.push(cfg.addr);
  if (cfg.phone) L.push('Ph: ' + cfg.phone);
  if (b.gst && cfg.gstin) L.push('GSTIN: ' + cfg.gstin);
  L.push('------------------------', docTitle(b) + ' ' + b.no + '  |  ' + fmtD(b.dt));
  if (b.cust) L.push('Customer: ' + b.cust);
  L.push('------------------------');
  c.lines.filter((l) => l.n).forEach((l, k) => L.push(k + 1 + '. ' + l.n + '\n    ' + qtyTxt(l) + ' x ' + money(+l.r || 0) + (b.gst ? ' (GST ' + l.gr + '%)' : '') + ' = ' + money(l.amt)));
  L.push('------------------------', 'Subtotal: ' + money(c.sub));
  if (c.disc > 0) L.push('Discount: -' + money(c.disc));
  if (b.gst) { if (c.inter) L.push('IGST: ' + money(c.igst)); else L.push('CGST: ' + money(c.cgst), 'SGST: ' + money(c.sgst)); }
  if (Math.abs(c.ro) > 0.004) L.push('Round off: ' + money(c.ro));
  L.push('*TOTAL: ' + money(c.total) + '*');
  if (b.type === 'invoice') { if (i.paid > 0) L.push('Paid: ' + money(i.paid)); if (i.bal > 0) L.push('*Balance due: ' + money(i.bal) + '*'); }
  if (cfg.upi && i.bal > 0) L.push('UPI: ' + cfg.upi);
  L.push('', 'Thank you! Visit again.');
  return L.join('\n');
};
const reminderText = (name, no, bal, cfg) =>
  'Hello ' + (name || '') + ',\n' + (cfg.name || 'Shop') + ' is sending a friendly reminder that ' + (no ? 'bill ' + no + ' has ' : '') + money(bal) + ' pending. Please make the payment soon.' + (cfg.upi ? '\nUPI: ' + cfg.upi : '') + '\nThank you 🙏';

const billHtml = (b, cfg) => {
  const acc = safeAccent(cfg.accent);
  const i = info(b), c = i.c, g = b.gst;
  const rows = c.lines.filter((l) => l.n).map((l, k) =>
    '<tr><td>' + (k + 1) + '</td><td>' + esc(l.n) + (g && l.hsn ? '<div class="s">HSN: ' + esc(l.hsn) + '</div>' : '') + '</td><td class="r">' + esc(qtyTxt(l)) + '</td><td class="r">' + inr(+l.r || 0, 1) + '</td>' + (g ? '<td class="r">' + l.gr + '%</td>' : '') + '<td class="r">' + inr(l.amt, 1) + '</td></tr>').join('');
  const slabRows = Object.keys(c.slabs).map((k) => {
    const s = c.slabs[k];
    return '<tr><td>' + k + '%</td><td class="r">' + inr(s.tv, 1) + '</td>' + (c.inter ? '<td class="r">' + inr(s.tx, 1) + '</td>' : '<td class="r">' + inr(s.tx / 2, 1) + '</td><td class="r">' + inr(s.tx / 2, 1) + '</td>') + '</tr>';
  }).join('');
  let qr = '';
  if (upiOk(cfg) && i.bal > 0) {
    try { const q = qrcode(0, 'M'); q.addData(upiLink(cfg, b, i.bal)); q.make(); qr = '<div class="qr">' + q.createSvgTag(4, 16) + '<div class="s">Scan to pay ' + inr(i.bal, 1) + '</div></div>'; } catch (e) { qr = ''; }
  }
  const tr = (l, v, cls) => '<div class="t ' + (cls || '') + '"><span>' + l + '</span><span>' + v + '</span></div>';
  const head = [cfg.btype, cfg.addr, cfg.phone && 'Ph: ' + cfg.phone, cfg.email, g && cfg.gstin && 'GSTIN: ' + cfg.gstin].filter(Boolean).map(esc).join('<br>');
  const bank = [cfg.bankName && 'Bank: ' + cfg.bankName, cfg.bankAcc && 'A/c No: ' + cfg.bankAcc, cfg.ifsc && 'IFSC: ' + cfg.ifsc, cfg.upi && 'UPI: ' + cfg.upi].filter(Boolean).map(esc).join('<br>');
  return '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:"><meta name="viewport" content="width=device-width"><style>' +
    '*{box-sizing:border-box}body{font-family:Helvetica,Arial,sans-serif;color:#17211c;font-size:12px;margin:0;padding:24px}' +
    '.top{border-top:8px solid ' + acc + ';padding-top:14px;display:flex;justify-content:space-between;align-items:flex-start}' +
    'h1{margin:0;font-size:22px;color:' + acc + '}.doc{font-size:18px;font-weight:bold;color:' + acc + ';text-align:right}.s{font-size:10px;color:#5e6b65}' +
    '.meta{margin:12px 0;display:flex;justify-content:space-between;gap:16px}.box{flex:1;border:1px solid #dde2de;border-radius:6px;padding:8px 10px}' +
    '.lb{font-size:10px;color:#5e6b65;text-transform:uppercase;margin-bottom:3px}' +
    'table{width:100%;border-collapse:collapse;margin-top:6px}th{background:' + acc + ';color:#fff;text-align:left;padding:6px 5px;font-size:11px}' +
    'td{padding:6px 5px;border-bottom:1px solid #e6eae7;vertical-align:top}.r{text-align:right}' +
    '.tot{width:48%;margin-left:auto;margin-top:10px}.t{display:flex;justify-content:space-between;padding:3px 0}' +
    '.g{font-weight:bold;font-size:15px;color:' + acc + ';border-top:2px solid ' + acc + ';margin-top:4px;padding-top:6px}' +
    '.words{margin-top:10px;padding:8px 10px;background:#f3f4f1;border-radius:6px;font-style:italic}' +
    '.bottom{display:flex;justify-content:space-between;gap:16px;margin-top:14px}.qr{text-align:center}.qr{background:#fff;padding:4px}.qr svg{width:130px;height:130px}' +
    '.sign{text-align:right;margin-top:40px}.paid{display:inline-block;border:2px solid #1b7f4b;color:#1b7f4b;padding:2px 10px;font-weight:bold;border-radius:4px}' +
    '</style></head><body>' +
    '<div class="top"><div><h1>' + esc(cfg.name || 'Shop') + '</h1><div class="s">' + head + '</div></div><div><div class="doc">' + docTitle(b) + '</div>' +
    (i.status === 'Paid' ? '<div style="text-align:right;margin-top:6px"><span class="paid">PAID</span></div>' : '') + '</div></div>' +
    '<div class="meta"><div class="box"><div class="lb">Billed to</div><b>' + esc(b.cust || 'Walk-in customer') + '</b><br>' + [b.cph && 'Ph: ' + b.cph, b.caddr, g && b.cgstin && 'GSTIN: ' + b.cgstin].filter(Boolean).map(esc).join('<br>') + '</div>' +
    '<div class="box"><div class="lb">Details</div>No: <b>' + esc(b.no) + '</b><br>Date: ' + esc(fmtD(b.dt)) + (b.due ? '<br>Due: ' + esc(fmtD(b.due)) : '') + (g ? '<br>Supply: ' + (c.inter ? 'Inter-state' : 'Intra-state') : '') + '</div></div>' +
    '<table><tr><th>#</th><th>Item</th><th class="r">Qty</th><th class="r">Rate</th>' + (g ? '<th class="r">GST</th>' : '') + '<th class="r">Amount</th></tr>' + rows + '</table>' +
    '<div class="tot">' + tr('Subtotal', inr(c.sub, 1)) + (c.disc > 0 ? tr('Discount', '-' + inr(c.disc, 1)) : '') +
    (g ? tr('Taxable value', inr(c.taxable, 1)) + (c.inter ? tr('IGST', inr(c.igst, 1)) : tr('CGST', inr(c.cgst, 1)) + tr('SGST', inr(c.sgst, 1))) : '') +
    (Math.abs(c.ro) > 0.004 ? tr('Round off', inr(c.ro, 1)) : '') + tr('Total', inr(c.total, 1), 'g') +
    (b.type === 'invoice' && i.paid > 0 ? tr('Paid', inr(i.paid, 1)) : '') + (b.type === 'invoice' && i.bal > 0 ? tr('<b>Balance due</b>', '<b>' + inr(i.bal, 1) + '</b>') : '') + '</div>' +
    '<div class="words"><b>Amount in words:</b> ' + rupeesWords(c.total) + '</div>' +
    (g && slabRows ? '<table style="width:60%"><tr><th>GST %</th><th class="r">Taxable</th>' + (c.inter ? '<th class="r">IGST</th>' : '<th class="r">CGST</th><th class="r">SGST</th>') + '</tr>' + slabRows + '</table>' : '') +
    '<div class="bottom"><div style="flex:1">' + (bank ? '<div class="lb">Payment details</div><div>' + bank + '</div>' : '') + (b.notes ? '<div class="lb" style="margin-top:8px">Notes</div><div>' + esc(b.notes) + '</div>' : '') + (cfg.terms ? '<div class="lb" style="margin-top:8px">Terms &amp; conditions</div><div class="s">' + esc(cfg.terms).replace(/\n/g, '<br>') + '</div>' : '') + '</div>' + qr + '</div>' +
    '<div class="sign">For <b>' + esc(cfg.name || 'Shop') + '</b><br><br><br>' + esc(cfg.sign || 'Authorised Signatory') + '</div>' +
    '<p class="s" style="text-align:center;margin-top:18px">Thank you for your business!</p></body></html>';
};

/* =====================================================================
   CONTEXT + SMALL UI
   ===================================================================== */
const Ctx = React.createContext(null);
const useX = () => useContext(Ctx);

function Row({ children, style }) { return <View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 }, style]}>{children}</View>; }
function Field({ label, style, ...p }) {
  const { C } = useX();
  return (
    <View style={[{ flex: 1, minWidth: 130 }, style]}>
      {!!label && <Text style={{ fontSize: 12, color: C.mute, marginBottom: 3 }}>{label}</Text>}
      <TextInput placeholderTextColor={C.mute} {...p}
        style={{ color: C.ink, fontSize: 15, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: C.paper, ...(p.multiline ? { minHeight: 70, textAlignVertical: 'top' } : {}) }} />
    </View>
  );
}
function Btn({ t, on, s, danger, style }) {
  const { C } = useX();
  const col = danger ? C.red : C.g;
  return (
    <TouchableOpacity onPress={on} activeOpacity={0.8}
      style={[{ flex: 1, minWidth: 100, padding: 12, borderRadius: 8, alignItems: 'center', backgroundColor: s || danger ? 'transparent' : C.btn, borderWidth: s || danger ? 1 : 0, borderColor: col }, style]}>
      <Text style={{ fontWeight: '600', color: s || danger ? (danger ? C.red : C.ink) : C.btnt }}>{t}</Text>
    </TouchableOpacity>
  );
}
function Card({ title, right, children, style }) {
  const { C } = useX();
  return (
    <View style={[{ backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 14, marginBottom: 12 }, style]}>
      {(!!title || !!right) && (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <Text style={{ color: C.g, fontWeight: '700', fontSize: 15 }}>{title}</Text>{right}
        </View>
      )}
      {children}
    </View>
  );
}
function Pill({ t, color }) {
  return <Text style={{ backgroundColor: color + '22', color, fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, overflow: 'hidden' }}>{t}</Text>;
}
function StatusPill({ i }) {
  const { C } = useX();
  const col = i.status === 'Paid' ? C.ok : i.status === 'Partial' ? C.y : i.status === 'Unpaid' ? C.red : C.mute;
  return <View style={{ flexDirection: 'row', gap: 4 }}><Pill t={i.status} color={col} />{i.overdue && <Pill t="Overdue" color={C.red} />}</View>;
}
function Chips({ value, options, onChange }) {
  const { C } = useX();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8, flexGrow: 0 }}>
      {options.map(([v, l]) => (
        <TouchableOpacity key={v} onPress={() => onChange(v)}
          style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, marginRight: 6, borderWidth: 1, borderColor: value === v ? C.btn : C.line, backgroundColor: value === v ? C.btn : C.paper }}>
          <Text style={{ color: value === v ? C.btnt : C.ink, fontSize: 13 }}>{l}</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}
function Sheet({ visible, onClose, title, children, footer }) {
  const { C, ins } = useX();
  const [kbH, setKbH] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const a = Keyboard.addListener('keyboardDidShow', (e) => setKbH((e && e.endCoordinates && e.endCoordinates.height) || 0));
    const b = Keyboard.addListener('keyboardDidHide', () => setKbH(0));
    return () => { a.remove(); b.remove(); };
  }, []);
  const winH = Dimensions.get('window').height;
  const maxH = kbH ? Math.max(220, winH - kbH - ins.top - 24) : winH * 0.88;
  const bottomInset = kbH ? 0 : ins.bottom;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#0009', justifyContent: 'flex-end', paddingBottom: kbH }}>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose} />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={{ backgroundColor: C.bg, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: maxH }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, paddingBottom: 6 }}>
              <Text style={{ color: C.ink, fontWeight: '700', fontSize: 17, flex: 1 }} numberOfLines={1}>{title}</Text>
              <TouchableOpacity onPress={onClose}><Text style={{ color: C.mute, fontSize: 24, paddingHorizontal: 6 }}>×</Text></TouchableOpacity>
            </View>
            <ScrollView style={{ paddingHorizontal: 14 }} contentContainerStyle={{ paddingBottom: 14 + (footer ? 0 : bottomInset) }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
            {!!footer && <View style={{ padding: 12, paddingTop: 8, paddingBottom: 12 + bottomInset, borderTopWidth: 1, borderColor: C.line, backgroundColor: C.paper }}>{footer}</View>}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
function Select({ label, value, options, onChange, style, width }) {
  const { C } = useX();
  const [open, setOpen] = useState(false);
  const shown = options.find((o) => o.v === value);
  return (
    <View style={[width ? { width } : { flex: 1, minWidth: 130 }, style]}>
      {!!label && <Text style={{ fontSize: 12, color: C.mute, marginBottom: 3 }}>{label}</Text>}
      <TouchableOpacity onPress={() => setOpen(true)} style={{ borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 10, backgroundColor: C.paper }}>
        <Text style={{ color: C.ink, fontSize: 15 }} numberOfLines={1}>{(shown ? shown.l : '—') + '  ▾'}</Text>
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity activeOpacity={1} onPress={() => setOpen(false)} style={{ flex: 1, backgroundColor: '#0008', justifyContent: 'center', padding: 24 }}>
          <View style={{ backgroundColor: C.paper, borderRadius: 12, maxHeight: '75%' }}>
            <ScrollView>
              {options.map((o) => (
                <TouchableOpacity key={String(o.v)} onPress={() => { onChange(o.v); setOpen(false); }}
                  style={{ padding: 14, borderBottomWidth: 1, borderColor: C.line, backgroundColor: o.v === value ? C.line : 'transparent' }}>
                  <Text style={{ color: C.ink, fontSize: 16 }}>{o.l}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}
function DateField({ label, value, onChange, style, clearable }) {
  const { C } = useX();
  if (Platform.OS !== 'android') return <Field label={label} style={style} value={value} onChangeText={onChange} placeholder="YYYY-MM-DD" />;
  const open = () => {
    const v = value && !isNaN(new Date(value)) ? new Date(value) : new Date();
    DateTimePickerAndroid.open({ value: v, mode: 'date', onChange: (e, d) => { if (e.type === 'set' && d) onChange(ymd(d)); } });
  };
  return (
    <View style={[{ flex: 1, minWidth: 130 }, style]}>
      {!!label && <Text style={{ fontSize: 12, color: C.mute, marginBottom: 3 }}>{label}</Text>}
      <TouchableOpacity onPress={open} style={{ borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 10, backgroundColor: C.paper, flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: value ? C.ink : C.mute, fontSize: 15 }}>{value ? fmtD(value) : 'Select date'}</Text>
        {clearable && !!value && <TouchableOpacity onPress={() => onChange('')}><Text style={{ color: C.mute }}>✕</Text></TouchableOpacity>}
      </TouchableOpacity>
    </View>
  );
}
const Empty = ({ t }) => { const { C } = useX(); return <Text style={{ textAlign: 'center', color: C.mute, paddingVertical: 36 }}>{t}</Text>; };
const Search = ({ value, onChange, ph }) => <Row style={{ marginBottom: 8 }}><Field value={value} onChangeText={onChange} placeholder={ph || 'Search...'} /></Row>;

/* =====================================================================
   PROFILE FORM (used for first-run setup and later edits)
   ===================================================================== */
function ProfileForm({ first, onDone }) {
  const { C, cfg, setCfg, flash } = useX();
  const [d, setD] = useState({ prefix: 'INV-', accent: ACCENTS[0], defGst: '18', round: true, ...cfg });
  const [err, setErr] = useState('');
  const set = (k, v) => setD((x) => ({ ...x, [k]: v }));
  const save = () => {
    if (!(d.name || '').trim()) { setErr('Shop / business name is required.'); return; }
    const gstin = (d.gstin || '').trim().toUpperCase();
    if (d.gstOn && gstin.length !== 15) { setErr('If GST is on, please enter a valid 15-character GSTIN.'); return; }
    const upi = (d.upi || '').trim();
    if (upi && !/^[\w.\-]{2,}@[A-Za-z][\w.\-]{1,}$/.test(upi)) { setErr('Enter the UPI ID in the correct format, like name@upi (no spaces).'); return; }
    setCfg({ ...d, name: d.name.trim(), upi, gstin: d.gstOn ? gstin : '' });
    setErr('');
    flash(first ? 'Profile created ✓' : 'Profile saved ✓');
    onDone && onDone();
  };
  return (
    <View>
      {first && (
        <View style={{ marginVertical: 18 }}>
          <Text style={{ color: C.g, fontSize: 26, fontWeight: '700' }}>Welcome 👋</Text>
          <Text style={{ color: C.mute, marginTop: 4 }}>Enter your shop details once. You can edit them later from Profile.</Text>
        </View>
      )}
      <Card title="Business">
        <Row><Field label="Business name *" value={d.name || ''} onChangeText={(v) => set('name', v)} placeholder="e.g. Sharma Traders" /></Row>
        <Row><Field label="Business type (optional)" value={d.btype || ''} onChangeText={(v) => set('btype', v)} placeholder="e.g. Grocery, Salon, Repair" /></Row>
        <Row>
          <Field label="Phone" keyboardType="phone-pad" value={d.phone || ''} onChangeText={(v) => set('phone', v)} />
          <Field label="Email" autoCapitalize="none" keyboardType="email-address" value={d.email || ''} onChangeText={(v) => set('email', v)} />
        </Row>
        <Row><Field label="Address" value={d.addr || ''} onChangeText={(v) => set('addr', v)} multiline /></Row>
      </Card>
      <Card title="GST">
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: d.gstOn ? 10 : 0 }}>
          <View style={{ flex: 1, paddingRight: 10 }}>
            <Text style={{ color: C.ink, fontWeight: '600' }}>GST registered?</Text>
            <Text style={{ color: C.mute, fontSize: 12 }}>If off, GST will not be shown on bills.</Text>
          </View>
          <Switch value={!!d.gstOn} onValueChange={(v) => set('gstOn', v)} trackColor={{ true: C.btn }} />
        </View>
        {!!d.gstOn && (
          <View>
            <Row><Field label="GSTIN *" autoCapitalize="characters" maxLength={15} value={d.gstin || ''} onChangeText={(v) => set('gstin', v)} placeholder="22AAAAA0000A1Z5" /></Row>
            <Row><Select label="Default GST % for new items" value={String(d.defGst || '18')} options={GST_RATES.map((x) => ({ v: x, l: x + '%' }))} onChange={(v) => set('defGst', v)} /></Row>
          </View>
        )}
      </Card>
      <Card title="Payment details (shown on bills)">
        <Row><Field label="UPI ID (for QR code)" autoCapitalize="none" value={d.upi || ''} onChangeText={(v) => set('upi', v)} placeholder="name@upi" /></Row>
        <Row><Field label="Bank name" value={d.bankName || ''} onChangeText={(v) => set('bankName', v)} /></Row>
        <Row>
          <Field label="Account number" keyboardType="number-pad" value={d.bankAcc || ''} onChangeText={(v) => set('bankAcc', v)} />
          <Field label="IFSC" autoCapitalize="characters" value={d.ifsc || ''} onChangeText={(v) => set('ifsc', v)} />
        </Row>
      </Card>
      <Card title="Invoice settings">
        <Row>
          <Field label="Invoice prefix" autoCapitalize="characters" value={d.prefix || ''} onChangeText={(v) => set('prefix', v)} placeholder="INV-" />
          <Field label="Signatory name" value={d.sign || ''} onChangeText={(v) => set('sign', v)} placeholder="Authorised Signatory" />
        </Row>
        <Row><Field label="Terms & conditions" multiline value={d.terms || ''} onChangeText={(v) => set('terms', v)} placeholder="e.g. Goods once sold will not be taken back." /></Row>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <Text style={{ color: C.ink }}>Round off the total</Text>
          <Switch value={!!d.round} onValueChange={(v) => set('round', v)} trackColor={{ true: C.btn }} />
        </View>
        <Text style={{ fontSize: 12, color: C.mute, marginBottom: 6 }}>Bill colour</Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          {ACCENTS.map((a) => (
            <TouchableOpacity key={a} onPress={() => set('accent', a)}
              style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: a, borderWidth: 3, borderColor: d.accent === a ? C.ink : 'transparent' }} />
          ))}
        </View>
      </Card>
      {!!err && <Text style={{ color: C.red, textAlign: 'center', marginBottom: 8 }}>{err}</Text>}
      <Row><Btn t={first ? 'Save & start billing' : 'Save changes'} on={save} /></Row>
    </View>
  );
}

/* Clean bill used for the photo that goes to WhatsApp (always light colours) */
function SnapBill({ b }) {
  const { cfg } = useX();
  const acc = safeAccent(cfg.accent);
  const ink = '#17211c', mute = '#5e6b65', line = '#dde2de';
  const i = info(b), c = i.c, g = b.gst;
  const rows = c.lines.filter((l) => l.n);
  const qr = upiOk(cfg) && i.bal > 0.005 ? upiLink(cfg, b, i.bal) : '';
  const head = [cfg.btype, cfg.addr, cfg.phone && 'Ph: ' + cfg.phone, g && cfg.gstin && 'GSTIN: ' + cfg.gstin].filter(Boolean).join(' | ');
  const bank = [cfg.bankName && 'Bank: ' + cfg.bankName, cfg.bankAcc && 'A/c: ' + cfg.bankAcc, cfg.ifsc && 'IFSC: ' + cfg.ifsc].filter(Boolean).join('\n');
  const T = ({ a, v, big, col }) => (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2, ...(big ? { borderTopWidth: 2, borderColor: acc, marginTop: 4, paddingTop: 6 } : {}) }}>
      <Text style={{ color: big ? acc : col || ink, fontWeight: big ? '700' : '400', fontSize: big ? 18 : 13 }}>{a}</Text>
      <Text style={{ color: big ? acc : col || ink, fontWeight: big ? '700' : '400', fontSize: big ? 18 : 13 }}>{v}</Text>
    </View>
  );
  return (
    <View style={{ width: 400, backgroundColor: '#fff', borderTopWidth: 8, borderColor: acc, padding: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', borderBottomWidth: 3, borderColor: acc, paddingBottom: 10, marginBottom: 10 }}>
        <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: acc, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 22, fontWeight: '700' }}>{((cfg.name || 'S')[0] || 'S').toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1, marginHorizontal: 10 }}>
          <Text style={{ color: acc, fontSize: 19, fontWeight: '700' }}>{cfg.name}</Text>
          <Text style={{ color: mute, fontSize: 10 }}>{head}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ color: acc, fontWeight: '700', fontSize: 12 }}>{docTitle(b)}</Text>
          <Text style={{ color: '#b3341f', fontWeight: '700' }}>{b.no}</Text>
        </View>
      </View>
      <Text style={{ color: ink, fontSize: 13 }}>
        <Text style={{ fontWeight: '700' }}>{b.cust || 'Walk-in customer'}</Text>
        {b.cph ? '\nPh: ' + b.cph : ''}{b.caddr ? '\n' + b.caddr : ''}{g && b.cgstin ? '\nGSTIN: ' + b.cgstin : ''}
        {'\n'}Date: {fmtD(b.dt)}{b.due ? '   Due: ' + fmtD(b.due) : ''}
      </Text>
      <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: acc, marginTop: 10, paddingBottom: 3 }}>
        <Text style={{ flex: 2.4, color: mute, fontSize: 10, fontWeight: '700' }}>ITEM</Text>
        <Text style={{ flex: 1, textAlign: 'right', color: mute, fontSize: 10, fontWeight: '700' }}>QTY</Text>
        <Text style={{ flex: 1.2, textAlign: 'right', color: mute, fontSize: 10, fontWeight: '700' }}>RATE</Text>
        {g && <Text style={{ flex: 0.9, textAlign: 'right', color: mute, fontSize: 10, fontWeight: '700' }}>GST</Text>}
        <Text style={{ flex: 1.3, textAlign: 'right', color: mute, fontSize: 10, fontWeight: '700' }}>AMOUNT</Text>
      </View>
      {rows.map((l, k) => (
        <View key={k} style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: line, paddingVertical: 5 }}>
          <View style={{ flex: 2.4 }}>
            <Text style={{ color: ink, fontSize: 13 }}>{l.n}</Text>
            {g && !!l.hsn && <Text style={{ color: mute, fontSize: 9 }}>HSN {l.hsn}</Text>}
          </View>
          <Text style={{ flex: 1, textAlign: 'right', color: ink, fontSize: 12 }}>{qtyTxt(l)}</Text>
          <Text style={{ flex: 1.2, textAlign: 'right', color: ink, fontSize: 12 }}>{money(+l.r || 0)}</Text>
          {g && <Text style={{ flex: 0.9, textAlign: 'right', color: ink, fontSize: 12 }}>{l.gr}%</Text>}
          <Text style={{ flex: 1.3, textAlign: 'right', color: ink, fontSize: 12 }}>{money(l.amt)}</Text>
        </View>
      ))}
      <View style={{ marginTop: 10, width: '62%', alignSelf: 'flex-end' }}>
        <T a="Subtotal" v={money(c.sub)} />
        {c.disc > 0 && <T a="Discount" v={'-' + money(c.disc)} />}
        {g && <T a="Taxable value" v={money(c.taxable)} />}
        {g && (c.inter ? <T a="IGST" v={money(c.igst)} /> : <View><T a="CGST" v={money(c.cgst)} /><T a="SGST" v={money(c.sgst)} /></View>)}
        {Math.abs(c.ro) > 0.004 && <T a="Round off" v={r2(c.ro)} />}
        <T big a="Total" v={money(c.total)} />
        {b.type === 'invoice' && i.paid > 0 && <T a="Paid" v={money(i.paid)} col="#1b7f4b" />}
        {b.type === 'invoice' && i.bal > 0.005 && <T a="Balance due" v={money(i.bal)} col="#b3341f" />}
      </View>
      <Text style={{ color: mute, fontSize: 11, fontStyle: 'italic', marginTop: 8 }}>{rupeesWords(c.total)}</Text>
      {!!qr && (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 14 }}>
          <View style={{ backgroundColor: '#fff', padding: 4 }}>
            <QRCode value={qr} size={150} quietZone={10} backgroundColor="#ffffff" color="#000000" ecl="M" />
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ color: ink, fontWeight: '700', fontSize: 14 }}>Scan to pay {money(i.bal)}</Text>
            <Text style={{ color: mute, fontSize: 11, marginTop: 2 }}>UPI: {cfg.upi}</Text>
            {!!bank && <Text style={{ color: mute, fontSize: 10, marginTop: 6 }}>{bank}</Text>}
          </View>
        </View>
      )}
      {!qr && !!bank && <Text style={{ color: mute, fontSize: 10, marginTop: 10 }}>{bank}</Text>}
      {!!b.notes && <Text style={{ color: mute, fontSize: 10, marginTop: 8 }}>Note: {b.notes}</Text>}
      {!!cfg.terms && <Text style={{ color: mute, fontSize: 9, marginTop: 8, borderTopWidth: 1, borderColor: line, paddingTop: 6 }}>{cfg.terms}</Text>}
      <Text style={{ color: mute, fontSize: 11, textAlign: 'center', marginTop: 10 }}>Thank you for your business!</Text>
    </View>
  );
}

/* =====================================================================
   BILL EDITOR
   ===================================================================== */
function Editor({ draft, onClose }) {
  const { C, cfg, bills, prods, custs, saveBill, sharePdf, shareImage, flash, ins } = useX();
  const [d, setD] = useState(draft);
  const [pickP, setPickP] = useState(false);
  const [selP, setSelP] = useState([]);
  const [pickC, setPickC] = useState(false);
  const [q, setQ] = useState('');
  const [kb, setKb] = useState(false);
  useEffect(() => {
    const a = Keyboard.addListener('keyboardDidShow', () => setKb(true));
    const b = Keyboard.addListener('keyboardDidHide', () => setKb(false));
    return () => { a.remove(); b.remove(); };
  }, []);
  const set = (k, v) => setD((x) => ({ ...x, [k]: v }));
  const g = d.gst;
  const bill = { ...d, inter: g && interOf(d, cfg) };
  const i = info(bill), c = i.c;
  const recv = +d.recv || 0;
  const updItem = (k, key, v) => setD((x) => ({ ...x, items: x.items.map((it, j) => (j === k ? { ...it, [key]: v } : it)) }));
  const blankItem = () => ({ n: '', q: '1', r: '', u: '', hsn: '', g: String(cfg.defGst || '0'), pid: '' });
  const closePick = () => { setPickP(false); setSelP([]); setQ(''); };
  const togP = (id) => setSelP((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
  const addProds = () => {
    const chosen = prods.filter((p) => selP.includes(p.id));
    if (!chosen.length) return;
    setD((x) => ({ ...x, items: [...x.items.filter((it) => it.n || +it.r), ...chosen.map((p) => ({ n: p.name, q: '1', r: String(p.rate || ''), u: p.unit || '', hsn: p.hsn || '', g: String(p.gst ?? cfg.defGst ?? '0'), pid: p.id }))] }));
    closePick();
  };
  const pickCust = (cu) => { setD((x) => ({ ...x, cid: cu.id, cust: cu.name, cph: cu.phone || '', caddr: cu.addr || '', cgstin: cu.gstin || '' })); setPickC(false); setQ(''); };

  const persist = () => {
    const items = d.items.filter((it) => it.n.trim() && (+it.q || 0) > 0);
    if (!items.length) { flash('Please add at least one item'); return null; }
    const { recv: _r, mode, isNew, ...rest } = bill;
    const payments = [...(rest.payments || [])];
    if (d.type === 'invoice' && recv > 0) payments.push({ amt: recv, dt: today(), mode: d.mode });
    const b = { ...rest, items, payments };
    const saved = saveBill(b);
    setD((x) => ({ ...x, payments, recv: '', isNew: false, cid: saved.cid }));
    return saved;
  };
  const doSave = () => { const b = persist(); if (b) { flash(TYPE_NAME[b.type] + ' saved ✓'); onClose(); } };
  const doPdf = async () => { const b = persist(); if (b) await sharePdf(b); };
  const doPrint = () => { const b = persist(); if (b) Print.printAsync({ html: billHtml(b, cfg) }).catch(() => {}); };
  const doWa = async () => { const b = persist(); if (b) await shareImage(b); };
  const doText = () => {
    const b = persist(); if (!b) return;
    sendWa(b.cph, billText(b, cfg));
  };
  const back = () => Alert.alert('Leave without saving?', 'Your changes will not be saved.', [{ text: 'Stay', style: 'cancel' }, { text: 'Leave', style: 'destructive', onPress: onClose }]);
  useEffect(() => {
    const h = BackHandler.addEventListener('hardwareBackPress', () => { back(); return true; });
    return () => h.remove();
  }, []);

  const types = [['invoice', 'Invoice'], ['quote', 'Quotation'], ['cn', 'Credit Note']].map(([v, l]) => ({ v, l }));
  const ql = q.toLowerCase();
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10 }}>
        <TouchableOpacity onPress={back}><Text style={{ color: C.ink, fontSize: 26 }}>←</Text></TouchableOpacity>
        <Text style={{ color: C.ink, fontSize: 19, fontWeight: '700', flex: 1 }}>{d.isNew ? 'New ' + TYPE_NAME[d.type] : 'Edit ' + d.no}</Text>
        <Text style={{ color: C.g, fontWeight: '700', fontSize: 17 }}>{money(c.total)}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        <Card title="Document">
          {d.isNew && <Row><Select label="Type" value={d.type} options={types} onChange={(v) => setD((x) => ({ ...x, type: v, no: nextNo(bills, v, cfg) }))} /></Row>}
          <Row>
            <Field label="Number" value={d.no} onChangeText={(v) => set('no', v)} />
            <DateField label="Date" value={d.dt} onChange={(v) => set('dt', v || today())} />
          </Row>
          {d.type === 'invoice' && <Row><DateField label="Due date (optional)" value={d.due} onChange={(v) => set('due', v)} clearable /></Row>}
        </Card>

        <Card title="Customer" right={<TouchableOpacity onPress={() => setPickC(true)}><Text style={{ color: C.g, fontWeight: '600' }}>Select saved ▸</Text></TouchableOpacity>}>
          <Row>
            <Field label="Name" value={d.cust} onChangeText={(v) => setD((x) => ({ ...x, cust: v, cid: '' }))} placeholder="Walk-in customer" />
            <Field label="Phone" keyboardType="phone-pad" value={d.cph} onChangeText={(v) => set('cph', v)} />
          </Row>
          <Row><Field label="Address (optional)" value={d.caddr} onChangeText={(v) => set('caddr', v)} /></Row>
          {g && (
            <Row>
              <Field label="Customer GSTIN (optional)" autoCapitalize="characters" maxLength={15} value={d.cgstin} onChangeText={(v) => set('cgstin', v.toUpperCase())} />
              <Select label="Supply" value={d.supply} options={[{ v: '', l: 'Auto' }, { v: 'intra', l: 'Same state (CGST+SGST)' }, { v: 'inter', l: 'Other state (IGST)' }]} onChange={(v) => set('supply', v)} />
            </Row>
          )}
        </Card>

        <Card title="Items">
          {d.items.map((it, k) => (
            <View key={k} style={{ borderBottomWidth: 1, borderColor: C.line, paddingBottom: 10, marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
                <Field label={'Item ' + (k + 1)} placeholder="Item name" value={it.n} onChangeText={(v) => updItem(k, 'n', v)} />
                <TouchableOpacity onPress={() => setD((x) => ({ ...x, items: x.items.filter((_, j) => j !== k) }))} style={{ padding: 8 }}><Text style={{ color: C.red, fontSize: 24 }}>×</Text></TouchableOpacity>
              </View>
              <Row style={{ marginTop: 8, marginBottom: 0 }}>
                <Field label="Qty" style={{ minWidth: 70 }} keyboardType="decimal-pad" value={String(it.q)} onChangeText={(v) => updItem(k, 'q', v)} />
                <Select label="Unit" style={{ minWidth: 90 }} value={it.u || ''} options={UNITS.map((u) => ({ v: u, l: u || 'unit' }))} onChange={(v) => updItem(k, 'u', v)} />
                <Field label="Rate ₹" style={{ minWidth: 90 }} keyboardType="decimal-pad" value={String(it.r)} onChangeText={(v) => updItem(k, 'r', v)} />
              </Row>
              {g && (
                <Row style={{ marginTop: 8, marginBottom: 0 }}>
                  <Field label="HSN / SAC" keyboardType="number-pad" value={it.hsn || ''} onChangeText={(v) => updItem(k, 'hsn', v)} />
                  <Select label="GST %" value={String(it.g)} options={GST_RATES.map((x) => ({ v: x, l: x + '%' }))} onChange={(v) => updItem(k, 'g', v)} />
                </Row>
              )}
              <Text style={{ textAlign: 'right', color: C.ink, fontWeight: '700', marginTop: 6 }}>{money((+it.q || 0) * (+it.r || 0))}</Text>
            </View>
          ))}
          <Row style={{ marginBottom: 0 }}>
            <Btn s t="+ From items" on={() => setPickP(true)} />
            <Btn s t="+ Custom item" on={() => setD((x) => ({ ...x, items: [...x.items, blankItem()] }))} />
          </Row>
        </Card>

        <Card title="Totals">
          <Row>
            <Field label="Discount" keyboardType="decimal-pad" value={String(d.dis)} onChangeText={(v) => set('dis', v)} />
            <Select label="Type" value={d.disT} options={[{ v: '₹', l: '₹ Amount' }, { v: '%', l: '% Percent' }]} onChange={(v) => set('disT', v)} />
          </Row>
          {[['Subtotal', money(c.sub)], c.disc > 0 && ['Discount', '-' + money(c.disc)], g && ['Taxable value', money(c.taxable)],
            g && (c.inter ? ['IGST', money(c.igst)] : null), g && !c.inter && ['CGST', money(c.cgst)], g && !c.inter && ['SGST', money(c.sgst)],
            Math.abs(c.ro) > 0.004 && ['Round off', (c.ro > 0 ? '+' : '') + r2(c.ro)]].filter(Boolean).map(([a, v]) => (
            <View key={a} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}><Text style={{ color: C.ink }}>{a}</Text><Text style={{ color: C.ink }}>{v}</Text></View>
          ))}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 2, borderColor: C.g, marginTop: 6, paddingTop: 8 }}>
            <Text style={{ color: C.g, fontWeight: '700', fontSize: 20 }}>Total</Text><Text style={{ color: C.g, fontWeight: '700', fontSize: 20 }}>{money(c.total)}</Text>
          </View>
          <Text style={{ color: C.mute, fontStyle: 'italic', fontSize: 12, marginTop: 6 }}>{rupeesWords(c.total)}</Text>
        </Card>

        {d.type === 'invoice' && (
          <Card title="Payment">
            {i.paid > 0 && <Text style={{ color: C.ok, marginBottom: 8 }}>Received earlier: {money(i.paid)}</Text>}
            <Row>
              <Field label="Received now (₹)" keyboardType="decimal-pad" value={d.recv} onChangeText={(v) => set('recv', v)} placeholder="0" />
              <Select label="Mode" value={d.mode} options={MODES.map((m) => ({ v: m, l: m }))} onChange={(v) => set('mode', v)} />
            </Row>
            <Row style={{ marginBottom: 6 }}>
              <Btn s t="Fully paid" on={() => set('recv', String(Math.max(0, r2(i.total - i.paid))))} />
              <Btn s t="Unpaid (credit)" on={() => set('recv', '')} />
            </Row>
            <Text style={{ color: i.total - i.paid - recv > 0.005 ? C.red : C.ok, fontWeight: '700' }}>
              Balance: {money(Math.max(0, r2(i.total - i.paid - recv)))}
            </Text>
            {upiOk(cfg) && i.total - i.paid - recv > 0.005 && (
              <View style={{ alignItems: 'center', marginTop: 12 }}>
                <View style={{ backgroundColor: '#fff', padding: 4, borderRadius: 6 }}>
                  <QRCode value={upiLink(cfg, bill, r2(i.total - i.paid - recv))} size={170} quietZone={10} backgroundColor="#ffffff" color="#000000" ecl="M" />
                </View>
                <Text style={{ color: C.mute, fontSize: 12, marginTop: 6 }}>Scan to pay {money(i.total - i.paid - recv)} · {cfg.upi}</Text>
              </View>
            )}
          </Card>
        )}

        <Card title="Notes">
          <Row style={{ marginBottom: 0 }}><Field multiline value={d.notes} onChangeText={(v) => set('notes', v)} placeholder="Note for the customer (optional)" /></Row>
        </Card>
      </ScrollView>

      {!kb && (
        <View style={{ backgroundColor: C.paper, borderTopWidth: 1, borderColor: C.line, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 12 + ins.bottom }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <Btn t="Save" on={doSave} style={{ minWidth: 0, padding: 11 }} />
            <Btn t="Save & PDF" on={doPdf} style={{ minWidth: 0, padding: 11 }} />
          </View>
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
            <Btn s t="Print" on={doPrint} style={{ minWidth: 0, padding: 11 }} />
            <Btn s t="WhatsApp photo" on={doWa} style={{ minWidth: 0, padding: 11 }} />
            <Btn s t="Text" on={doText} style={{ minWidth: 0, padding: 11 }} />
          </View>
        </View>
      )}

      <Sheet visible={pickP} onClose={closePick} title="Choose from items"
        footer={<Btn t={selP.length ? 'Add ' + selP.length + (selP.length === 1 ? ' item' : ' items') : 'Tap items to select'} on={addProds} />}>
        <Search value={q} onChange={setQ} ph="Item search" />
        {prods.filter((p) => p.name.toLowerCase().includes(ql)).map((p) => {
          const on = selP.includes(p.id);
          return (
            <TouchableOpacity key={p.id} onPress={() => togP(p.id)} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: on ? C.bg : C.paper, borderRadius: 8, padding: 12, marginBottom: 6, borderWidth: on ? 2 : 1, borderColor: on ? C.g : C.line }}>
              <View style={{ width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: on ? C.g : C.mute, backgroundColor: on ? C.g : 'transparent', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                {on && <Text style={{ color: C.btnt, fontWeight: '700', fontSize: 14 }}>✓</Text>}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.ink, fontWeight: '600' }}>{p.name}</Text>
                <Text style={{ color: C.mute, fontSize: 12 }}>{money(+p.rate || 0)}{p.unit ? '/' + p.unit : ''}{g ? ' · GST ' + (p.gst ?? 0) + '%' : ''}{p.track ? ' · Stock ' + (p.stock || 0) : ''}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
        {!prods.length && <Empty t="No items saved yet. Add them from the Items tab." />}
      </Sheet>
      <Sheet visible={pickC} onClose={() => setPickC(false)} title="Choose customer">
        <Search value={q} onChange={setQ} ph="Name or phone" />
        {custs.filter((x) => (x.name + x.phone).toLowerCase().includes(ql)).map((x) => (
          <TouchableOpacity key={x.id} onPress={() => pickCust(x)} style={{ backgroundColor: C.paper, borderRadius: 8, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: C.line }}>
            <Text style={{ color: C.ink, fontWeight: '600' }}>{x.name}</Text>
            <Text style={{ color: C.mute, fontSize: 12 }}>{x.phone}</Text>
          </TouchableOpacity>
        ))}
        {!custs.length && <Empty t="No customers saved yet. A customer is saved automatically when you save a bill." />}
      </Sheet>
    </View>
  );
}

/* =====================================================================
   SCREENS
   ===================================================================== */
function Home() {
  const { C, cfg, bills, openEditor, openBill, remind } = useX();
  const infos = useMemo(() => bills.map((b) => ({ b, i: info(b) })), [bills]);
  const t = today(), m = t.slice(0, 7);
  const sum = (f) => infos.filter(({ b }) => b.type !== 'quote' && f(b)).reduce((s, { b, i }) => s + (b.type === 'cn' ? -i.total : i.total), 0);
  const pending = infos.filter(({ i }) => i.bal > 0.005).sort((a, z) => (a.b.due || a.b.dt) < (z.b.due || z.b.dt) ? -1 : 1);
  const due = pending.reduce((s, { i }) => s + i.bal, 0);
  const Stat = ({ l, v, col, sub }) => (
    <View style={{ width: '48.5%', backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 14, marginBottom: 8 }}>
      <Text style={{ color: C.mute, fontSize: 12 }}>{l}</Text>
      <Text style={{ color: col || C.ink, fontSize: 22, fontWeight: '700', marginTop: 2 }}>{v}</Text>
      {!!sub && <Text style={{ color: C.mute, fontSize: 11 }}>{sub}</Text>}
    </View>
  );
  return (
    <View>
      <Text style={{ color: C.mute }}>Welcome 👋</Text>
      <Text style={{ color: C.ink, fontSize: 24, fontWeight: '700', marginBottom: 12 }}>{cfg.name}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <Stat l="Today's sales" v={money(sum((b) => b.dt === t))} sub={'Only ' + fmtD(t)} />
        <Stat l="This month's sales" v={money(sum((b) => b.dt.slice(0, 7) === m))} sub={['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m.slice(5, 7) - 1] + ' ' + m.slice(0, 4) + ' · full month'} />
        <Stat l="Amount to receive" v={money(due)} col={due > 0 ? C.red : C.ok} sub={pending.length + ' bill pending'} />
        <Stat l="Total bills" v={String(infos.filter(({ b }) => b.type === 'invoice').length)} sub={infos.filter(({ b }) => b.type === 'quote').length + ' quotation'} />
      </View>
      <Row><Btn t="+ New Invoice" on={() => openEditor('invoice')} /><Btn s t="+ Quotation" on={() => openEditor('quote')} /></Row>

      <Card title="Pending payments">
        {!pending.length && <Text style={{ color: C.mute }}>No pending payments 🎉</Text>}
        {pending.slice(0, 5).map(({ b, i }) => (
          <TouchableOpacity key={b.id} onPress={() => openBill(b.id)} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderColor: C.line }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.ink, fontWeight: '600' }}>{b.cust || 'Walk-in'} · {b.no}</Text>
              <Text style={{ color: i.overdue ? C.red : C.mute, fontSize: 12 }}>{b.due ? 'Due ' + fmtD(b.due) : fmtD(b.dt)}{i.overdue ? ' · Overdue' : ''}</Text>
            </View>
            <Text style={{ color: C.red, fontWeight: '700' }}>{money(i.bal)}</Text>
            {!!b.cph && <TouchableOpacity onPress={() => remind(b.cust, b.cph, b.no, i.bal)} style={{ paddingLeft: 12 }}><Text style={{ fontSize: 20 }}>🔔</Text></TouchableOpacity>}
          </TouchableOpacity>
        ))}
      </Card>

      <Card title="Recent bills">
        {!infos.length && <Text style={{ color: C.mute }}>No bills yet. Tap “+ New Invoice”.</Text>}
        {infos.slice(0, 5).map(({ b, i }) => <BillRow key={b.id} b={b} i={i} onPress={() => openBill(b.id)} />)}
      </Card>
    </View>
  );
}
function BillRow({ b, i, onPress }) {
  const { C } = useX();
  return (
    <TouchableOpacity onPress={onPress} style={{ paddingVertical: 9, borderBottomWidth: 1, borderColor: C.line, flexDirection: 'row', alignItems: 'center' }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: C.ink, fontWeight: '600' }}>{b.cust || 'Walk-in'}</Text>
        <Text style={{ color: C.mute, fontSize: 12 }}>{b.no} · {fmtD(b.dt)}</Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 3 }}>
        <Text style={{ color: C.ink, fontWeight: '700' }}>{(b.type === 'cn' ? '-' : '') + money(i.total)}</Text>
        <StatusPill i={i} />
      </View>
    </TouchableOpacity>
  );
}

function Bills() {
  const { C, bills, openBill } = useX();
  const [q, setQ] = useState(''), [ty, setTy] = useState('all'), [stt, setStt] = useState('all');
  const list = bills.map((b) => ({ b, i: info(b) })).filter(({ b, i }) =>
    (ty === 'all' || b.type === ty) && (stt === 'all' || i.status === stt) &&
    ((b.cust || '') + b.no + (b.cph || '')).toLowerCase().includes(q.toLowerCase()));
  return (
    <View>
      <Search value={q} onChange={setQ} ph="Name, phone or bill number" />
      <Chips value={ty} onChange={setTy} options={[['all', 'All'], ['invoice', 'Invoices'], ['quote', 'Quotations'], ['cn', 'Credit notes']]} />
      <Chips value={stt} onChange={setStt} options={[['all', 'Any status'], ['Paid', 'Paid'], ['Partial', 'Partial'], ['Unpaid', 'Unpaid']]} />
      <View style={{ backgroundColor: C.paper, borderRadius: 12, borderWidth: 1, borderColor: C.line, paddingHorizontal: 12 }}>
        {!list.length ? <Empty t="No bills found." /> : list.map(({ b, i }) => <BillRow key={b.id} b={b} i={i} onPress={() => openBill(b.id)} />)}
      </View>
    </View>
  );
}

function BillSheet({ id, onClose }) {
  const { C, cfg, bills, setBills, openEditor, editBill, duplicate, convert, sharePdf, shareImage, deleteBill, remind, flash } = useX();
  const b = bills.find((x) => x.id === id);
  const [pay, setPay] = useState(false), [amt, setAmt] = useState(''), [mode, setMode] = useState('Cash');
  useEffect(() => { setPay(false); setAmt(''); }, [id]);
  if (!b) return null;
  const i = info(b);
  const addPay = () => {
    const a = +amt || 0; if (a <= 0) return;
    setBills((l) => l.map((x) => (x.id === b.id ? { ...x, payments: [...(x.payments || []), { amt: a, dt: today(), mode }] } : x)));
    setPay(false); setAmt(''); flash('Payment added ✓');
  };
  const rm = (k) => setBills((l) => l.map((x) => (x.id === b.id ? { ...x, payments: x.payments.filter((_, j) => j !== k) } : x)));
  return (
    <Sheet visible={!!id} onClose={onClose} title={docTitle(b).replace('TAX ', '') + ' ' + b.no}>
      <Card>
        <Text style={{ color: C.ink, fontSize: 18, fontWeight: '700' }}>{b.cust || 'Walk-in customer'}</Text>
        <Text style={{ color: C.mute, fontSize: 12, marginBottom: 8 }}>{fmtD(b.dt)}{b.due ? ' · Due ' + fmtD(b.due) : ''}{b.cph ? ' · ' + b.cph : ''}</Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={{ color: C.ink }}>Total</Text><Text style={{ color: C.ink, fontWeight: '700' }}>{money(i.total)}</Text></View>
        {b.type === 'invoice' && <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={{ color: C.ok }}>Mile</Text><Text style={{ color: C.ok }}>{money(i.paid)}</Text></View>}
        {b.type === 'invoice' && <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={{ color: C.red }}>Balance</Text><Text style={{ color: C.red, fontWeight: '700' }}>{money(i.bal)}</Text></View>}
        <View style={{ marginTop: 8 }}><StatusPill i={i} /></View>
        {(b.payments || []).map((p, k) => (
          <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
            <Text style={{ color: C.mute, fontSize: 12 }}>{fmtD(p.dt)} · {p.mode}</Text>
            <Text style={{ color: C.mute, fontSize: 12 }}>{money(p.amt)}  <Text onPress={() => rm(k)} style={{ color: C.red }}>✕</Text></Text>
          </View>
        ))}
      </Card>
      {pay && (
        <Card title="Add payment">
          <Row><Field label="Amount ₹" keyboardType="decimal-pad" value={amt} onChangeText={setAmt} /><Select label="Mode" value={mode} options={MODES.map((m) => ({ v: m, l: m }))} onChange={setMode} /></Row>
          <Row style={{ marginBottom: 0 }}><Btn s t="Full balance" on={() => setAmt(String(i.bal))} /><Btn t="Add" on={addPay} /></Row>
        </Card>
      )}
      <Row>
        <Btn t="WhatsApp photo" on={() => shareImage(b)} />
        <Btn s t="PDF" on={() => sharePdf(b)} />
      </Row>
      <Row>
        <Btn s t="Send text" on={() => sendWa(b.cph, billText(b, cfg))} />
        <Btn s t="Print" on={() => Print.printAsync({ html: billHtml(b, cfg) }).catch(() => {})} />
      </Row>
      <Row>
        <Btn s t="Edit" on={() => { onClose(); editBill(b); }} />
        <Btn s t="Duplicate" on={() => { onClose(); duplicate(b); }} />
      </Row>
      {b.type === 'invoice' && i.bal > 0.005 && <Row><Btn t="+ Payment" on={() => setPay(true)} />{!!b.cph && <Btn s t="🔔 Reminder" on={() => remind(b.cust, b.cph, b.no, i.bal)} />}</Row>}
      {b.type === 'quote' && <Row><Btn t="Convert to invoice" on={() => { onClose(); convert(b); }} /></Row>}
      <Row><Btn danger t="Delete" on={() => Alert.alert('Delete?', b.no + ' will be deleted permanently.', [{ text: 'No', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { deleteBill(b.id); onClose(); } }])} /></Row>
    </Sheet>
  );
}

function Customers() {
  const { C, custs, bills, setCusts, gstOn, openEditor, remind, flash } = useX();
  const [q, setQ] = useState(''), [f, setF] = useState(null);
  const bal = (cu) => bills.filter((b) => b.cid === cu.id).reduce((s, b) => s + info(b).bal, 0);
  const save = () => {
    if (!f.name.trim()) { flash('Name is required'); return; }
    setCusts((l) => (l.some((x) => x.id === f.id) ? l.map((x) => (x.id === f.id ? f : x)) : [f, ...l]));
    setF(null); flash('Customer saved ✓');
  };
  const list = custs.filter((x) => (x.name + x.phone).toLowerCase().includes(q.toLowerCase())).sort((a, z) => a.name.localeCompare(z.name));
  const ex = f && custs.some((x) => x.id === f.id);
  return (
    <View>
      <Row style={{ alignItems: 'flex-end' }}>
        <Field value={q} onChangeText={setQ} placeholder="Search customer" />
        <Btn t="+ Add" on={() => setF({ id: uid(), name: '', phone: '', addr: '', gstin: '' })} style={{ flex: 0, minWidth: 80, padding: 10 }} />
      </Row>
      <View style={{ backgroundColor: C.paper, borderRadius: 12, borderWidth: 1, borderColor: C.line, paddingHorizontal: 12 }}>
        {!list.length ? <Empty t="No customers yet." /> : list.map((cu) => {
          const bb = bal(cu);
          return (
            <TouchableOpacity key={cu.id} onPress={() => setF(cu)} style={{ paddingVertical: 11, borderBottomWidth: 1, borderColor: C.line, flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: C.g, alignItems: 'center', justifyContent: 'center', marginRight: 10 }}><Text style={{ color: C.btnt, fontWeight: '700' }}>{cu.name[0].toUpperCase()}</Text></View>
              <View style={{ flex: 1 }}><Text style={{ color: C.ink, fontWeight: '600' }}>{cu.name}</Text><Text style={{ color: C.mute, fontSize: 12 }}>{cu.phone}</Text></View>
              {bb > 0.005 && <Text style={{ color: C.red, fontWeight: '700' }}>{money(bb)} due</Text>}
            </TouchableOpacity>
          );
        })}
      </View>
      <Sheet visible={!!f} onClose={() => setF(null)} title={ex ? 'Customer' : 'New customer'}
        footer={<View><Row style={{ marginBottom: 0 }}><Btn t="Save" on={save} />{ex && <Btn s t="+ New bill" on={() => { const c = f; setF(null); openEditor('invoice', c); }} />}</Row></View>}>
        {!!f && (
          <View>
            <Row><Field label="Name *" value={f.name} onChangeText={(v) => setF({ ...f, name: v })} /></Row>
            <Row><Field label="Phone" keyboardType="phone-pad" value={f.phone} onChangeText={(v) => setF({ ...f, phone: v })} /></Row>
            <Row><Field label="Address" value={f.addr} onChangeText={(v) => setF({ ...f, addr: v })} /></Row>
            {gstOn && <Row><Field label="GSTIN (optional)" autoCapitalize="characters" maxLength={15} value={f.gstin} onChangeText={(v) => setF({ ...f, gstin: v.toUpperCase() })} /></Row>}
            {ex && bal(f) > 0.005 && !!f.phone && <Row><Btn s t={'🔔 ' + money(bal(f)) + ' reminder'} on={() => remind(f.name, f.phone, '', bal(f))} /></Row>}
            {ex && <Row><Btn danger t="Delete customer" on={() => Alert.alert('Delete?', 'Existing bills will not be deleted.', [{ text: 'No', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { setCusts((l) => l.filter((x) => x.id !== f.id)); setF(null); } }])} /></Row>}
          </View>
        )}
      </Sheet>
    </View>
  );
}

function Items() {
  const { C, cfg, prods, setProds, gstOn, flash } = useX();
  const [q, setQ] = useState(''), [f, setF] = useState(null);
  const save = () => {
    if (!f.name.trim()) { flash('Item name is required'); return; }
    setProds((l) => (l.some((x) => x.id === f.id) ? l.map((x) => (x.id === f.id ? f : x)) : [f, ...l]));
    setF(null); flash('Item saved ✓');
  };
  const list = prods.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())).sort((a, z) => a.name.localeCompare(z.name));
  const ex = f && prods.some((x) => x.id === f.id);
  return (
    <View>
      <Row style={{ alignItems: 'flex-end' }}>
        <Field value={q} onChangeText={setQ} placeholder="Search item" />
        <Btn t="+ Add" on={() => setF({ id: uid(), name: '', rate: '', unit: '', hsn: '', gst: String(cfg.defGst || '0'), track: false, stock: '', low: '5' })} style={{ flex: 0, minWidth: 80, padding: 10 }} />
      </Row>
      <View style={{ backgroundColor: C.paper, borderRadius: 12, borderWidth: 1, borderColor: C.line, paddingHorizontal: 12 }}>
        {!list.length ? <Empty t="No items yet. Save items to add them to a bill in one tap." /> : list.map((p) => {
          const low = p.track && (+p.stock || 0) <= (+p.low || 0);
          return (
            <TouchableOpacity key={p.id} onPress={() => setF(p)} style={{ paddingVertical: 11, borderBottomWidth: 1, borderColor: C.line, flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.ink, fontWeight: '600' }}>{p.name}</Text>
                <Text style={{ color: C.mute, fontSize: 12 }}>{money(+p.rate || 0)}{p.unit ? '/' + p.unit : ''}{gstOn ? ' · GST ' + p.gst + '%' + (p.hsn ? ' · HSN ' + p.hsn : '') : ''}</Text>
              </View>
              {!!p.track && <Pill t={'Stock ' + (p.stock || 0)} color={low ? C.red : C.ok} />}
            </TouchableOpacity>
          );
        })}
      </View>
      <Sheet visible={!!f} onClose={() => setF(null)} title={ex ? 'Edit item' : 'New item'}
        footer={<Row style={{ marginBottom: 0 }}><Btn t="Save" on={save} />{ex && <Btn danger t="Delete" on={() => { setProds((l) => l.filter((x) => x.id !== f.id)); setF(null); }} />}</Row>}>
        {!!f && (
          <View>
            <Row><Field label="Item name *" value={f.name} onChangeText={(v) => setF({ ...f, name: v })} /></Row>
            <Row>
              <Field label="Rate ₹" keyboardType="decimal-pad" value={String(f.rate)} onChangeText={(v) => setF({ ...f, rate: v })} />
              <Select label="Unit" value={f.unit || ''} options={UNITS.map((u) => ({ v: u, l: u || 'unit' }))} onChange={(v) => setF({ ...f, unit: v })} />
            </Row>
            {gstOn && (
              <Row>
                <Field label="HSN / SAC" keyboardType="number-pad" value={f.hsn || ''} onChangeText={(v) => setF({ ...f, hsn: v })} />
                <Select label="GST %" value={String(f.gst)} options={GST_RATES.map((x) => ({ v: x, l: x + '%' }))} onChange={(v) => setF({ ...f, gst: v })} />
              </Row>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <View style={{ flex: 1 }}><Text style={{ color: C.ink, fontWeight: '600' }}>Track stock</Text><Text style={{ color: C.mute, fontSize: 12 }}>Stock reduces automatically when you create an invoice.</Text></View>
              <Switch value={!!f.track} onValueChange={(v) => setF({ ...f, track: v })} trackColor={{ true: C.btn }} />
            </View>
            {!!f.track && (
              <Row>
                <Field label="Current stock" keyboardType="decimal-pad" value={String(f.stock || '')} onChangeText={(v) => setF({ ...f, stock: v })} />
                <Field label="Low stock alert at" keyboardType="decimal-pad" value={String(f.low || '')} onChangeText={(v) => setF({ ...f, low: v })} />
              </Row>
            )}
          </View>
        )}
      </Sheet>
    </View>
  );
}

function Reports() {
  const { C, cfg, bills, gstOn } = useX();
  const [from, setFrom] = useState(today().slice(0, 8) + '01'), [to, setTo] = useState(today()), [msg, setMsg] = useState('');
  const list = bills.filter((b) => b.type !== 'quote' && (!from || b.dt >= from) && (!to || b.dt <= to)).sort((a, z) => (a.dt < z.dt ? -1 : a.dt > z.dt ? 1 : 0));
  const sg = (b) => (b.type === 'cn' ? -1 : 1);
  const tot = list.reduce((a, b) => { const i = info(b), s = sg(b); return { n: a.n + 1, tx: a.tx + s * i.c.taxable, tax: a.tax + s * i.c.tax, t: a.t + s * i.total, paid: a.paid + (b.type === 'invoice' ? i.paid : 0), bal: a.bal + i.bal }; }, { n: 0, tx: 0, tax: 0, t: 0, paid: 0, bal: 0 });
  const share = async (rows, name) => { try { await Share.share({ title: name, message: rows.map((r) => r.map(csvQ).join(',')).join('\r\n') }); setMsg('Report shared ✓'); } catch (e) { setMsg('Could not share.'); } };
  const sales = () => {
    const rows = [['Doc No', 'Type', 'Date', 'Customer', 'Phone', 'Subtotal', 'Discount', 'Total', 'Paid', 'Balance', 'Status']];
    list.forEach((b) => { const i = info(b), s = sg(b); rows.push([b.no, TYPE_NAME[b.type], b.dt, b.cust, b.cph, r2(s * i.c.sub), r2(s * i.c.disc), r2(s * i.total), r2(i.paid), r2(i.bal), i.status]); });
    share(rows, 'Sales-report.csv');
  };
  const gst = () => {
    const l = list.filter((b) => b.gst);
    if (!l.length) { setMsg('No GST bills in this range.'); return; }
    const rows = [['Doc No', 'Type', 'Date', 'Customer', 'Customer GSTIN', 'B2B/B2C', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total Tax', 'Round Off', 'Invoice Total']];
    const T = [0, 0, 0, 0, 0, 0, 0];
    l.forEach((b) => {
      const c = info(b).c, s = sg(b), v = [c.taxable, c.cgst, c.sgst, c.igst, c.tax, c.ro, c.total].map((x) => r2(s * x));
      v.forEach((x, k) => { T[k] += x; });
      rows.push([b.no, TYPE_NAME[b.type], b.dt, b.cust, b.cgstin, b.cgstin ? 'B2B' : 'B2C', ...v]);
    });
    rows.push(['TOTAL', '', '', '', '', '', ...T.map(r2)]);
    share(rows, 'GST-report.csv');
  };
  return (
    <View>
      <Card title="Report period">
        <Row><DateField label="From" value={from} onChange={setFrom} clearable /><DateField label="To" value={to} onChange={setTo} clearable /></Row>
        <Text style={{ color: C.ink }}>{tot.n} bill(s) · Sale {money(tot.t)}</Text>
        {gstOn && <Text style={{ color: C.ink }}>Taxable {money(tot.tx)} · GST {money(tot.tax)}</Text>}
        <Text style={{ color: C.mute }}>Received {money(tot.paid)} · Balance {money(tot.bal)}</Text>
      </Card>
      <Row><Btn t="Sales report (CSV)" on={sales} /></Row>
      {gstOn && <Row><Btn t="GST report (CSV)" on={gst} /></Row>}
      {!!msg && <Text style={{ color: C.mute, textAlign: 'center' }}>{msg}</Text>}
    </View>
  );
}

function Backup() {
  const { C, cfg, bills, custs, prods, applyBackup } = useX();
  const [paste, setPaste] = useState(''), [msg, setMsg] = useState('');
  const doShare = async () => {
    try {
      const { pin, ...safeCfg } = cfg; // a PIN is never part of a backup
      await Share.share({ title: 'Invoice-backup-' + today() + '.json', message: JSON.stringify({ app: 'invoice', v: 2, saved: today(), cfg: safeCfg, bills, custs, prods }) });
      setMsg('Backup shared ✓');
    } catch (e) { setMsg('Backup failed.'); }
  };
  const askShare = () => Alert.alert('Share backup?', 'The backup is plain, unencrypted text. It contains your business and bank details, your customers\' names and phone numbers, and all your bills. Share it only with yourself or with storage you trust.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Share', onPress: doShare }]);
  const doRestore = () => {
    const d = parseBackup(paste);
    if (!d) { setMsg('This does not look like a valid backup.'); return; }
    const ch = [];
    [['upi', 'UPI ID'], ['bankName', 'Bank name'], ['bankAcc', 'Bank account'], ['ifsc', 'IFSC']].forEach(([k, l]) => {
      if (d.cfg[k] !== undefined && d.cfg[k] !== (cfg[k] || '')) ch.push(l + ': ' + (cfg[k] || '(none)') + ' -> ' + (d.cfg[k] || '(none)'));
    });
    const go = () => { applyBackup(d); setPaste(''); setMsg('Restored ' + d.bills.length + ' bills, ' + d.custs.length + ' customers, ' + d.prods.length + ' items ✓'); };
    Alert.alert('Restore this backup?',
      'It contains ' + d.bills.length + ' bills, ' + d.custs.length + ' customers and ' + d.prods.length + ' items. Records with the same ID will be overwritten.' +
      (ch.length ? '\n\nIt will also CHANGE your payment details:\n' + ch.join('\n') + '\n\nContinue only if you made this backup yourself.' : ''),
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Restore', style: ch.length ? 'destructive' : 'default', onPress: go }]);
  };
  return (
    <View>
      <Card title="Backup">
        <Text style={{ color: C.mute, fontSize: 12, marginBottom: 8 }}>Save the backup text somewhere private (your own cloud storage or notes). To move to a new phone, paste it below and tap Restore. Never paste a backup that someone else sent you.</Text>
        <Row style={{ marginBottom: 0 }}><Btn t="Share backup" on={askShare} /></Row>
      </Card>
      <Card title="Restore">
        <Row><Field multiline value={paste} onChangeText={setPaste} placeholder="Paste your backup text here" /></Row>
        <Row style={{ marginBottom: 0 }}><Btn s t="Restore" on={doRestore} /></Row>
      </Card>
      {!!msg && <Text style={{ color: C.mute, textAlign: 'center' }}>{msg}</Text>}
    </View>
  );
}

function Security() {
  const { C, pinLen, applyPin, dropPin, flash } = useX();
  const [cur, setCur] = useState(''), [a, setA] = useState(''), [b, setB] = useState('');
  const verify = async () => {
    if (!pinLen) return true;
    const r = await checkPin(cur);
    if (r.ok) return true;
    flash(r.err ? 'Secure storage is unavailable' : r.wait ? 'Too many attempts. Try again in ' + r.wait + 's' : 'Current PIN is wrong');
    return false;
  };
  const set = async () => {
    if (!/^\d{4,6}$/.test(a)) { flash('Use a 4 to 6 digit PIN'); return; }
    if (weakPin(a)) { flash('That PIN is too easy to guess'); return; }
    if (a !== b) { flash('The two PINs do not match'); return; }
    if (!(await verify())) return;
    try { await applyPin(a); setCur(''); setA(''); setB(''); flash('PIN saved ✓'); } catch (e) { flash('Could not save the PIN on this device'); }
  };
  const remove = async () => {
    if (!(await verify())) return;
    try { await dropPin(); setCur(''); setA(''); setB(''); flash('PIN removed'); } catch (e) { flash('Could not remove the PIN'); }
  };
  return (
    <View>
      <Card title="App lock (PIN)">
        <Text style={{ color: C.mute, fontSize: 12, marginBottom: 8 }}>{pinLen ? 'A PIN is on. Enter your current PIN to change or remove it.' : 'Set a 4 to 6 digit PIN (6 is safer). The app locks when opened and again after it has been in the background for a minute.'}</Text>
        {!!pinLen && <Row><Field label="Current PIN" secureTextEntry keyboardType="number-pad" maxLength={6} value={cur} onChangeText={setCur} /></Row>}
        <Row><Field label="New PIN" secureTextEntry keyboardType="number-pad" maxLength={6} value={a} onChangeText={setA} /><Field label="Confirm PIN" secureTextEntry keyboardType="number-pad" maxLength={6} value={b} onChangeText={setB} /></Row>
        <Row style={{ marginBottom: 0 }}><Btn t={pinLen ? 'Change PIN' : 'Set PIN'} on={set} />{!!pinLen && <Btn danger t="Remove PIN" on={remove} />}</Row>
      </Card>
    </View>
  );
}

function More() {
  const { C } = useX();
  const [sub, setSub] = useState(null);
  useEffect(() => {
    if (!sub) return undefined;
    const h = BackHandler.addEventListener('hardwareBackPress', () => { setSub(null); return true; });
    return () => h.remove();
  }, [sub]);
  const items = [['profile', '🏪', 'Shop profile & GST', 'Business details, GST on/off, bank, terms'], ['reports', '📊', 'Reports', 'Sales and GST reports (CSV)'], ['backup', '💾', 'Backup / Restore', 'Keep your data safe'], ['security', '🔒', 'App lock', 'Protect the app with a PIN'], ['terms', '📜', 'Terms & Conditions', 'How the app works and your responsibilities']];
  if (sub) {
    const names = { profile: 'Shop profile & GST', reports: 'Reports', backup: 'Backup / Restore', security: 'App lock', terms: 'Terms & Conditions' };
    return (
      <View>
        <TouchableOpacity onPress={() => setSub(null)} style={{ marginBottom: 10 }}><Text style={{ color: C.g, fontWeight: '600' }}>← {names[sub]}</Text></TouchableOpacity>
        {sub === 'profile' && <ProfileForm onDone={() => setSub(null)} />}
        {sub === 'reports' && <Reports />}
        {sub === 'backup' && <Backup />}
        {sub === 'security' && <Security />}
        {sub === 'terms' && <Card title="Terms & Conditions"><TermsBody /></Card>}
      </View>
    );
  }
  return (
    <View style={{ backgroundColor: C.paper, borderRadius: 12, borderWidth: 1, borderColor: C.line, paddingHorizontal: 12 }}>
      {items.map(([k, ic, t, s]) => (
        <TouchableOpacity key={k} onPress={() => setSub(k)} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderColor: C.line }}>
          <Text style={{ fontSize: 24, marginRight: 12 }}>{ic}</Text>
          <View style={{ flex: 1 }}><Text style={{ color: C.ink, fontWeight: '600' }}>{t}</Text><Text style={{ color: C.mute, fontSize: 12 }}>{s}</Text></View>
          <Text style={{ color: C.mute, fontSize: 20 }}>›</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function Lock({ len, onOk }) {
  const { C } = useX();
  const [v, setV] = useState(''), [msg, setMsg] = useState(''), [busy, setBusy] = useState(false);
  const ch = async (t) => {
    const x = t.replace(/\D/g, '');
    setV(x);
    if (busy || x.length < len) return;
    setBusy(true);
    const r = await checkPin(x);
    if (r.ok) { onOk(); return; }
    setMsg(r.err ? 'Secure storage is unavailable. Restart the app and try again.' : r.wait ? 'Too many attempts. Try again in ' + r.wait + ' seconds.' : 'Wrong PIN. ' + r.left + ' attempt(s) left before a timeout.');
    setTimeout(() => { setV(''); setBusy(false); }, 600);
  };
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 }}>
      <Text style={{ fontSize: 40 }}>🔒</Text>
      <Text style={{ color: C.ink, fontSize: 20, fontWeight: '700', marginVertical: 10 }}>Enter PIN</Text>
      <TextInput autoFocus secureTextEntry keyboardType="number-pad" maxLength={len} value={v} onChangeText={ch}
        style={{ color: msg && busy ? C.red : C.ink, fontSize: 30, letterSpacing: 12, textAlign: 'center', borderBottomWidth: 2, borderColor: msg && busy ? C.red : C.g, minWidth: 160 }} />
      {!!msg && <Text style={{ color: C.red, marginTop: 14, textAlign: 'center' }}>{msg}</Text>}
    </View>
  );
}

function TermsBody() {
  const { C } = useX();
  return (
    <View>
      <Text style={{ color: C.mute, fontSize: 12, marginBottom: 10 }}>Last updated: {TERMS_UPDATED}</Text>
      {TERMS.map((s, k) => (
        <View key={k} style={{ marginBottom: 14 }}>
          <Text style={{ color: C.ink, fontWeight: '700', fontSize: 15, marginBottom: 4 }}>{k + 1}. {s.h}</Text>
          {s.p.map((t, j) => <Text key={j} style={{ color: C.ink, fontSize: 13, lineHeight: 19, marginBottom: 4 }}>{t}</Text>)}
        </View>
      ))}
    </View>
  );
}

function TermsGate({ onAccept }) {
  const { C, ins } = useX();
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 14, paddingTop: 10 }}>
        <Text style={{ color: C.ink, fontSize: 22, fontWeight: '700' }}>Terms & Conditions</Text>
        <Text style={{ color: C.mute, fontSize: 12, marginTop: 2 }}>Please read these terms. You need to accept them to use the app.</Text>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14 }}><TermsBody /></ScrollView>
      <View style={{ padding: 14, paddingBottom: 14 + ins.bottom, borderTopWidth: 1, borderColor: C.line, backgroundColor: C.paper }}>
        <Btn t="I Agree" on={onAccept} style={{ flex: 0, flexGrow: 0, flexBasis: 'auto', alignSelf: 'stretch', minHeight: 48, justifyContent: 'center', paddingVertical: 14 }} />
      </View>
    </View>
  );
}

/* =====================================================================
   APP
   ===================================================================== */
function Main() {
  const ins = useSafeAreaInsets();
  const scheme = useColorScheme();
  const [ready, setReady] = useState(false);
  const [cfg, setCfg] = useState({});
  const [bills, setBills] = useState([]);
  const [custs, setCusts] = useState([]);
  const [prods, setProds] = useState([]);
  const [tab, setTab] = useState('home');
  const [editor, setEditor] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [locked, setLocked] = useState(false);
  const [pinLen, setPinLen] = useState(0); // 0 = no PIN set
  const [termsOk, setTermsOk] = useState(false);
  const pinRef = useRef(0); pinRef.current = pinLen;
  const bgAt = useRef(0);
  const [toast, setToast] = useState('');
  const [kb, setKb] = useState(false);
  const [snapB, setSnapB] = useState(null);
  const snapRef = useRef(null);

  const C = palette(scheme === 'dark', safeAccent(cfg.accent));
  const gstOn = !!cfg.gstOn;
  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 2200); };

  useEffect(() => {
    (async () => {
      const rd = async (k, d) => { try { const v = await AsyncStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
      let c = await rd('bb2_cfg', null), b = await rd('bb2_bills', null);
      if (!c) { // first launch: bring old data across if present
        const oc = await rd('ac_cfg', null), oh = await rd('ac_hist', null);
        if (oc || oh) { const m = migrateOld(oc || {}, oh || []); c = m.cfg; b = m.bills; }
      }
      // PIN lives in the device keystore. Move any legacy plain-text PIN out of AsyncStorage.
      let pl = 0;
      let sp = await secGet();
      if (sp && !sp.err && !c && !(b && b.length)) { await removePin(); sp = null; } // fresh install: drop a stale keychain PIN
      if (sp) {
        pl = sp.err ? 6 : sp.len || 6;
        if (!sp.err && c && c.pin !== undefined) { const { pin: oldPin, ...rest } = c; c = rest; }
      } else if (c && c.pin) {
        const lp = String(c.pin);
        if (/^\d{4,6}$/.test(lp)) {
          pl = lp.length;
          try { await savePin(lp); const { pin: oldPin, ...rest } = c; c = rest; } catch (e) { /* keep the lock; it will fail closed */ }
        }
      }
      setCfg(c || {}); setBills(b || []);
      setCusts(await rd('bb2_custs', [])); setProds(await rd('bb2_prods', []));
      if (pl) { setPinLen(pl); setLocked(true); }
      try { setTermsOk((await AsyncStorage.getItem('bb2_terms')) === TERMS_VERSION); } catch (e) { setTermsOk(false); }
      setReady(true);
    })();
    const a = Keyboard.addListener('keyboardDidShow', () => setKb(true));
    const z = Keyboard.addListener('keyboardDidHide', () => setKb(false));
    return () => { a.remove(); z.remove(); };
  }, []);
  useEffect(() => { if (ready) AsyncStorage.setItem('bb2_cfg', JSON.stringify(cfg)).catch(() => {}); }, [cfg, ready]);
  useEffect(() => { if (ready) AsyncStorage.setItem('bb2_bills', JSON.stringify(bills)).catch(() => {}); }, [bills, ready]);
  useEffect(() => { if (ready) AsyncStorage.setItem('bb2_custs', JSON.stringify(custs)).catch(() => {}); }, [custs, ready]);
  useEffect(() => { if (ready) AsyncStorage.setItem('bb2_prods', JSON.stringify(prods)).catch(() => {}); }, [prods, ready]);
  // Re-lock when the app has been in the background for more than a minute
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'background') bgAt.current = Date.now();
      else if (st === 'active' && bgAt.current) { if (pinRef.current && Date.now() - bgAt.current > 60000) setLocked(true); bgAt.current = 0; }
    });
    return () => sub.remove();
  }, []);

  /* actions */
  const newDraft = (type, cu) => ({
    id: uid(), type, no: nextNo(bills, type, cfg), dt: today(), due: '',
    cid: cu ? cu.id : '', cust: cu ? cu.name : '', cph: cu ? cu.phone || '' : '', caddr: cu ? cu.addr || '' : '', cgstin: cu ? cu.gstin || '' : '', supply: '',
    items: [{ n: '', q: '1', r: '', u: '', hsn: '', g: String(cfg.defGst || '0'), pid: '' }], dis: '0', disT: '₹', notes: '', payments: [],
    gst: gstOn, rnd: !!cfg.round, recv: '', mode: 'Cash', isNew: true,
  });
  const openEditor = (type, cu) => setEditor(newDraft(type, cu));
  const editBill = (b) => setEditor({ ...JSON.parse(JSON.stringify(b)), recv: '', mode: 'Cash', isNew: false });
  const duplicate = (b) => setEditor({ ...JSON.parse(JSON.stringify(b)), id: uid(), no: nextNo(bills, b.type, cfg), dt: today(), due: '', payments: [], recv: '', mode: 'Cash', isNew: true });
  const convert = (b) => setEditor({ ...JSON.parse(JSON.stringify(b)), id: uid(), type: 'invoice', no: nextNo(bills, 'invoice', cfg), dt: today(), due: '', payments: [], recv: '', mode: 'Cash', isNew: true });
  const saveBill = (b) => {
    let nb = { ...b };
    if (!nb.cid && nb.cust.trim()) {
      const hit = custs.find((x) => x.name.toLowerCase() === nb.cust.trim().toLowerCase() && (!x.phone || !nb.cph || x.phone === nb.cph));
      if (hit) nb.cid = hit.id;
      else { const cu = { id: uid(), name: nb.cust.trim(), phone: nb.cph || '', addr: nb.caddr || '', gstin: nb.cgstin || '' }; setCusts((l) => [cu, ...l]); nb.cid = cu.id; }
    }
    const old = bills.find((x) => x.id === nb.id);
    let pr = prods;
    if (old) pr = stockApply(pr, old, -1);
    pr = stockApply(pr, nb, 1);
    if (pr !== prods) setProds(pr);
    setBills((l) => (old ? l.map((x) => (x.id === nb.id ? nb : x)) : [nb, ...l]));
    return nb;
  };
  const deleteBill = (id) => {
    const old = bills.find((x) => x.id === id);
    if (old) setProds((p) => stockApply(p, old, -1));
    setBills((l) => l.filter((x) => x.id !== id));
    flash('Deleted');
  };
  const sharePdf = async (b) => {
    try {
      const { uri } = await Print.printToFileAsync({ html: billHtml(b, cfg), width: 595, height: 842 });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: b.no });
      else flash('Sharing is not available on this device.');
    } catch (e) { flash('Could not create the PDF.'); }
  };
  const shareImage = async (b) => {
    try {
      setSnapB(b);
      await new Promise((r) => setTimeout(r, 600));
      const uri = await captureRef(snapRef, { format: 'png', quality: 1 });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: b.no });
      else flash('Sharing is not available on this device.');
    } catch (e) { flash('Could not create the photo.'); }
    setSnapB(null);
  };
  const remind = (name, phone, no, bal) => {
    sendWa(phone, reminderText(name, no, bal, cfg));
  };
  const applyBackup = (d) => {
    const merge = (cur, inc) => { const idx = new Map(cur.map((y, k) => [y.id, k])); const m = [...cur]; inc.forEach((x) => { if (idx.has(x.id)) m[idx.get(x.id)] = x; else { idx.set(x.id, m.length); m.push(x); } }); return m; };
    setBills((l) => merge(l, d.bills).sort((a, z) => (a.dt < z.dt ? 1 : -1)));
    setCusts((l) => merge(l, d.custs)); setProds((l) => merge(l, d.prods));
    if (Object.keys(d.cfg).length) setCfg((c) => ({ ...c, ...d.cfg }));
  };
  const applyPin = async (p) => { await savePin(p); setPinLen(p.length); };
  const dropPin = async () => { await removePin(); setPinLen(0); };
  const acceptTerms = async () => { try { await AsyncStorage.setItem('bb2_terms', TERMS_VERSION); } catch (e) { /* ignore */ } setTermsOk(true); };

  const X = { ins, C, cfg, setCfg, bills, setBills, custs, setCusts, prods, setProds, gstOn, flash, openEditor, editBill, duplicate, convert, saveBill, deleteBill, sharePdf, shareImage, remind, applyBackup, pinLen, applyPin, dropPin, openBill: (id) => setSheet(id) };

  if (!ready) return <View style={{ flex: 1, backgroundColor: C.bg }} />;

  const tabs = [['home', '🏠', 'Home'], ['bills', '🧾', 'Bills'], ['customers', '👥', 'Customers'], ['items', '📦', 'Items'], ['more', '⚙️', 'More']];
  const titles = { home: 'Dashboard', bills: 'Bills', customers: 'Customers', items: 'Items', more: 'More' };
  let body;
  if (locked) body = <Lock len={pinLen || 6} onOk={() => setLocked(false)} />;
  else if (!termsOk) body = <TermsGate onAccept={acceptTerms} />;
  else if (!cfg.name) body = <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 40 + ins.bottom }} keyboardShouldPersistTaps="handled"><ProfileForm first /></ScrollView>;
  else if (editor) body = <Editor key={editor.id} draft={editor} onClose={() => setEditor(null)} />;
  else body = (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4 }}>
        <Text style={{ color: C.ink, fontSize: 22, fontWeight: '700' }}>{titles[tab]}</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 90 }} keyboardShouldPersistTaps="handled">
        {tab === 'home' && <Home />}
        {tab === 'bills' && <Bills />}
        {tab === 'customers' && <Customers />}
        {tab === 'items' && <Items />}
        {tab === 'more' && <More />}
      </ScrollView>
      {!kb && (tab === 'home' || tab === 'bills') && (
        <TouchableOpacity onPress={() => openEditor('invoice')} activeOpacity={0.85}
          style={{ position: 'absolute', right: 16, bottom: 74 + ins.bottom, backgroundColor: C.btn, borderRadius: 28, paddingHorizontal: 20, paddingVertical: 14, elevation: 6 }}>
          <Text style={{ color: C.btnt, fontWeight: '700', fontSize: 15 }}>＋ New bill</Text>
        </TouchableOpacity>
      )}
      {!kb && (
        <View style={{ flexDirection: 'row', backgroundColor: C.paper, borderTopWidth: 1, borderColor: C.line, paddingTop: 6, paddingBottom: 8 + ins.bottom }}>
          {tabs.map(([k, ic, l]) => (
            <TouchableOpacity key={k} onPress={() => setTab(k)} style={{ flex: 1, alignItems: 'center' }}>
              <Text style={{ fontSize: 20, opacity: tab === k ? 1 : 0.5 }}>{ic}</Text>
              <Text style={{ fontSize: 11, color: tab === k ? C.g : C.mute, fontWeight: tab === k ? '700' : '400' }}>{l}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );

  return (
    <Ctx.Provider value={X}>
      <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: Math.max(ins.top, Constants.statusBarHeight || 0) }}>
        {body}
        {!locked && !!cfg.name && <BillSheet id={sheet} onClose={() => setSheet(null)} />}
        {!!snapB && (
          <View pointerEvents="none" style={{ position: 'absolute', left: -5000, top: 0 }}>
            <View ref={snapRef} collapsable={false} style={{ backgroundColor: '#fff' }}><SnapBill b={snapB} /></View>
          </View>
        )}
        {!!toast && (
          <View pointerEvents="none" style={{ position: 'absolute', bottom: 130 + ins.bottom, alignSelf: 'center', backgroundColor: '#000d', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20 }}>
            <Text style={{ color: '#fff' }}>{toast}</Text>
          </View>
        )}
      </View>
    </Ctx.Provider>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}
