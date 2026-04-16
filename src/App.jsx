import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { ocrReceiptFile } from "./ocrReceipt.js";
import { FEATURES } from "./featureFlags.js";

// ─── Constants ───────────────────────────────────────────────────────────────
const SCHEDULE_C = [
  { code: "L01", label: "Advertising", line: "8" },
  { code: "L02", label: "Car & truck expenses", line: "9" },
  { code: "L03", label: "Commissions & fees", line: "10" },
  { code: "L04", label: "Contract labor", line: "11" },
  { code: "L05", label: "Depletion", line: "12" },
  { code: "L06", label: "Depreciation (Section 179)", line: "13" },
  { code: "L07", label: "Employee benefit programs", line: "14" },
  { code: "L08", label: "Insurance (other than health)", line: "15" },
  { code: "L09", label: "Interest (mortgage)", line: "16a" },
  { code: "L10", label: "Interest (other)", line: "16b" },
  { code: "L11", label: "Legal & professional services", line: "17" },
  { code: "L12", label: "Office expense", line: "18" },
  { code: "L13", label: "Pension & profit-sharing", line: "19" },
  { code: "L14", label: "Rent (vehicles/equipment)", line: "20a" },
  { code: "L15", label: "Rent (other business property)", line: "20b" },
  { code: "L16", label: "Repairs & maintenance", line: "21" },
  { code: "L17", label: "Supplies", line: "22" },
  { code: "L18", label: "Taxes & licenses", line: "23" },
  { code: "L19", label: "Travel", line: "24a" },
  { code: "L20", label: "Meals (50%)", line: "24b" },
  { code: "L21", label: "Utilities", line: "25" },
  { code: "L22", label: "Wages", line: "26" },
  { code: "L23", label: "Other expenses", line: "27a" },
  { code: "L24", label: "Home office deduction", line: "30" },
];
const INC_CATS = [
  { code: "I01", label: "Gross receipts / sales", line: "1" },
  { code: "I02", label: "Returns & allowances", line: "2" },
  { code: "I03", label: "Other income", line: "6" },
];
const MILE_RATE = 0.70;
// Muted per-category color palette for Schedule C lines (WCAG AA on dark bg)
const CAT_COLORS = {
  L01: "#f97316", L02: "#f59e0b", L03: "#eab308", L04: "#84cc16",
  L05: "#22c55e", L06: "#10b981", L07: "#14b8a6", L08: "#06b6d4",
  L09: "#0ea5e9", L10: "#3b82f6", L11: "#6366f1", L12: "#8b5cf6",
  L13: "#a855f7", L14: "#d946ef", L15: "#ec4899", L16: "#f43f5e",
  L17: "#fb923c", L18: "#fbbf24", L19: "#a3e635", L20: "#4ade80",
  L21: "#34d399", L22: "#2dd4bf", L23: "#94a3b8", L24: "#c084fc",
};
const SE_RATE = 0.153;
const INV_ST = ["Draft", "Sent", "Viewed", "Paid", "Overdue"];

// ─── DB ──────────────────────────────────────────────────────────────────────
const DB = "OpenClawBooks";
const VER = 3;
const STORES = ["businesses", "transactions", "mileage", "invoices", "contractors", "goals"];
function openDB() {
  return new Promise((ok, no) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = (e) => { const db = e.target.result; STORES.forEach((s) => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" }); }); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}
async function getAll(s) { const db = await openDB(); return new Promise((ok, no) => { const t = db.transaction(s, "readonly"); const r = t.objectStore(s).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); }
async function put(s, o) { const db = await openDB(); return new Promise((ok, no) => { const t = db.transaction(s, "readwrite"); t.objectStore(s).put(o); t.oncomplete = () => ok(); t.onerror = () => no(t.error); }); }
async function del(s, id) { const db = await openDB(); return new Promise((ok, no) => { const t = db.transaction(s, "readwrite"); t.objectStore(s).delete(id); t.oncomplete = () => ok(); t.onerror = () => no(t.error); }); }

// ─── Utils ───────────────────────────────────────────────────────────────────
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const $ = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
function calcNextDue(fromDate, freq) {
  const [y, m, dd] = fromDate.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, dd));
  if (freq === 'weekly')       d.setUTCDate(d.getUTCDate() + 7);
  else if (freq === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (freq === 'yearly')  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}
// Sum monetary amounts in integer cents to avoid floating-point drift
const sumAmt = (arr, fn = (x) => x) => Math.round(arr.reduce((s, x) => s + Math.round(fn(x) * 100), 0)) / 100;
const td = () => new Date().toISOString().slice(0, 10);
const mn = (m) => ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1];

// ─── OCR ─────────────────────────────────────────────────────────────────────

// ─── Export ──────────────────────────────────────────────────────────────────
function makeTXF(txns, yr, bizName) {
  const lines = ["V042", `A${bizName || "OpenClaw Books"}`, `D${yr}-01-01`, "^"];
  const agg = {};
  txns.filter((t) => t.date?.startsWith(String(yr)) && t.scope !== "personal").forEach((t) => {
    const cats = t.type === "expense" ? SCHEDULE_C : INC_CATS;
    const cat = cats.find((c) => c.code === t.category);
    if (!cat) return;
    const k = `${t.type}-${cat.line}`;
    if (!agg[k]) agg[k] = { type: t.type, line: cat.line, label: cat.label, totalCents: 0 };
    agg[k].totalCents += Math.round(t.amount * 100);
  });
  Object.values(agg).forEach((a) => lines.push("TD", a.type === "income" ? "N521" : "N522", `C${a.line}`, `L${(a.totalCents / 100).toFixed(2)}`, `$${a.label}`, "^"));
  return lines.join("\r\n");
}
// CSV cell escaper. Defends against CSV injection (CWE-1236) where a malicious
// vendor name like "=cmd|'/c calc'!A1" would execute a formula when opened in
// Excel/Sheets. Prefixes formula triggers with a single quote and quotes any
// cell containing a delimiter or special character.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  // Formula-injection prefix — Excel, LibreOffice, and Google Sheets all treat
  // these as the start of a formula. Prefixing with a single quote forces them
  // to be interpreted as text.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  // Escape double quotes by doubling them, then wrap if the cell contains
  // anything that would break CSV row parsing.
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function csvRow(arr) { return arr.map(csvCell).join(','); }

function makeCSV(txns, yr) {
  const header = csvRow(["Date","Type","Category","Description","Amount","Vendor","Schedule C Line","Scope"]);
  const body = txns.filter((t) => t.date?.startsWith(String(yr))).map((t) => {
    const c = [...SCHEDULE_C, ...INC_CATS].find((c) => c.code === t.category);
    return csvRow([t.date, t.type, c?.label || "", t.description || "", t.amount.toFixed(2), t.vendor || "", c?.line || "", t.scope || "business"]);
  }).join("\n");
  return header + "\n" + body;
}
function dlFile(c, n, m) {
  const url = URL.createObjectURL(new Blob([c], { type: m }));
  const a = document.createElement("a");
  a.href = url; a.download = n; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Icons ───────────────────────────────────────────────────────────────────
function I({ name, size = 18 }) {
  const p = { home: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z", dollar: "M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6", receipt: "M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z", car: "M16 3h-2l-2 4H6L4 3H2M5 14h14l1-5H4zM7 17a1 1 0 100 2 1 1 0 000-2zM17 17a1 1 0 100 2 1 1 0 000-2z", file: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z", users: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75", target: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 18a6 6 0 100-12 6 6 0 000 12zM12 14a2 2 0 100-4 2 2 0 000 4z", chart: "M18 20V10M12 20V4M6 20v-6", download: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3", plus: "M12 5v14M5 12h14", x: "M18 6 6 18M6 6l12 12", check: "M20 6 9 17l-5-5", trash: "M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14", edit: "M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z",send: "M22 2L11 13M22 2l-7 20-4-9-9-4z", calendar: "M19 4H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2zM16 2v4M8 2v4M3 10h18", search: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z", tag: "M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82zM7 7h.01", pie: "M21.21 15.89A10 10 0 118 2.83M22 12A10 10 0 0012 2v10z", building: "M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01", chevDown: "M6 9l6 6 6-6", settings: "M12 15a3 3 0 100-6 3 3 0 000 6z" };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={p[name] || p.file} /></svg>;
}

// ─── Shared UI ───────────────────────────────────────────────────────────────
const inp = { background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: "9px 12px", color: "#e2e8f0", fontSize: 13, outline: "none", fontFamily: "'DM Sans',sans-serif", width: "100%" };
function Btn({ children, onClick, v = "primary", disabled, s: s2 }) {
  const base = { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, border: "none", cursor: disabled ? "default" : "pointer", fontSize: 13, fontWeight: 600, fontFamily: "'DM Sans',sans-serif", opacity: disabled ? 0.5 : 1, transition: "all .15s" };
  const vs = { primary: { background: "linear-gradient(135deg,#3b82f6,#2563eb)", color: "#fff" }, green: { background: "linear-gradient(135deg,#22c55e,#16a34a)", color: "#fff" }, ghost: { background: "transparent", border: "1px solid #334155", color: "#94a3b8" }, danger: { background: "rgba(239,68,68,.15)", border: "1px solid rgba(239,68,68,.3)", color: "#f87171" }, purple: { background: "rgba(139,92,246,.15)", border: "1px solid #8b5cf6", color: "#c4b5fd" } };
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...vs[v], ...s2 }}>{children}</button>;
}
function Card({ children, style: s2, accent }) { return <div style={{ background: "rgba(30,41,59,.6)", borderRadius: 12, padding: 20, border: "1px solid rgba(255,255,255,.04)", backdropFilter: "blur(8px)", borderLeft: accent ? `4px solid ${accent}` : undefined, ...s2 }}>{children}</div>; }
function Stat({ label, value, color, icon }) { return <Card accent={color}><div style={{ fontSize: 11, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}><I name={icon} size={14} />{label}</div><div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color }}>{value}</div></Card>; }
function Modal({ title, onClose, children, w = 520 }) {
  return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300, padding: 16 }} onClick={onClose}>
    <div style={{ background: "#1e293b", borderRadius: 16, width: "100%", maxWidth: w, border: "1px solid rgba(255,255,255,.08)", boxShadow: "0 24px 48px rgba(0,0,0,.4)", maxHeight: "90vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px", borderBottom: "1px solid rgba(255,255,255,.06)", flexShrink: 0 }}>
        <h3 style={{ margin: 0, fontSize: 17, color: "#f9fafb" }}>{title}</h3>
        <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#94a3b8", cursor: "pointer", padding: 4 }}><I name="x" size={20} /></button>
      </div>
      <div style={{ padding: 24, overflowY: "auto", flex: 1 }}>{children}</div>
    </div>
  </div>;
}
function Field({ label, children, span }) { return <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: span ? "1/-1" : undefined }}><span style={{ fontSize: 11, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: .5 }}>{label}</span>{children}</label>; }
function Empty({ icon, text }) { return <div style={{ textAlign: "center", padding: "48px 20px", color: "#475569" }}><I name={icon} size={44} /><p style={{ marginTop: 12, color: "#9ca3af", fontSize: 14 }}>{text}</p></div>; }
function Badge({ children, color = "#3b82f6" }) { return <span style={{ display: "inline-block", padding: "3px 8px", borderRadius: 6, fontSize: 11, background: `${color}20`, color, fontWeight: 500 }}>{children}</span>; }
function PBar({ value, max, color = "#3b82f6" }) { const p = max > 0 ? Math.min((value / max) * 100, 100) : 0; return <div style={{ height: 6, background: "rgba(255,255,255,.06)", borderRadius: 3, overflow: "hidden" }}><div style={{ height: "100%", width: `${p}%`, background: `linear-gradient(90deg,${color},${color}cc)`, borderRadius: 3, transition: "width .4s" }} /></div>; }

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
// ─── ERROR BOUNDARY ───────────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(err) { return { error: err }; }
  componentDidCatch(err, info) { console.error('[ErrorBoundary] Render crash:', err, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    const msg = this.state.error?.message || String(this.state.error);
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0f0f1a", padding: 32 }}>
        <div style={{ maxWidth: 520, width: "100%", background: "#1e293b", borderRadius: 16, border: "1px solid rgba(239,68,68,.3)", padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>💥</div>
          <h2 style={{ color: "#f87171", fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Something crashed</h2>
          <p style={{ color: "#94a3b8", fontSize: 13, marginBottom: 20 }}>An unexpected error caused the app to stop rendering. Your data is safe.</p>
          <div style={{ background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.2)", borderRadius: 8, padding: "10px 14px", fontSize: 12, color: "#fca5a5", fontFamily: "'JetBrains Mono',monospace", textAlign: "left", marginBottom: 24, wordBreak: "break-word" }}>{msg}</div>
          <button onClick={() => this.setState({ error: null })} style={{ padding: "8px 24px", background: "#3b82f6", border: "none", borderRadius: 8, color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: 14, marginRight: 10 }}>Try Again</button>
          <button onClick={() => window.location.reload()} style={{ padding: "8px 24px", background: "transparent", border: "1px solid #334155", borderRadius: 8, color: "#94a3b8", fontWeight: 600, cursor: "pointer", fontSize: 14 }}>Reload App</button>
        </div>
      </div>
    );
  }
}

// ─── ERROR TOAST ──────────────────────────────────────────────────────────────
function ErrorToast({ message, onDismiss }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 10000);
    return () => clearTimeout(t);
  }, [message, onDismiss]);
  return (
    <div style={{ position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)", zIndex: 9999, display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 18px", background: "#1e1e2e", border: "1px solid rgba(239,68,68,.5)", borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,.6)", maxWidth: 500, width: "calc(100vw - 40px)" }}>
      <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#f87171", marginBottom: 2 }}>Unexpected Error</div>
        <div style={{ fontSize: 12, color: "#94a3b8", wordBreak: "break-word" }}>{message}</div>
      </div>
      <button type="button" onClick={onDismiss} style={{ background: "transparent", border: "none", color: "#64748b", cursor: "pointer", fontSize: 18, lineHeight: 1, flexShrink: 0, padding: 0 }}>×</button>
    </div>
  );
}

function App() {
  const [businesses, setBusinesses] = useState([]);
  const [bizId, setBizId] = useState(null);
  const [txns, setTxns] = useState([]);
  const [miles, setMiles] = useState([]);
  const [invs, setInvs] = useState([]);
  const [cons, setCons] = useState([]);
  const [goals, setGoals] = useState([]);
  const [view, setView] = useState("dashboard");
  const [modal, setModal] = useState(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(true);
  const [searchQ, setSearchQ] = useState("");
  const [bizMenuOpen, setBizMenuOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);       // { version, downloaded, percent }
  const [installing, setInstalling] = useState(false);      // true while waiting for app to restart
  const [showSettings, setShowSettings] = useState(false);
  const [checkStatus, setCheckStatus] = useState("idle"); // idle | checking | up-to-date | error
  const [appVersion, setAppVersion] = useState("");
  const [globalError, setGlobalError] = useState(null);
  const [successToast, setSuccessToast] = useState(null); // { msg, count }
  const recurringChecked = useRef(null); // tracks last bizId processed so we run once per session per biz

  const reload = useCallback(async () => {
    const [b, t, m, i, c, g] = await Promise.all([getAll("businesses"), getAll("transactions"), getAll("mileage"), getAll("invoices"), getAll("contractors"), getAll("goals")]);
    setBusinesses(b.sort((a, b) => (a.name || "").localeCompare(b.name || "")));
    setTxns(t.sort((a, b) => (b.date || "").localeCompare(a.date || "")));
    setMiles(m.sort((a, b) => (b.date || "").localeCompare(a.date || "")));
    setInvs(i.sort((a, b) => (b.date || "").localeCompare(a.date || "")));
    setCons(c.sort((a, b) => (a.name || "").localeCompare(b.name || "")));
    setGoals(g);
    if (!bizId && b.length > 0) setBizId(b[0].id);
    setLoading(false);
  }, [bizId]);
  useEffect(() => { reload(); }, [reload]);

  // Global error handlers — catch unhandled JS errors and promise rejections
  useEffect(() => {
    const onError = (e) => {
      const msg = e.error?.message || e.message || 'An unexpected error occurred';
      console.error('[GlobalError]', msg, e.error);
      setGlobalError(msg);
    };
    const onUnhandled = (e) => {
      const msg = e.reason?.message || String(e.reason) || 'Unhandled async error';
      console.error('[UnhandledRejection]', msg, e.reason);
      setGlobalError(msg);
      e.preventDefault();
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandled);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandled);
    };
  }, []);

  // ── Recurring transaction auto-create ─────────────────────────────────────
  // Catches up missed instances: if a monthly recurring was last due 3 months
  // ago, this creates 3 instances and advances nextDue past today.
  useEffect(() => {
    if (loading || !bizId || recurringChecked.current === bizId) return;
    recurringChecked.current = bizId;
    const today = td();
    const due = bTxns.filter((t) => t.recurring?.freq && t.recurring?.nextDue && t.recurring.nextDue <= today);
    if (due.length === 0) return;
    (async () => {
      const created = [];
      try {
        for (const tpl of due) {
          const { recurring, receiptFile, ...rest } = tpl;
          let cursor = recurring.nextDue;
          // Catch-up loop — generate one instance per missed period, capped at 60
          // to prevent runaway loops if data is corrupt.
          let safety = 0;
          while (cursor <= today && safety < 60) {
            const instance = { ...rest, id: uid(), date: cursor, recurring: null };
            await put('transactions', instance);
            created.push(`${tpl.vendor || tpl.description} (${$(tpl.amount)}) — ${cursor}`);
            cursor = calcNextDue(cursor, recurring.freq);
            safety++;
          }
          // Persist the advanced nextDue on the template
          await put('transactions', { ...tpl, recurring: { ...recurring, nextDue: cursor } });
        }
        reload();
        if (created.length) {
          setSuccessToast({ msg: `${created.length} recurring transaction${created.length > 1 ? 's' : ''} auto-added`, items: created });
        }
      } catch (e) {
        console.error('[recurring] auto-create failed:', e);
        // Reset guard so user can retry by switching businesses or reloading
        recurringChecked.current = null;
        setGlobalError?.('Recurring auto-create failed: ' + (e.message || String(e)));
      }
    })();
  }, [loading, bizId]);

  // Auto-updater events via preload
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.getAppVersion().then(setAppVersion).catch(() => {});
    window.electronAPI.onUpdateAvailable((info) => { setUpdateInfo({ version: info.version, downloaded: false, percent: 0 }); setCheckStatus("idle"); });
    window.electronAPI.onUpdateNotAvailable(() => setCheckStatus("up-to-date"));
    window.electronAPI.onUpdateDownloaded((info) => setUpdateInfo((u) => ({ ...u, version: info.version, downloaded: true })));
    window.electronAPI.onUpdateProgress((p) => setUpdateInfo((u) => u ? { ...u, percent: Math.round(p.percent) } : u));
    window.electronAPI.onUpdateError(() => setCheckStatus((s) => s === "checking" ? "error" : s));
    return () => window.electronAPI.removeUpdateListeners();
  }, []);

  const biz = businesses.find((b) => b.id === bizId);
  const bTxns = useMemo(() => txns.filter((t) => t.bizId === bizId), [txns, bizId]);
  const bMiles = useMemo(() => miles.filter((m) => m.bizId === bizId), [miles, bizId]);
  const bInvs = useMemo(() => invs.filter((i) => i.bizId === bizId), [invs, bizId]);
  const bCons = useMemo(() => cons.filter((c) => c.bizId === bizId), [cons, bizId]);
  const bGoals = useMemo(() => goals.filter((g) => g.bizId === bizId), [goals, bizId]);
  const yTxns = useMemo(() => bTxns.filter((t) => t.date?.startsWith(String(year))), [bTxns, year]);
  const yMiles = useMemo(() => bMiles.filter((m) => m.date?.startsWith(String(year))), [bMiles, year]);
  const yInvs = useMemo(() => bInvs.filter((i) => i.date?.startsWith(String(year))), [bInvs, year]);
  const bizOnly = useMemo(() => yTxns.filter((t) => t.scope !== "personal"), [yTxns]);
  const totInc = useMemo(() => sumAmt(bizOnly.filter((t) => t.type === "income"), (t) => t.amount), [bizOnly]);
  const totExp = useMemo(() => sumAmt(bizOnly.filter((t) => t.type === "expense"), (t) => t.amount), [bizOnly]);
  const mileDed = useMemo(() => sumAmt(yMiles, (m) => m.miles * MILE_RATE), [yMiles]);
  const net = totInc - totExp - mileDed;
  const seTax = Math.max(0, net * 0.9235 * SE_RATE);
  const qEst = seTax / 4;
  const years = [...new Set(bTxns.map((t) => parseInt(t.date?.slice(0, 4))))].filter(Boolean).sort((a, b) => b - a);
  if (!years.includes(year)) years.unshift(year);

  const close = () => setModal(null);

  if (!loading && businesses.length === 0) {
    return <Onboarding onDone={async (name, ein, type) => { await put("businesses", { id: uid(), name, ein, type, color: "#3b82f6", created: td() }); reload(); }} />;
  }
  if (!loading && !bizId && businesses.length > 0) { setBizId(businesses[0].id); return null; }

  const NAV = [
    { id: "dashboard", icon: "home", label: "Dashboard" },
    { id: "income", icon: "dollar", label: "Income" },
    { id: "expenses", icon: "receipt", label: "Expenses" },
    { id: "mileage", icon: "car", label: "Mileage" },
    { id: "invoices", icon: "send", label: "Invoices" },
    { id: "contractors", icon: "users", label: "1099" },
    { id: "reports", icon: "pie", label: "Reports" },
    { id: "goals", icon: "target", label: "Goals" },
    { id: "export", icon: "download", label: "Export" },
  ];
  const bc = biz?.color || "#3b82f6";

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: "linear-gradient(145deg,#0f0f1a,#1a1a2e 50%,#16213e)", color: "#e2e8f0", minHeight: "100vh", fontSize: 14 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=DM+Sans:wght@400;500;600;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:#1a1a2e}::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}input[type="date"]::-webkit-calendar-picker-indicator{filter:invert(.7)}@keyframes spin{to{transform:rotate(360deg)}}@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      {/* HEADER */}
      <header style={{ background: "rgba(15,15,26,.92)", backdropFilter: "blur(12px)", borderBottom: "1px solid rgba(255,255,255,.06)", padding: "10px 20px", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", maxWidth: 1200, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(135deg,${bc},${bc}99)`, color: "#fff", transition: "background .3s" }}><I name="receipt" size={18} /></div>
            <div><div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 2, color: "#f9fafb", lineHeight: 1.2 }}>OPENCLAW BOOKS</div><div style={{ fontSize: 10, color: "#64748b", letterSpacing: .5 }}>Schedule C · Self-Employed</div></div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {/* BIZ SWITCHER */}
            <div style={{ position: "relative" }}>
              <button onClick={() => setBizMenuOpen(!bizMenuOpen)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, border: "1px solid #334155", background: "rgba(30,41,59,.8)", color: "#e2e8f0", cursor: "pointer", fontSize: 13, fontFamily: "'DM Sans',sans-serif", maxWidth: 220 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: bc, flexShrink: 0 }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{biz?.name || "Select"}</span>
                <I name="chevDown" size={14} />
              </button>
              {bizMenuOpen && <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, background: "#1e293b", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,.5)", minWidth: 240, zIndex: 200, overflow: "hidden" }}>
                <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,.06)", fontSize: 10, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: 1 }}>Your Businesses</div>
                {businesses.map((b) => (
                  <button key={b.id} onClick={() => { setBizId(b.id); setBizMenuOpen(false); setView("dashboard"); }} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 14px", border: "none", background: b.id === bizId ? "rgba(59,130,246,.1)" : "transparent", color: b.id === bizId ? "#60a5fa" : "#d1d5db", cursor: "pointer", fontSize: 13, fontFamily: "'DM Sans',sans-serif", textAlign: "left" }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: b.color || "#3b82f6", flexShrink: 0 }} />
                    <div style={{ flex: 1 }}><div style={{ fontWeight: 500 }}>{b.name}</div>{b.type && <div style={{ fontSize: 10, color: "#64748b" }}>{b.type}</div>}</div>
                    {b.id === bizId && <I name="check" size={14} />}
                  </button>
                ))}
                <div style={{ borderTop: "1px solid rgba(255,255,255,.06)" }}>
                  <button onClick={() => { setBizMenuOpen(false); setModal({ t: "biz", d: {} }); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "10px 14px", border: "none", background: "transparent", color: "#22c55e", cursor: "pointer", fontSize: 13, fontFamily: "'DM Sans',sans-serif" }}><I name="plus" size={14} /> Add Business</button>
                  <button onClick={() => { setBizMenuOpen(false); setModal({ t: "biz-manage" }); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "10px 14px", border: "none", background: "transparent", color: "#94a3b8", cursor: "pointer", fontSize: 13, fontFamily: "'DM Sans',sans-serif" }}><I name="settings" size={14} /> Manage</button>
                </div>
              </div>}
            </div>
            <input placeholder="Search..." value={searchQ} onChange={(e) => setSearchQ(e.target.value)} style={{ ...inp, width: 130, paddingLeft: 8, fontSize: 12, background: "#111827" }} />
            <select value={year} onChange={(e) => setYear(+e.target.value)} style={{ ...inp, width: 80, fontSize: 12, background: "#111827", cursor: "pointer" }}>{years.map((y) => <option key={y}>{y}</option>)}</select>
            <button onClick={() => setShowSettings(true)} title="Settings" style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: 8, border: "1px solid #334155", background: "rgba(30,41,59,.8)", color: "#94a3b8", cursor: "pointer" }}>
              <I name="settings" size={16} />
              {updateInfo?.downloaded && <span style={{ position: "absolute", top: 4, right: 4, width: 7, height: 7, borderRadius: "50%", background: "#22c55e", border: "2px solid #0f0f1a" }} />}
            </button>
          </div>
        </div>
      </header>
      {/* Update notification banner */}
      {updateInfo && <div style={{ background: "linear-gradient(90deg,#1e3a5f,#1a3050)", borderBottom: "1px solid #2a5580", padding: "8px 20px", display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
        <span>🔄</span>
        {(updateInfo.downloaded || updateInfo.percent >= 99)
          ? <><span>Version <strong>{updateInfo.version}</strong> ready to install</span>{installing ? <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ fontSize: 12, color: "#93c5fd" }}>Preparing to restart…</span><div style={{ width: 80, height: 4, background: "#0f2040", borderRadius: 2, overflow: "hidden" }}><div style={{ height: "100%", width: "100%", background: "linear-gradient(90deg,#3b82f6 0%,#93c5fd 50%,#3b82f6 100%)", backgroundSize: "200% 100%", animation: "shimmer 1.2s linear infinite", borderRadius: 2 }} /></div></div> : <button type="button" onClick={() => { setInstalling(true); window.electronAPI?.installUpdate(); }} style={{ background: "#3b82f6", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", padding: "4px 12px", fontSize: 12, fontWeight: 600 }}>Restart &amp; Install</button>}</>
          : <><span>Version <strong>{updateInfo.version}</strong> downloading… {updateInfo.percent > 0 && `${updateInfo.percent}%`}</span><div style={{ flex: 1, maxWidth: 120, height: 4, background: "#0f2040", borderRadius: 2, overflow: "hidden" }}><div style={{ height: "100%", width: `${updateInfo.percent}%`, background: "#3b82f6", transition: "width .3s" }} /></div></>
        }
        <button onClick={() => setUpdateInfo(null)} style={{ marginLeft: "auto", background: "transparent", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
      </div>}
      {bizMenuOpen && <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={() => setBizMenuOpen(false)} />}

      <nav style={{ display: "flex", gap: 1, padding: "6px 20px", maxWidth: 1200, margin: "0 auto", overflowX: "auto", borderBottom: "1px solid rgba(255,255,255,.03)" }}>
        {NAV.map((n) => <button key={n.id} onClick={() => setView(n.id)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 12px", borderRadius: 7, border: "none", background: view === n.id ? `${bc}22` : "transparent", color: view === n.id ? bc : "#94a3b8", cursor: "pointer", fontSize: 12, fontWeight: 500, fontFamily: "'DM Sans',sans-serif", whiteSpace: "nowrap", transition: "all .15s" }}><I name={n.icon} size={15} />{n.label}</button>)}
      </nav>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "20px 20px 80px" }}>
        {loading ? <div style={{ display: "flex", justifyContent: "center", padding: 80 }}><div style={{ width: 32, height: 32, border: `3px solid #334155`, borderTopColor: bc, borderRadius: "50%", animation: "spin .8s linear infinite" }} /></div>
        : view === "dashboard" ? <Dash {...{ bizOnly, yTxns, totInc, totExp, net, mileDed, seTax, qEst, yMiles, yInvs, year, bGoals, bc, setView }} />
        : view === "income" ? <TxnList type="income" txns={yTxns} searchQ={searchQ} onAdd={() => setModal({ t: "txn", d: { type: "income", prefill: {} } })} onImportCSV={() => setModal({ t: "csv-import" })} onEdit={(t) => setModal({ t: "txn", d: { type: "income", prefill: t, editId: t.id } })} onDelete={async (id) => { await del("transactions", id); reload(); }} bc={bc} />
        : view === "expenses" ? <TxnList type="expense" txns={yTxns} searchQ={searchQ} onAdd={() => setModal({ t: "txn", d: { type: "expense", prefill: {} } })} onBatchScan={() => setModal({ t: "batch-scan" })} onImportCSV={() => setModal({ t: "csv-import" })} onEdit={(t) => setModal({ t: "txn", d: { type: "expense", prefill: t, editId: t.id } })} onDelete={async (id) => { await del("transactions", id); reload(); }} bc={bc} />
        : view === "mileage" ? <MileV trips={yMiles} rate={MILE_RATE} onAdd={() => setModal({ t: "mile", d: {} })} onEdit={(m) => setModal({ t: "mile", d: { ...m, editId: m.id } })} onDelete={async (id) => { await del("mileage", id); reload(); }} bc={bc} />
        : view === "invoices" ? <InvV invoices={yInvs} onAdd={() => setModal({ t: "inv", d: {} })} onEdit={(i) => setModal({ t: "inv", d: { ...i, editId: i.id } })} onDelete={async (id) => { await del("invoices", id); reload(); }} reload={reload} bc={bc} />
        : view === "contractors" ? <ConV contractors={bCons} txns={yTxns} onAdd={() => setModal({ t: "con", d: {} })} onEdit={(c) => setModal({ t: "con", d: { ...c, editId: c.id } })} onDelete={async (id) => { await del("contractors", id); reload(); }} bc={bc} />
        : view === "reports" ? <Reps txns={bizOnly} miles={yMiles} year={year} totInc={totInc} totExp={totExp} net={net} mileDed={mileDed} seTax={seTax} bc={bc} />
        : view === "goals" ? <GoalsV goals={bGoals} totInc={totInc} net={net} year={year} onAdd={() => setModal({ t: "goal", d: {} })} onDelete={async (id) => { await del("goals", id); reload(); }} bc={bc} />
        : <ExpV txns={bTxns} year={year} yTxns={yTxns} miles={bMiles} totInc={totInc} totExp={totExp} mileDed={mileDed} biz={biz} bc={bc} />
        }
      </main>
      {modal?.t === "batch-scan" && <BatchScanModal bizId={bizId} onSave={async (t) => { await put("transactions", t); }} onDone={() => { reload(); close(); }} onClose={close} />}
      {modal?.t === "csv-import" && <CsvImportModal bizId={bizId} onSave={async (t) => { await put("transactions", t); }} onDone={(count, failures) => { reload(); setSuccessToast({ msg: `${count} transaction${count !== 1 ? "s" : ""} imported from CSV${failures && failures.length ? ` (${failures.length} skipped)` : ""}`, items: [] }); if (failures && failures.length) setGlobalError(`${failures.length} row${failures.length !== 1 ? "s" : ""} could not be imported. First error: ${failures[0]}`); close(); }} onClose={close} />}
      {modal?.t === "txn" && <TxnForm {...modal.d} bizId={bizId} bCons={bCons} onSave={async (t) => { await put("transactions", t); reload(); close(); }} onClose={close} />}
      {modal?.t === "mile" && <MileForm {...modal.d} bizId={bizId} onSave={async (m) => { await put("mileage", m); reload(); close(); }} onClose={close} />}
      {modal?.t === "inv" && <InvForm {...modal.d} bizId={bizId} onSave={async (i) => { await put("invoices", i); reload(); close(); }} onClose={close} />}
      {modal?.t === "con" && <ConForm {...modal.d} bizId={bizId} onSave={async (c) => { await put("contractors", c); reload(); close(); }} onClose={close} />}
      {modal?.t === "goal" && <GoalForm bizId={bizId} onSave={async (g) => { await put("goals", g); reload(); close(); }} onClose={close} />}
      {modal?.t === "biz" && <BizForm {...modal.d} onSave={async (b) => { await put("businesses", b); if (!bizId) setBizId(b.id); reload(); close(); }} onClose={close} />}
      {modal?.t === "biz-manage" && <BizManage businesses={businesses} currentId={bizId} onSwitch={(id) => { setBizId(id); close(); setView("dashboard"); }} onEdit={(b) => { close(); setTimeout(() => setModal({ t: "biz", d: { ...b, editId: b.id } }), 50); }} onDelete={async (id) => { await del("businesses", id); if (bizId === id) { const r = businesses.filter((b) => b.id !== id); setBizId(r[0]?.id || null); } reload(); close(); }} onClose={close} />}
      {showSettings && (
        <SettingsModal
          appVersion={appVersion}
          updateInfo={updateInfo}
          checkStatus={checkStatus}
          onCheckForUpdate={() => {
            if (!window.electronAPI) return;
            setCheckStatus("checking");
            window.electronAPI.checkForUpdate();
          }}
          installing={installing}
          onInstall={() => { setInstalling(true); window.electronAPI?.installUpdate(); }}
          onClose={() => setShowSettings(false)}
        />
      )}
      {globalError && <ErrorToast message={globalError} onDismiss={() => setGlobalError(null)} />}
      {successToast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 9999, background: "rgba(20,40,20,.97)", border: "1px solid #22c55e", borderRadius: 10, padding: "12px 18px", maxWidth: 420, width: "90vw", display: "flex", alignItems: "flex-start", gap: 12, boxShadow: "0 8px 32px rgba(0,0,0,.6)" }}>
          <span style={{ fontSize: 18, flexShrink: 0 }}>🔁</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#4ade80", marginBottom: 4 }}>{successToast.msg}</div>
            {successToast.items?.map((item, i) => <div key={i} style={{ fontSize: 11, color: "#94a3b8" }}>• {item}</div>)}
          </div>
          <button onClick={() => setSuccessToast(null)} style={{ background: "transparent", border: "none", color: "#64748b", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 0, flexShrink: 0 }}>×</button>
        </div>
      )}
    </div>
  );
}

// Wrap with ErrorBoundary so render crashes show a recovery screen
const _AppWithBoundary = () => <ErrorBoundary><App /></ErrorBoundary>;
// Re-export as default so index.jsx still works
export { _AppWithBoundary as default };

// ─── ONBOARDING ──────────────────────────────────────────────────────────────
function Onboarding({ onDone }) {
  const [name, setName] = useState("");
  const [ein, setEin] = useState("");
  const [type, setType] = useState("Sole Proprietorship");
  return <div style={{ fontFamily: "'DM Sans',sans-serif", background: "linear-gradient(145deg,#0f0f1a,#1a1a2e 50%,#16213e)", color: "#e2e8f0", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
    <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=DM+Sans:wght@400;500;600;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
    <Card style={{ maxWidth: 460, width: "100%", padding: 32 }}>
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <div style={{ width: 56, height: 56, borderRadius: 14, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg,#3b82f6,#8b5cf6)", color: "#fff", marginBottom: 12 }}><I name="building" size={28} /></div>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: "#f9fafb", marginBottom: 4 }}>Welcome to OpenClaw Books</h2>
        <p style={{ color: "#94a3b8", fontSize: 14 }}>Set up your first business to get started.</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Business Name"><input placeholder="e.g. OpenClaw LLC" value={name} onChange={(e) => setName(e.target.value)} style={inp} /></Field>
        <Field label="EIN (optional)"><input placeholder="XX-XXXXXXX" value={ein} onChange={(e) => setEin(e.target.value)} style={inp} /></Field>
        <Field label="Business Type"><select value={type} onChange={(e) => setType(e.target.value)} style={inp}>{["Sole Proprietorship", "Single-Member LLC", "Freelance / Independent Contractor", "Side Hustle / Gig Work", "Other"].map((t) => <option key={t}>{t}</option>)}</select></Field>
      </div>
      <Btn onClick={() => { if (name.trim()) onDone(name.trim(), ein, type); }} s={{ width: "100%", justifyContent: "center", marginTop: 20, padding: "12px 24px" }} disabled={!name.trim()}><I name="check" size={16} /> Create Business & Start</Btn>
    </Card>
  </div>;
}

// ─── BIZ FORM / MANAGE ──────────────────────────────────────────────────────
const COLORS = ["#3b82f6", "#8b5cf6", "#22c55e", "#ef4444", "#f59e0b", "#06b6d4", "#ec4899", "#f97316"];
function BizForm({ editId, name: n, ein: e, type: t, color: c, onSave, onClose }) {
  const [f, setF] = useState({ name: n || "", ein: e || "", type: t || "Sole Proprietorship", color: c || COLORS[Math.floor(Math.random() * COLORS.length)] });
  return <Modal title={editId ? "Edit Business" : "Add Business"} onClose={onClose} w={440}>
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Field label="Business Name"><input placeholder="My Side Hustle" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={inp} /></Field>
      <Field label="EIN (optional)"><input placeholder="XX-XXXXXXX" value={f.ein} onChange={(e) => setF({ ...f, ein: e.target.value })} style={inp} /></Field>
      <Field label="Business Type"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} style={inp}>{["Sole Proprietorship", "Single-Member LLC", "Freelance / Independent Contractor", "Side Hustle / Gig Work", "Other"].map((t) => <option key={t}>{t}</option>)}</select></Field>
      <Field label="Color"><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{COLORS.map((c) => <button key={c} onClick={() => setF({ ...f, color: c })} style={{ width: 28, height: 28, borderRadius: 7, background: c, border: f.color === c ? "2px solid #fff" : "2px solid transparent", cursor: "pointer" }} />)}</div></Field>
    </div>
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}><Btn v="ghost" onClick={onClose}>Cancel</Btn><Btn v="green" onClick={() => { if (f.name.trim()) onSave({ id: editId || uid(), ...f, created: td() }); }}><I name="check" size={15} /> {editId ? "Update" : "Create"}</Btn></div>
  </Modal>;
}
function BizManage({ businesses, currentId, onSwitch, onEdit, onDelete, onClose }) {
  return <Modal title="Manage Businesses" onClose={onClose} w={500}>
    {businesses.map((b) => <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
      <div style={{ width: 10, height: 10, borderRadius: "50%", background: b.color || "#3b82f6", flexShrink: 0 }} />
      <div style={{ flex: 1 }}><div style={{ fontWeight: 600, color: "#f1f5f9", fontSize: 14 }}>{b.name} {b.id === currentId && <Badge color="#22c55e">Active</Badge>}</div><div style={{ fontSize: 11, color: "#64748b" }}>{b.type}{b.ein ? ` · EIN: •••${b.ein.slice(-4)}` : ""}</div></div>
      <div style={{ display: "flex", gap: 4 }}>
        {b.id !== currentId && <Btn v="ghost" onClick={() => onSwitch(b.id)} s={{ padding: "5px 10px", fontSize: 11 }}>Switch</Btn>}
        <button onClick={() => onEdit(b)} style={{ background: "transparent", border: "none", color: "#94a3b8", cursor: "pointer", padding: 4 }}><I name="edit" size={14} /></button>
        {businesses.length > 1 && <button onClick={() => onDelete(b.id)} style={{ background: "transparent", border: "none", color: "#ef4444", cursor: "pointer", padding: 4 }}><I name="trash" size={14} /></button>}
      </div>
    </div>)}
  </Modal>;
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function DonutChart({ slices, size = 150, thickness = 30 }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (!total) return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: "rgba(255,255,255,.05)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span style={{ color: "#475569", fontSize: 11 }}>No data</span>
    </div>
  );
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  let angle = -Math.PI / 2;
  const paths = slices.filter(s => s.value > 0).map((s, i) => {
    const sweep = (s.value / total) * 2 * Math.PI;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    angle += sweep;
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;
    return { d: `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`, color: s.color, key: i };
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {paths.map(p => <path key={p.key} d={p.d} fill={p.color} opacity={0.85} />)}
      <circle cx={cx} cy={cy} r={r - thickness / 2} fill="#0f0f1a" />
    </svg>
  );
}

function Dash({ bizOnly, yTxns, totInc, totExp, net, mileDed, seTax, qEst, yMiles, yInvs, year, bGoals, bc, setView }) {
  // ── Monthly bar data
  const monthly = {};
  for (let m = 1; m <= 12; m++) {
    const k = `${year}-${String(m).padStart(2, "0")}`;
    monthly[k] = { income: 0, expense: 0 };
  }
  bizOnly.forEach((t) => { const k = t.date?.slice(0, 7); if (monthly[k]) monthly[k][t.type] += t.amount; });
  const mArr = Object.entries(monthly);
  const maxM = Math.max(...mArr.map(([, v]) => Math.max(v.income, v.expense)), 1);

  // ── Expense by category (donut + top list)
  const expByCat = {};
  bizOnly.filter((t) => t.type === "expense").forEach((t) => {
    const key = SCHEDULE_C.find((c) => c.code === t.category) ? t.category : "L23";
    expByCat[key] = (expByCat[key] || 0) + t.amount;
  });
  const donutSlices = Object.entries(expByCat)
    .map(([code, value]) => ({ color: CAT_COLORS[code] || "#94a3b8", value, label: SCHEDULE_C.find((c) => c.code === code)?.label || "Other", code }))
    .sort((a, b) => b.value - a.value);
  const topCats = donutSlices.slice(0, 8);

  // ── Export readiness
  const expTxns = bizOnly.filter((t) => t.type === "expense");
  const uncatCount = expTxns.filter((t) => !SCHEDULE_C.find((c) => c.code === t.category)).length;
  const readinessPct = expTxns.length === 0 ? 100 : Math.round(((expTxns.length - uncatCount) / expTxns.length) * 100);

  // ── Quarterly deadline
  const today = td();
  const qDue = [
    [`${year}-04-15`, "Q1", `Apr 15, ${year}`],
    [`${year}-06-15`, "Q2", `Jun 15, ${year}`],
    [`${year}-09-15`, "Q3", `Sep 15, ${year}`],
    [`${year + 1}-01-15`, "Q4", `Jan 15, ${year + 1}`],
  ];
  const nextQ = qDue.find(([d]) => d >= today) || qDue[3];
  const daysUntil = Math.ceil((new Date(nextQ[0]) - new Date(today)) / 86400000);
  const unpaid = yInvs.filter((i) => i.status !== "Paid");
  const totalMiles = yMiles.reduce((s, m) => s + m.miles, 0);
  const effectiveRate = net > 0 ? Math.round((seTax / net) * 100) : 0;

  return (
    <div>
      {/* Stat strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 14, marginBottom: 20 }}>
        <Stat label="Income" value={$(totInc)} color="#22c55e" icon="dollar" />
        <Stat label="Expenses" value={$(totExp)} color="#ef4444" icon="receipt" />
        <Stat label="Mileage Ded." value={$(mileDed)} color="#f59e0b" icon="car" />
        <Stat label="Net Profit" value={$(net)} color={net >= 0 ? "#3b82f6" : "#f97316"} icon="chart" />
        <Stat label="Est. SE Tax" value={$(seTax)} color="#8b5cf6" icon="pie" />
        <Stat label="Effective Rate" value={`${effectiveRate}%`} color="#06b6d4" icon="calendar" />
      </div>

      {/* Tax Readiness Cockpit */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>
        {/* Quarterly deadline */}
        <Card style={{ background: "linear-gradient(135deg,rgba(99,102,241,.12),rgba(6,182,212,.08))", borderColor: "rgba(99,102,241,.3)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#6366f1", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Next Quarterly Tax</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: "#f1f5f9", fontFamily: "'JetBrains Mono',monospace" }}>{$(qEst)}</div>
              <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{nextQ[1]} · Due {nextQ[2]}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: daysUntil <= 14 ? "#f97316" : daysUntil <= 30 ? "#f59e0b" : "#a5b4fc", fontFamily: "'JetBrains Mono',monospace", lineHeight: 1 }}>{daysUntil}</div>
              <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>days away</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {qDue.map(([d, label]) => {
              const isPast = d < today;
              const isNext = d === nextQ[0];
              return (
                <div key={label} style={{ flex: 1, textAlign: "center", padding: "5px 0", borderRadius: 6, background: isNext ? "rgba(99,102,241,.25)" : isPast ? "rgba(34,197,94,.1)" : "rgba(255,255,255,.04)", border: `1px solid ${isNext ? "rgba(99,102,241,.5)" : isPast ? "rgba(34,197,94,.2)" : "rgba(255,255,255,.06)"}` }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: isNext ? "#a5b4fc" : isPast ? "#4ade80" : "#475569" }}>{label}</div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Export readiness */}
        <Card style={{ background: readinessPct === 100 ? "linear-gradient(135deg,rgba(34,197,94,.1),rgba(16,185,129,.06))" : readinessPct >= 80 ? "linear-gradient(135deg,rgba(245,158,11,.08),rgba(234,179,8,.05))" : "linear-gradient(135deg,rgba(239,68,68,.1),rgba(249,115,22,.06))", borderColor: readinessPct === 100 ? "rgba(34,197,94,.3)" : readinessPct >= 80 ? "rgba(245,158,11,.3)" : "rgba(239,68,68,.3)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: readinessPct === 100 ? "#22c55e" : readinessPct >= 80 ? "#f59e0b" : "#ef4444", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Schedule C Readiness</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 10 }}>
            <span style={{ fontSize: 28, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: readinessPct === 100 ? "#4ade80" : readinessPct >= 80 ? "#fbbf24" : "#f87171" }}>{readinessPct}%</span>
            <span style={{ fontSize: 12, color: "#94a3b8" }}>categorized</span>
          </div>
          <div style={{ height: 6, background: "rgba(255,255,255,.06)", borderRadius: 3, overflow: "hidden", marginBottom: 8 }}>
            <div style={{ height: "100%", width: `${readinessPct}%`, background: readinessPct === 100 ? "#22c55e" : readinessPct >= 80 ? "#f59e0b" : "#ef4444", borderRadius: 3, transition: "width .5s" }} />
          </div>
          {uncatCount > 0
            ? <button onClick={() => setView("expenses")} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 12, color: "#f59e0b", textDecoration: "underline" }}>
                {uncatCount} expense{uncatCount !== 1 ? "s" : ""} need a category →
              </button>
            : <span style={{ fontSize: 12, color: "#4ade80" }}>✓ All expenses categorized — ready to export</span>
          }
        </Card>
      </div>

      {/* Monthly bar chart */}
      <Card style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#f1f5f9", marginBottom: 14 }}>Monthly Overview — {year}</div>
        <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 130 }}>
          {mArr.map(([k, v]) => (
            <div key={k} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", height: "100%" }}>
              <div style={{ flex: 1, display: "flex", gap: 1, alignItems: "flex-end", width: "100%" }}>
                <div style={{ flex: 1, background: "#22c55e", borderRadius: "2px 2px 0 0", minHeight: 1, height: `${(v.income / maxM) * 100}%`, transition: "height .4s" }} />
                <div style={{ flex: 1, background: "#ef4444", borderRadius: "2px 2px 0 0", minHeight: 1, height: `${(v.expense / maxM) * 100}%`, transition: "height .4s" }} />
              </div>
              <span style={{ fontSize: 9, color: "#64748b", marginTop: 4 }}>{mn(+k.slice(5))}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 10, justifyContent: "center" }}>
          {[["#22c55e", "Income"], ["#ef4444", "Expenses"]].map(([c, l]) => (
            <span key={l} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#94a3b8" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: c }} />{l}
            </span>
          ))}
        </div>
      </Card>

      {/* Bottom grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 16 }}>
        {/* Expense donut + top list */}
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#f1f5f9", marginBottom: 14 }}>Expenses by Schedule C Line</div>
          {donutSlices.length === 0
            ? <p style={{ color: "#64748b", fontSize: 13 }}>No expenses recorded yet.</p>
            : <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
                <div style={{ flexShrink: 0 }}>
                  <DonutChart slices={donutSlices} size={150} thickness={30} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {topCats.map(({ code, label, value, color }) => (
                    <div key={code} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                      <span style={{ fontSize: 11, color: "#d1d5db", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Ln {SCHEDULE_C.find(c => c.code === code)?.line}: {label}</span>
                      <span style={{ fontSize: 11, fontWeight: 600, fontFamily: "'JetBrains Mono',monospace", color, flexShrink: 0 }}>{$(value)}</span>
                    </div>
                  ))}
                  {donutSlices.length > 8 && <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>+{donutSlices.length - 8} more categories</div>}
                </div>
              </div>
          }
        </Card>

        {/* Right column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card style={{ background: "rgba(245,158,11,.06)", borderColor: "rgba(245,158,11,.2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#f59e0b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 2 }}>Mileage</div>
                <div style={{ fontSize: 20, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace", color: "#f1f5f9" }}>{totalMiles.toFixed(1)} mi</div>
                <div style={{ fontSize: 11, color: "#94a3b8" }}>{$(mileDed)} deduction · ${MILE_RATE}/mi</div>
              </div>
              <I name="car" size={28} />
            </div>
          </Card>
          <Card>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#f1f5f9", marginBottom: 10 }}>Unpaid Invoices</div>
            {unpaid.length === 0
              ? <p style={{ color: "#64748b", fontSize: 13 }}>All caught up!</p>
              : unpaid.slice(0, 4).map((i) => (
                  <div key={i.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,.03)", fontSize: 13 }}>
                    <span style={{ color: "#d1d5db" }}>{i.clientName || "Client"}</span>
                    <span style={{ color: "#f59e0b", fontWeight: 600, fontFamily: "'JetBrains Mono',monospace" }}>{$(i.amount)}</span>
                  </div>
                ))
            }
          </Card>
          <Card>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#f1f5f9", marginBottom: 10 }}>Goals</div>
            {bGoals.length === 0
              ? <p style={{ color: "#64748b", fontSize: 13 }}>No goals set.</p>
              : bGoals.slice(0, 3).map((g) => {
                  const cur = g.metric === "revenue" ? totInc : net;
                  return (
                    <div key={g.id} style={{ marginBottom: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
                        <span style={{ color: "#d1d5db" }}>{g.name}</span>
                        <span style={{ color: bc, fontWeight: 600 }}>{Math.round((cur / (g.target || 1)) * 100)}%</span>
                      </div>
                      <PBar value={cur} max={g.target} color={bc} />
                    </div>
                  );
                })
            }
          </Card>
        </div>
      </div>
    </div>
  );
}

// ─── SETTINGS MODAL ──────────────────────────────────────────────────────────
function SettingsModal({ appVersion, updateInfo, checkStatus, onCheckForUpdate, onInstall, installing, onClose }) {
  const row = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 0", borderBottom: "1px solid rgba(255,255,255,.06)" };
  const sectionLabel = { fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4, marginTop: 18 };

  // Determine what to show in the update row
  let updateNode;
  if (updateInfo?.downloaded || updateInfo?.percent >= 99) {
    updateNode = (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 13, color: "#4ade80" }}>v{updateInfo.version} ready to install</span>
        {installing
          ? <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, color: "#86efac" }}>Preparing to restart…</span>
              <div style={{ width: 100, height: 5, background: "#1e293b", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: "100%", background: "linear-gradient(90deg,#22c55e 0%,#86efac 50%,#22c55e 100%)", backgroundSize: "200% 100%", animation: "shimmer 1.2s linear infinite", borderRadius: 3 }} />
              </div>
            </div>
          : <button type="button" onClick={onInstall} style={{ padding: "5px 14px", background: "#22c55e", border: "none", borderRadius: 7, color: "#fff", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>Restart &amp; Install</button>
        }
      </div>
    );
  } else if (updateInfo && !updateInfo.downloaded) {
    updateNode = (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 13, color: "#94a3b8" }}>Downloading v{updateInfo.version}… {updateInfo.percent > 0 ? `${updateInfo.percent}%` : ""}</span>
        <div style={{ width: 80, height: 4, background: "#1e293b", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${updateInfo.percent}%`, background: "#3b82f6", transition: "width .3s" }} />
        </div>
      </div>
    );
  } else if (checkStatus === "checking") {
    updateNode = <span style={{ fontSize: 13, color: "#94a3b8" }}>Checking…</span>;
  } else {
    // idle / up-to-date / error — always show the button, with a status badge beside it
    updateNode = (
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button type="button" onClick={onCheckForUpdate} style={{ padding: "5px 14px", background: "rgba(99,102,241,.15)", border: "1px solid #4f46e5", borderRadius: 7, color: "#a5b4fc", fontWeight: 500, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}>
          Check for Updates
        </button>
        {checkStatus === "up-to-date" && <span style={{ fontSize: 12, color: "#4ade80" }}>✓ You're up to date</span>}
        {checkStatus === "error" && <span style={{ fontSize: 12, color: "#f87171" }}>⚠ Could not reach update server</span>}
      </div>
    );
  }

  return (
    <Modal title="Settings" onClose={onClose}>
      <div style={{ minWidth: 380 }}>
        {/* App info */}
        <div style={sectionLabel}>Application</div>
        <div style={row}>
          <span style={{ fontSize: 13, color: "#e2e8f0", fontWeight: 500 }}>OpenClaw Books</span>
          <span style={{ fontSize: 12, color: "#64748b", fontFamily: "'JetBrains Mono',monospace" }}>v{appVersion || "—"}</span>
        </div>
        <div style={{ ...row, borderBottom: "none" }}>
          <span style={{ fontSize: 13, color: "#94a3b8" }}>Data storage</span>
          <span style={{ fontSize: 12, color: "#64748b" }}>Local — IndexedDB</span>
        </div>

        {/* Updates */}
        <div style={sectionLabel}>Updates</div>
        <div style={{ ...row, borderBottom: "none", flexWrap: "wrap", gap: 10 }}>
          <span style={{ fontSize: 13, color: "#94a3b8" }}>
            {updateInfo?.downloaded ? "Update ready" : updateInfo ? "Downloading update" : checkStatus === "up-to-date" ? "Status" : "Check for a newer version"}
          </span>
          {updateNode}
        </div>
      </div>
    </Modal>
  );
}

// ─── TXN LIST ────────────────────────────────────────────────────────────────
function TxnList({ type, txns, searchQ, onAdd, onBatchScan, onImportCSV, onEdit, onDelete, bc }) {
  const [scope, setScope] = useState("all");
  const [viewingReceipt, setViewingReceipt] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const cats = type === "income" ? INC_CATS : SCHEDULE_C;
  let f = txns.filter((t) => t.type === type);
  if (scope === "business") f = f.filter((t) => t.scope !== "personal");
  if (scope === "personal") f = f.filter((t) => t.scope === "personal");
  if (searchQ) { const q = searchQ.toLowerCase(); f = f.filter((t) => (t.description || "").toLowerCase().includes(q) || (t.vendor || "").toLowerCase().includes(q)); }
  const total = sumAmt(f, (t) => t.amount);
  return <><div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}><h3 style={{ fontSize: 16, fontWeight: 600, color: "#f1f5f9" }}>{type === "income" ? "Income" : "Expenses"}</h3><span style={{ fontSize: 13, color: "#94a3b8" }}>{f.length} · {$(total)}</span></div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select value={scope} onChange={(e) => setScope(e.target.value)} style={{ ...inp, width: 110, fontSize: 12, background: "#111827" }}><option value="all">All</option><option value="business">Business</option><option value="personal">Personal</option></select>
        {type === "expense" && (
          FEATURES.BATCH_SCAN
            ? <Btn onClick={onBatchScan} v="ghost" title="Scan multiple receipts at once"><I name="layers" size={15} /> Batch Scan</Btn>
            : <Btn v="ghost" title="Upgrade to Pro" style={{ opacity: 0.45, cursor: "default" }} onClick={() => {}}><I name="lock" size={14} /> Batch Scan <span style={{ fontSize: 10, background: "#f59e0b", color: "#000", borderRadius: 4, padding: "1px 5px", marginLeft: 3, fontWeight: 700 }}>PRO</span></Btn>
        )}
        <Btn v="ghost" onClick={onImportCSV} title="Import from bank CSV"><I name="download" size={15} /> Import CSV</Btn>
        <Btn onClick={onAdd}><I name="plus" size={15} /> Add</Btn>
      </div>
    </div>
    {f.length === 0 ? <Empty icon={type === "income" ? "dollar" : "receipt"} text={`No ${type} recorded.`} /> : <Card style={{ padding: 0 }}><table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr>{["Date", "Description", "Category", "Scope", "Amount", "📎", ""].map((h, i) => <th key={i} style={{ textAlign: i === 4 ? "right" : i >= 5 ? "center" : "left", padding: "9px 12px", fontSize: i === 5 ? 14 : 10, fontWeight: 600, color: "#64748b", textTransform: i === 5 ? "none" : "uppercase", letterSpacing: .8, background: "rgba(15,15,26,.5)", borderBottom: "1px solid rgba(255,255,255,.06)", width: i === 5 ? 36 : i === 6 ? 70 : undefined }}>{h}</th>)}</tr></thead><tbody>{f.map((t) => { const cat = cats.find((c) => c.code === t.category); return <tr key={t.id} style={{ borderBottom: "1px solid rgba(255,255,255,.03)" }}><td style={{ padding: "10px 12px", fontSize: 13 }}>{t.date}</td><td style={{ padding: "10px 12px", fontSize: 13 }}><div style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>{t.description || "—"}{t.recurring?.freq && <span title={`Repeats ${t.recurring.freq}`} style={{ fontSize: 10, background: "rgba(99,102,241,.2)", color: "#a5b4fc", borderRadius: 4, padding: "1px 5px", fontWeight: 600 }}>🔁 {t.recurring.freq}</span>}</div>{t.vendor && <div style={{ fontSize: 11, color: "#9ca3af" }}>{t.vendor}</div>}</td><td style={{ padding: "10px 12px" }}>{cat ? <Badge color={type === "expense" ? (CAT_COLORS[t.category] || bc) : "#22c55e"}>Ln {cat.line}: {cat.label}</Badge> : "—"}</td><td style={{ padding: "10px 12px" }}><Badge color={t.scope === "personal" ? "#f59e0b" : "#22c55e"}>{t.scope || "biz"}</Badge></td><td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, fontFamily: "'JetBrains Mono',monospace", color: type === "income" ? "#22c55e" : "#ef4444" }}>{type === "income" ? "+" : "−"}{$(t.amount)}</td><td style={{ padding: "10px 12px", textAlign: "center" }}>{t.receiptFile ? <button title="View receipt" onClick={() => setViewingReceipt(t.receiptFile)} style={{ background: "transparent", border: "none", color: "#60a5fa", cursor: "pointer", fontSize: 16, padding: 2 }}>📎</button> : null}</td><td style={{ padding: "10px 12px", textAlign: "center" }}><button onClick={() => onEdit(t)} style={{ background: "transparent", border: "none", color: "#94a3b8", cursor: "pointer", padding: 3 }}><I name="edit" size={14} /></button><button onClick={() => setConfirmDeleteId(t.id)} style={{ background: "transparent", border: "none", color: "#ef4444", cursor: "pointer", padding: 3 }}><I name="trash" size={14} /></button></td></tr>; })}</tbody></table></Card>}
  </div>
  {viewingReceipt && <ReceiptViewer receipt={viewingReceipt} onClose={() => setViewingReceipt(null)} />}
  {confirmDeleteId && (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div style={{ background: "#1e1e2e", border: "1px solid rgba(255,255,255,.1)", borderRadius: 14, padding: "28px 32px", width: 360, boxShadow: "0 20px 60px rgba(0,0,0,.6)" }}>
        <div style={{ fontSize: 22, marginBottom: 12, textAlign: "center" }}>🗑️</div>
        <p style={{ color: "#f1f5f9", fontWeight: 600, fontSize: 15, textAlign: "center", marginBottom: 6 }}>
          Are you sure you want to remove this {type === "income" ? "income entry" : "expense"}?
        </p>
        <p style={{ color: "#94a3b8", fontSize: 12, textAlign: "center", marginBottom: 24 }}>This action cannot be undone.</p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button
            onClick={() => setConfirmDeleteId(null)}
            style={{ flex: 1, padding: "9px 0", borderRadius: 8, border: "1px solid rgba(255,255,255,.12)", background: "transparent", color: "#94a3b8", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 500 }}>
            Cancel
          </button>
          <button
            onClick={() => { onDelete(confirmDeleteId); setConfirmDeleteId(null); }}
            style={{ flex: 1, padding: "9px 0", borderRadius: 8, border: "none", background: "#ef4444", color: "#fff", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 600 }}>
            Yes, Remove
          </button>
        </div>
      </div>
    </div>
  )}
</>;
}

// ─── MILEAGE ──────────────────────────────────────────────────────────────────
function MileV({ trips, rate, onAdd, onEdit, onDelete }) {
  const tm = trips.reduce((s, t) => s + t.miles, 0);
  return <div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}><h3 style={{ fontSize: 16, fontWeight: 600, color: "#f1f5f9" }}>Mileage</h3><Btn onClick={onAdd}><I name="plus" size={15} /> Log Trip</Btn></div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 14, marginBottom: 20 }}><Stat label="Miles" value={`${tm.toFixed(1)}`} color="#f59e0b" icon="car" /><Stat label="Rate" value={`$${rate}/mi`} color="#94a3b8" icon="tag" /><Stat label="Deduction" value={$(tm * rate)} color="#22c55e" icon="dollar" /></div>
    {trips.length === 0 ? <Empty icon="car" text="No trips." /> : <Card style={{ padding: 0 }}><table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr>{["Date", "Purpose", "Route", "Miles", "Ded.", ""].map((h, i) => <th key={i} style={{ textAlign: i >= 3 ? (i === 5 ? "center" : "right") : "left", padding: "9px 12px", fontSize: 10, fontWeight: 600, color: "#64748b", textTransform: "uppercase", background: "rgba(15,15,26,.5)", borderBottom: "1px solid rgba(255,255,255,.06)", width: i === 5 ? 70 : undefined }}>{h}</th>)}</tr></thead><tbody>{trips.map((t) => <tr key={t.id} style={{ borderBottom: "1px solid rgba(255,255,255,.03)" }}><td style={{ padding: "10px 12px", fontSize: 13 }}>{t.date}</td><td style={{ padding: "10px 12px", fontSize: 13 }}>{t.purpose || "—"}</td><td style={{ padding: "10px 12px", fontSize: 13, color: "#94a3b8" }}>{t.from || "?"} → {t.to || "?"}</td><td style={{ padding: "10px 12px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: "#f59e0b" }}>{t.miles.toFixed(1)}</td><td style={{ padding: "10px 12px", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: "#22c55e" }}>{$(t.miles * rate)}</td><td style={{ padding: "10px 12px", textAlign: "center" }}><button onClick={() => onEdit(t)} style={{ background: "transparent", border: "none", color: "#94a3b8", cursor: "pointer", padding: 3 }}><I name="edit" size={14} /></button><button onClick={() => onDelete(t.id)} style={{ background: "transparent", border: "none", color: "#ef4444", cursor: "pointer", padding: 3 }}><I name="trash" size={14} /></button></td></tr>)}</tbody></table></Card>}
  </div>;
}

// ─── INVOICES ─────────────────────────────────────────────────────────────────
function InvV({ invoices, onAdd, onEdit, onDelete, reload, bc }) {
  const sc = { Draft: "#94a3b8", Sent: "#3b82f6", Viewed: "#8b5cf6", Paid: "#22c55e", Overdue: "#ef4444" };
  return <div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}><h3 style={{ fontSize: 16, fontWeight: 600, color: "#f1f5f9" }}>Invoices</h3><Btn onClick={onAdd}><I name="plus" size={15} /> New</Btn></div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 14, marginBottom: 20 }}><Stat label="Outstanding" value={$(invoices.filter((i) => i.status !== "Paid").reduce((s, i) => s + i.amount, 0))} color="#f59e0b" icon="send" /><Stat label="Collected" value={$(invoices.filter((i) => i.status === "Paid").reduce((s, i) => s + i.amount, 0))} color="#22c55e" icon="check" /><Stat label="Total" value={invoices.length} color={bc} icon="file" /></div>
    {invoices.length === 0 ? <Empty icon="send" text="No invoices." /> : <Card style={{ padding: 0 }}><table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr>{["Date", "Client", "Desc", "Status", "Amount", ""].map((h, i) => <th key={i} style={{ textAlign: i === 4 ? "right" : i === 5 ? "center" : "left", padding: "9px 12px", fontSize: 10, fontWeight: 600, color: "#64748b", textTransform: "uppercase", background: "rgba(15,15,26,.5)", borderBottom: "1px solid rgba(255,255,255,.06)", width: i === 5 ? 100 : undefined }}>{h}</th>)}</tr></thead><tbody>{invoices.map((i) => <tr key={i.id} style={{ borderBottom: "1px solid rgba(255,255,255,.03)" }}><td style={{ padding: "10px 12px", fontSize: 13 }}>{i.date}</td><td style={{ padding: "10px 12px", fontSize: 13, fontWeight: 500 }}>{i.clientName || "—"}</td><td style={{ padding: "10px 12px", fontSize: 13, color: "#94a3b8" }}>{i.description || "—"}</td><td style={{ padding: "10px 12px" }}><Badge color={sc[i.status]}>{i.status}</Badge></td><td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, fontFamily: "'JetBrains Mono',monospace", color: "#22c55e" }}>{$(i.amount)}</td><td style={{ padding: "10px 12px", textAlign: "center" }}>{i.status !== "Paid" && <button onClick={async () => { await put("invoices", { ...i, status: "Paid", paidDate: td() }); reload(); }} style={{ background: "transparent", border: "none", color: "#22c55e", cursor: "pointer", padding: 3 }}><I name="check" size={14} /></button>}<button onClick={() => onEdit(i)} style={{ background: "transparent", border: "none", color: "#94a3b8", cursor: "pointer", padding: 3 }}><I name="edit" size={14} /></button><button onClick={() => onDelete(i.id)} style={{ background: "transparent", border: "none", color: "#ef4444", cursor: "pointer", padding: 3 }}><I name="trash" size={14} /></button></td></tr>)}</tbody></table></Card>}
  </div>;
}

// ─── CONTRACTORS ──────────────────────────────────────────────────────────────
function ConV({ contractors, txns, onAdd, onEdit, onDelete, bc }) {
  return <div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}><h3 style={{ fontSize: 16, fontWeight: 600, color: "#f1f5f9" }}>Contractors & 1099</h3><Btn onClick={onAdd}><I name="plus" size={15} /> Add</Btn></div>
    <Card style={{ marginBottom: 16, background: `${bc}0a`, borderLeft: `4px solid ${bc}` }}><p style={{ fontSize: 13, color: "#c4b5fd" }}>Track payments. $600+ triggers 1099-NEC.</p></Card>
    {contractors.length === 0 ? <Empty icon="users" text="No contractors." /> : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 14 }}>
      {contractors.map((c) => { const paid = txns.filter((t) => t.type === "expense" && t.contractorId === c.id).reduce((s, t) => s + t.amount, 0); return <Card key={c.id}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}><div><div style={{ fontWeight: 600, color: "#f1f5f9", fontSize: 15 }}>{c.name}</div>{c.ein && <div style={{ fontSize: 11, color: "#94a3b8" }}>EIN: •••{c.ein.slice(-4)}</div>}{c.email && <div style={{ fontSize: 11, color: "#94a3b8" }}>{c.email}</div>}</div><div style={{ display: "flex", gap: 4 }}><button onClick={() => onEdit(c)} style={{ background: "transparent", border: "none", color: "#94a3b8", cursor: "pointer" }}><I name="edit" size={14} /></button><button onClick={() => onDelete(c.id)} style={{ background: "transparent", border: "none", color: "#ef4444", cursor: "pointer" }}><I name="trash" size={14} /></button></div></div><div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: 20, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: "#f59e0b" }}>{$(paid)}</span><Badge color={paid >= 600 ? "#ef4444" : "#22c55e"}>{paid >= 600 ? "1099 Req" : "<$600"}</Badge></div></Card>; })}
    </div>}
  </div>;
}

// ─── REPORTS ──────────────────────────────────────────────────────────────────
function Reps({ txns, miles, year, totInc, totExp, net, mileDed, seTax, bc }) {
  const [tab, setTab] = useState("pnl");

  // Use integer-cent summation to avoid floating-point drift
  const expByCat = {}, incByCat = {};
  txns.filter((t) => t.type === "expense").forEach((t) => { const c = SCHEDULE_C.find((c) => c.code === t.category); const k = c?.code || "L23"; expByCat[k] = (expByCat[k] || 0) + Math.round(t.amount * 100); });
  txns.filter((t) => t.type === "income").forEach((t) => { const c = INC_CATS.find((c) => c.code === t.category); const k = c?.label || "Other"; incByCat[k] = (incByCat[k] || 0) + Math.round(t.amount * 100); });
  // Convert cents back to dollars for display
  Object.keys(expByCat).forEach((k) => { expByCat[k] = expByCat[k] / 100; });
  Object.keys(incByCat).forEach((k) => { incByCat[k] = incByCat[k] / 100; });

  const monthly = {};
  for (let m = 1; m <= 12; m++) monthly[mn(m)] = { incCents: 0, expCents: 0 };
  txns.forEach((t) => { const m = mn(parseInt(t.date?.slice(5, 7))); if (monthly[m]) { if (t.type === "income") monthly[m].incCents += Math.round(t.amount * 100); else monthly[m].expCents += Math.round(t.amount * 100); } });

  const totalIncCents = Object.values(monthly).reduce((s, v) => s + v.incCents, 0);
  const totalExpCents = Object.values(monthly).reduce((s, v) => s + v.expCents, 0);

  const exportPnLCSV = () => {
    const rows = [["Month", "Income", "Expenses", "Net"]];
    Object.entries(monthly).forEach(([m, v]) => {
      const inc = v.incCents / 100, exp = v.expCents / 100;
      rows.push([m, inc.toFixed(2), exp.toFixed(2), (inc - exp).toFixed(2)]);
    });
    rows.push(["TOTAL", (totalIncCents / 100).toFixed(2), (totalExpCents / 100).toFixed(2), ((totalIncCents - totalExpCents) / 100).toFixed(2)]);
    dlFile(rows.map(csvRow).join("\n"), `PnL_${year}.csv`, "text/csv");
  };

  return <div>
    <div style={{ display: "flex", gap: 2, marginBottom: 20 }}>
      {[{ id: "pnl", icon: "chart", label: "P&L" }, { id: "tax", icon: "pie", label: "Tax" }, { id: "sched", icon: "file", label: "Schedule C" }].map((t) => <button key={t.id} onClick={() => setTab(t.id)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "9px 14px", borderRadius: 8, border: "none", background: tab === t.id ? `${bc}22` : "transparent", color: tab === t.id ? bc : "#94a3b8", cursor: "pointer", fontSize: 13, fontWeight: 500, fontFamily: "'DM Sans',sans-serif" }}><I name={t.icon} size={16} />{t.label}</button>)}
    </div>
    {tab === "pnl" && <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        <Card><div style={{ fontSize: 14, fontWeight: 600, color: "#f1f5f9", marginBottom: 14 }}>Income</div>{Object.entries(incByCat).map(([l, t]) => <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,.03)", fontSize: 13 }}><span style={{ color: "#d1d5db" }}>{l}</span><span style={{ color: "#22c55e", fontWeight: 600, fontFamily: "'JetBrains Mono',monospace" }}>{$(t)}</span></div>)}<div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0 0", fontWeight: 700 }}><span style={{ color: "#f1f5f9" }}>Total</span><span style={{ color: "#22c55e" }}>{$(totInc)}</span></div></Card>
        <Card><div style={{ fontSize: 14, fontWeight: 600, color: "#f1f5f9", marginBottom: 14 }}>Expenses</div>{Object.entries(expByCat).sort((a, b) => b[1] - a[1]).map(([code, t]) => { const cat = SCHEDULE_C.find(c => c.code === code); const clr = CAT_COLORS[code] || "#ef4444"; return (<div key={code} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,.03)", fontSize: 13 }}><span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: clr, flexShrink: 0 }} /><span style={{ color: "#d1d5db" }}>{cat?.label || "Other"}</span></span><span style={{ color: clr, fontWeight: 600, fontFamily: "'JetBrains Mono',monospace" }}>{$(t)}</span></div>); })}<div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0 0", fontWeight: 700 }}><span style={{ color: "#f1f5f9" }}>Total</span><span style={{ color: "#ef4444" }}>{$(totExp)}</span></div></Card>
      </div>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#f1f5f9" }}>Monthly P&L — {year}</div>
          <Btn v="ghost" onClick={exportPnLCSV}><I name="download" size={14} /> Export CSV</Btn>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{["Month", "Income", "Expenses", "Net"].map((h, i) => <th key={i} style={{ textAlign: i ? "right" : "left", padding: "8px 10px", fontSize: 10, fontWeight: 600, color: "#64748b", textTransform: "uppercase", borderBottom: "1px solid rgba(255,255,255,.06)" }}>{h}</th>)}</tr></thead>
          <tbody>
            {Object.entries(monthly).map(([m, v]) => { const inc = v.incCents / 100, exp = v.expCents / 100, net = inc - exp; return <tr key={m} style={{ borderBottom: "1px solid rgba(255,255,255,.03)" }}><td style={{ padding: "8px 10px", fontSize: 13 }}>{m}</td><td style={{ padding: "8px 10px", textAlign: "right", color: inc > 0 ? "#22c55e" : "#475569", fontFamily: "'JetBrains Mono',monospace", fontSize: 13 }}>{$(inc)}</td><td style={{ padding: "8px 10px", textAlign: "right", color: exp > 0 ? "#ef4444" : "#475569", fontFamily: "'JetBrains Mono',monospace", fontSize: 13 }}>{$(exp)}</td><td style={{ padding: "8px 10px", textAlign: "right", color: net >= 0 ? "#3b82f6" : "#f97316", fontFamily: "'JetBrains Mono',monospace", fontSize: 13, fontWeight: 600 }}>{$(net)}</td></tr>; })}
          </tbody>
          <tfoot><tr style={{ borderTop: "2px solid rgba(255,255,255,.1)" }}><td style={{ padding: "10px 10px", fontSize: 13, fontWeight: 700, color: "#f1f5f9" }}>Total</td><td style={{ padding: "10px 10px", textAlign: "right", color: "#22c55e", fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, fontSize: 13 }}>{$(totalIncCents / 100)}</td><td style={{ padding: "10px 10px", textAlign: "right", color: "#ef4444", fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, fontSize: 13 }}>{$(totalExpCents / 100)}</td><td style={{ padding: "10px 10px", textAlign: "right", color: (totalIncCents - totalExpCents) >= 0 ? "#3b82f6" : "#f97316", fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, fontSize: 13 }}>{$((totalIncCents - totalExpCents) / 100)}</td></tr></tfoot>
        </table>
      </Card>
    </div>}
    {tab === "tax" && <Card>
      <div style={{ fontSize: 14, fontWeight: 600, color: "#f1f5f9", marginBottom: 16 }}>Tax Estimate — {year}</div>
      {[["Gross Income", $(totInc), "#22c55e"], ["Total Deductions", `(${$(totExp + mileDed)})`, "#ef4444"], ["  ↳ Business Expenses", $(totExp), "#94a3b8"], ["  ↳ Mileage", $(mileDed), "#94a3b8"], ["Net Profit", $(net), "#3b82f6"], ["SE Base (92.35%)", $(net * 0.9235), "#8b5cf6"], ["SE Tax (15.3%)", $(seTax), "#f59e0b"], ["Quarterly Est.", $(seTax / 4), "#06b6d4"]].map(([l, v, c], i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: i < 7 ? "1px solid rgba(255,255,255,.04)" : "2px solid rgba(255,255,255,.1)", fontSize: l.startsWith("  ") ? 12 : 14, fontWeight: i >= 6 ? 700 : 400 }}><span style={{ color: l.startsWith("  ") ? "#64748b" : "#d1d5db" }}>{l}</span><span style={{ color: c, fontFamily: "'JetBrains Mono',monospace", fontWeight: 600 }}>{v}</span></div>)}
      <div style={{ marginTop: 16, padding: 12, background: "rgba(6,182,212,.08)", borderRadius: 8, fontSize: 12, color: "#67e8f9" }}>Due dates: Apr 15, Jun 15, Sep 15, Jan 15.</div>
    </Card>}
    {tab === "sched" && <Card style={{ padding: 0 }}><table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr>{["Line", "Category", "Amount"].map((h, i) => <th key={i} style={{ textAlign: i === 2 ? "right" : "left", padding: "9px 12px", fontSize: 10, fontWeight: 600, color: "#64748b", textTransform: "uppercase", background: "rgba(15,15,26,.5)", borderBottom: "1px solid rgba(255,255,255,.06)" }}>{h}</th>)}</tr></thead><tbody>
      {INC_CATS.map((cat) => { const t = txns.filter((x) => x.type === "income" && x.category === cat.code).reduce((s, x) => s + x.amount, 0); return t > 0 ? <tr key={cat.code} style={{ borderBottom: "1px solid rgba(255,255,255,.03)" }}><td style={{ padding: "10px 12px", fontSize: 13 }}>{cat.line}</td><td style={{ padding: "10px 12px", fontSize: 13 }}>{cat.label}</td><td style={{ padding: "10px 12px", textAlign: "right", color: "#22c55e", fontWeight: 600, fontFamily: "'JetBrains Mono',monospace" }}>{$(t)}</td></tr> : null; })}
      {SCHEDULE_C.map((cat) => { const t = txns.filter((x) => x.type === "expense" && x.category === cat.code).reduce((s, x) => s + x.amount, 0); const clr = CAT_COLORS[cat.code] || "#ef4444"; return t > 0 ? <tr key={cat.code} style={{ borderBottom: "1px solid rgba(255,255,255,.03)" }}><td style={{ padding: "10px 12px", fontSize: 13, color: "#94a3b8" }}>{cat.line}</td><td style={{ padding: "10px 12px", fontSize: 13 }}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: clr, flexShrink: 0 }} />{cat.label}</span></td><td style={{ padding: "10px 12px", textAlign: "right", color: clr, fontWeight: 600, fontFamily: "'JetBrains Mono',monospace" }}>{$(t)}</td></tr> : null; })}
      {miles.length > 0 && <tr><td style={{ padding: "10px 12px", fontSize: 13 }}>9</td><td style={{ padding: "10px 12px", fontSize: 13 }}>Car & truck (mileage)</td><td style={{ padding: "10px 12px", textAlign: "right", color: "#f59e0b", fontWeight: 600, fontFamily: "'JetBrains Mono',monospace" }}>{$(miles.reduce((s, m) => s + m.miles * MILE_RATE, 0))}</td></tr>}
    </tbody></table></Card>}
  </div>;
}

// ─── GOALS ────────────────────────────────────────────────────────────────────
function GoalsV({ goals, totInc, net, year, onAdd, onDelete, bc }) {
  return <div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}><h3 style={{ fontSize: 16, fontWeight: 600, color: "#f1f5f9" }}>Goals — {year}</h3><Btn onClick={onAdd}><I name="plus" size={15} /> Set Goal</Btn></div>
    {goals.length === 0 ? <Empty icon="target" text="Set goals to track progress." /> : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 14 }}>
      {goals.map((g) => { const cur = g.metric === "revenue" ? totInc : net; const pct = g.target > 0 ? Math.round((cur / g.target) * 100) : 0; return <Card key={g.id}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: 12 }}><div><div style={{ fontWeight: 600, color: "#f1f5f9", fontSize: 15 }}>{g.name}</div><div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{g.metric === "revenue" ? "Revenue" : "Profit"} · {$(g.target)}{g.deadline ? ` · by ${g.deadline}` : ""}</div></div><button onClick={() => onDelete(g.id)} style={{ background: "transparent", border: "none", color: "#ef4444", cursor: "pointer" }}><I name="trash" size={14} /></button></div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><span style={{ fontSize: 22, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: pct >= 100 ? "#22c55e" : bc }}>{pct}%</span><span style={{ fontSize: 13, color: "#94a3b8" }}>{$(cur)} / {$(g.target)}</span></div><PBar value={cur} max={g.target} color={pct >= 100 ? "#22c55e" : bc} /></Card>; })}
    </div>}
  </div>;
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────
function ExpV({ txns, year, yTxns, miles, totInc, totExp, mileDed, biz, bc }) {
  const yMi = miles.filter((m) => m.date?.startsWith(String(year)));
  const ct = yTxns.length + yMi.length;
  const bn = (biz?.name || "business").replace(/\s+/g, "_");
  return <div>
    <h3 style={{ fontSize: 16, fontWeight: 600, color: "#f1f5f9", marginBottom: 6 }}>Export — {biz?.name} — {year}</h3>
    <p style={{ color: "#94a3b8", marginBottom: 20, fontSize: 13 }}>{ct} records · {$(totInc)} inc · {$(totExp)} exp · {$(mileDed)} mileage</p>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 16 }}>
      {[
        { title: "TXF", desc: "TurboTax import", ext: ".txf", fn: () => dlFile(makeTXF(txns, year, biz?.name), `${bn}_${year}.txf`, "text/plain"), icon: "file" },
        { title: "CSV", desc: "Excel / Sheets", ext: ".csv", fn: () => dlFile(makeCSV(txns, year), `${bn}_${year}.csv`, "text/csv"), icon: "chart" },
        { title: "Mileage", desc: "IRS mileage log", ext: ".csv", fn: () => { const h = csvRow(["Date","Purpose","From","To","Miles","Deduction"]) + "\n"; const r = yMi.map((m) => csvRow([m.date, m.purpose||"", m.from||"", m.to||"", m.miles.toFixed(1), (m.miles*MILE_RATE).toFixed(2)])).join("\n"); dlFile(h + r, `${bn}_miles_${year}.csv`, "text/csv"); }, icon: "car" },
        { title: "1099", desc: "Contractor summary", ext: ".csv", fn: async () => { const cs = (await getAll("contractors")).filter((c) => c.bizId === biz?.id); const at = (await getAll("transactions")).filter((t) => t.date?.startsWith(String(year)) && t.bizId === biz?.id); const h = csvRow(["Name","EIN","Email","Paid","1099?"]) + "\n"; const r = cs.map((c) => { const p = at.filter((t) => t.contractorId === c.id).reduce((s, t) => s + t.amount, 0); return csvRow([c.name, c.ein||"", c.email||"", p.toFixed(2), p >= 600 ? "Yes" : "No"]); }).join("\n"); dlFile(h + r, `${bn}_1099_${year}.csv`, "text/csv"); }, icon: "users" },
      ].map((e) => <Card key={e.title} style={{ textAlign: "center" }}><div style={{ color: bc, marginBottom: 8 }}><I name={e.icon} size={28} /></div><h4 style={{ margin: "0 0 4px", color: "#f9fafb", fontSize: 14 }}>{e.title}</h4><p style={{ fontSize: 12, color: "#9ca3af", margin: "0 0 14px" }}>{e.desc}</p><Btn onClick={e.fn} disabled={ct === 0}><I name="download" size={14} /> {e.ext}</Btn></Card>)}
    </div>
  </div>;
}

// ─── RECEIPT VIEWER ───────────────────────────────────────────────────────────
function ReceiptViewer({ receipt, onClose }) {
  const dataUrl = `data:${receipt.mimeType};base64,${receipt.data}`;
  const isImage = receipt.mimeType?.startsWith("image/");
  const isPDF = receipt.mimeType === "application/pdf";
  const ext = isPDF ? "pdf" : (receipt.mimeType?.split("/")[1] || "jpg");
  const dl = () => { const a = document.createElement("a"); a.href = dataUrl; a.download = receipt.filename || `receipt.${ext}`; a.click(); };
  return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 500, padding: 20 }} onClick={onClose}>
    <div style={{ background: "#1e293b", borderRadius: 16, width: "100%", maxWidth: 780, maxHeight: "90vh", display: "flex", flexDirection: "column", border: "1px solid rgba(255,255,255,.08)", overflow: "hidden" }} onClick={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,.06)", flexShrink: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>📎 {receipt.filename || "Receipt"}</span>
        <div style={{ display: "flex", gap: 8 }}><Btn v="ghost" onClick={dl} s={{ padding: "5px 12px", fontSize: 12 }}><I name="download" size={13} /> Download</Btn><button onClick={onClose} style={{ background: "transparent", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 22, lineHeight: 1 }}>×</button></div>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 20, display: "flex", alignItems: "flex-start", justifyContent: "center", background: "#0f172a" }}>
        {isImage && <img src={dataUrl} alt="Receipt" style={{ maxWidth: "100%", borderRadius: 8 }} />}
        {isPDF && <object data={dataUrl} type="application/pdf" style={{ width: "100%", height: 500, border: "none", borderRadius: 8 }}><p style={{ color: "#94a3b8", textAlign: "center", padding: 24 }}>PDF cannot preview here — <button onClick={dl} style={{ background: "transparent", border: "none", color: "#60a5fa", cursor: "pointer", textDecoration: "underline" }}>download it</button>.</p></object>}
        {!isImage && !isPDF && <div style={{ color: "#64748b", textAlign: "center", padding: 40 }}>Cannot preview this file type. <button onClick={dl} style={{ background: "transparent", border: "none", color: "#60a5fa", cursor: "pointer", textDecoration: "underline" }}>Download</button></div>}
      </div>
    </div>
  </div>;
}

// ─── FORM MODALS ──────────────────────────────────────────────────────────────
// ─── Batch Scan Modal ─────────────────────────────────────────────────────────
function BatchScanModal({ bizId, onSave, onDone, onClose }) {
  const [items, setItems]   = useState([]);   // { file, status, result, error, pct }
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const fileRef = useRef();

  const fileToBase64 = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result.split(",")[1]);
    r.onerror = () => rej(new Error("Could not read file"));
    r.readAsDataURL(file);
  });

  const handleFiles = (e) => {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    setItems(files.map((f) => ({ file: f, status: "queued", result: null, error: "", pct: 0 })));
    setFinished(false);
    e.target.value = "";
  };

  const runBatch = async () => {
    setRunning(true);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.status === "done") continue; // skip already scanned
      setItems((prev) => prev.map((x, idx) => idx === i ? { ...x, status: "scanning", pct: 0 } : x));
      try {
        const data = await fileToBase64(item.file);
        const result = await Promise.race([
          ocrReceiptFile(
            { data, mimeType: item.file.type, filename: item.file.name },
            ({ pct }) => setItems((prev) => prev.map((x, idx) => idx === i ? { ...x, pct } : x))
          ),
          new Promise((_, rej) => setTimeout(() => rej(new Error("Timed out after 90s")), 90_000)),
        ]);
        const txn = {
          id: uid(), bizId, type: "expense",
          date:        result.date        || td(),
          amount:      result.amount      || 0,
          vendor:      result.vendor      || "",
          description: result.description || item.file.name,
          category:    SCHEDULE_C[0].code,
          scope:       "business",
          notes:       "",
          receiptFile: { data, mimeType: item.file.type, filename: item.file.name },
        };
        await onSave(txn);
        setItems((prev) => prev.map((x, idx) => idx === i ? { ...x, status: "done", result, pct: 1 } : x));
      } catch (err) {
        setItems((prev) => prev.map((x, idx) => idx === i ? { ...x, status: "error", error: err.message, pct: 0 } : x));
      }
    }
    setRunning(false);
    setFinished(true);
  };

  const doneCount  = items.filter((x) => x.status === "done").length;
  const errorCount = items.filter((x) => x.status === "error").length;

  const statusIcon  = (s) => s === "done" ? "✓" : s === "error" ? "✗" : s === "scanning" ? "⟳" : "·";
  const statusColor = (s) => s === "done" ? "#4ade80" : s === "error" ? "#f87171" : s === "scanning" ? "#a5b4fc" : "#64748b";

  return (
    <Modal title="Batch Scan Receipts" onClose={onClose} w={520}>
      {/* File picker */}
      <input ref={fileRef} type="file" multiple accept="image/*,application/pdf" style={{ display: "none" }} onChange={handleFiles} />

      {items.length === 0 ? (
        <div style={{ textAlign: "center", padding: "32px 0" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
          <div style={{ color: "#94a3b8", fontSize: 14, marginBottom: 20 }}>Select multiple receipts to scan and auto-save all at once.</div>
          <Btn onClick={() => fileRef.current?.click()}><I name="plus" size={15} /> Choose Files</Btn>
        </div>
      ) : (
        <>
          {/* File list */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto", marginBottom: 16 }}>
            {items.map((item, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "rgba(255,255,255,.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,.06)" }}>
                <span style={{ fontSize: 16, color: statusColor(item.status), width: 18, textAlign: "center", flexShrink: 0, animation: item.status === "scanning" ? "spin 1s linear infinite" : undefined }}>{statusIcon(item.status)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#f1f5f9" }}>{item.file.name}</div>
                  {item.status === "scanning" && (
                    <div style={{ height: 3, background: "#1e293b", borderRadius: 2, marginTop: 4, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${Math.round(item.pct * 100)}%`, background: "#6366f1", transition: "width .3s" }} />
                    </div>
                  )}
                  {item.status === "done" && item.result && (
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                      {item.result.vendor && <span>{item.result.vendor}</span>}
                      {item.result.vendor && item.result.amount ? " · " : ""}
                      {item.result.amount ? `$${item.result.amount.toFixed(2)}` : ""}
                      {item.result.date ? ` · ${item.result.date}` : ""}
                    </div>
                  )}
                  {item.status === "error" && <div style={{ fontSize: 11, color: "#f87171", marginTop: 2 }}>⚠ {item.error}</div>}
                </div>
              </div>
            ))}
          </div>

          {/* Summary / actions */}
          {finished ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ padding: "10px 14px", background: "rgba(34,197,94,.08)", border: "1px solid rgba(34,197,94,.2)", borderRadius: 8, fontSize: 13, color: "#4ade80" }}>
                {doneCount} expense{doneCount !== 1 ? "s" : ""} saved{errorCount > 0 ? `, ${errorCount} failed` : ""}.
                {doneCount > 0 && " Review them in the Expenses list — you can edit category and details there."}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                {!running && <Btn onClick={() => fileRef.current?.click()} v="ghost">Scan More</Btn>}
                <Btn v="green" onClick={onDone}><I name="check" size={15} /> Done</Btn>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button onClick={() => fileRef.current?.click()} disabled={running} style={{ background: "transparent", border: "none", color: running ? "#334155" : "#60a5fa", cursor: running ? "default" : "pointer", fontSize: 13, textDecoration: "underline", padding: 0 }}>Change files</button>
              <Btn v="green" onClick={runBatch} disabled={running}>
                {running ? <><I name="loader" size={15} /> Scanning…</> : <><I name="scan" size={15} /> Scan All ({items.length})</>}
              </Btn>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ─── CSV Import Modal ─────────────────────────────────────────────────────────
function CsvImportModal({ bizId, onSave, onDone, onClose }) {
  const [step, setStep] = useState('upload'); // upload | map | preview
  const [raw, setRaw] = useState(null);       // { headers, rows }
  const [cols, setCols] = useState({ dateCol: -1, amtCol: -1, descCol: -1 });
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileRef = useRef();

  // Full RFC 4180-ish CSV parser. Handles quoted fields containing commas,
  // newlines, and escaped quotes ("") — operates over whole text, not per-line.
  const parseCSV = (text) => {
    const rows = [];
    let cur = '';
    let row = [];
    let inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { row.push(cur); cur = ''; }
        else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
        else if (c === '\r') { /* swallow — handled by \n */ }
        else cur += c;
      }
    }
    // Flush trailing field/row
    if (cur.length || row.length) { row.push(cur); rows.push(row); }
    // Drop fully-empty trailing rows
    return rows.filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
  };

  const normalizeDate = (raw2) => {
    const s = (raw2 || '').trim().replace(/^["']|["']$/g, '');
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m) { const yr = m[3].length === 2 ? '20' + m[3] : m[3]; return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
    try {
      const d = new Date(s);
      if (!isNaN(d)) {
        // UTC-anchor to avoid TZ shift on .toISOString()
        const u = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        return u.toISOString().slice(0, 10);
      }
    } catch (_) {}
    return '';
  };

  const buildPreview = (dataRows, c) => {
    const result = dataRows.map((row, i) => {
      let amtStr = (row[c.amtCol] || '').trim();
      // Detect parentheses as negative (accounting CSVs): "(123.45)" → -123.45
      let parenNeg = false;
      if (/^\(.*\)$/.test(amtStr)) { parenNeg = true; amtStr = amtStr.slice(1, -1); }
      const cleaned = amtStr.replace(/[$,\s"']/g, '');
      let rawAmt = parseFloat(cleaned) || 0;
      if (parenNeg) rawAmt = -Math.abs(rawAmt);
      const amount = Math.abs(rawAmt);
      const type = rawAmt >= 0 ? 'income' : 'expense';
      return {
        id: i,
        sel: true,
        date: normalizeDate(row[c.dateCol]),
        description: (row[c.descCol] || '').replace(/^["']|["']$/g, '').slice(0, 80),
        amount,
        type,
        category: (type === 'income' ? INC_CATS : SCHEDULE_C)[0]?.code || '',
      };
    }).filter(r => r.amount > 0 && r.date);
    setRows(result);
  };

  const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
  const MAX_ROWS = 50000;

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError('');
    try {
      if (file.size > MAX_BYTES) {
        setUploadError(`File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 25 MB.`);
        e.target.value = '';
        return;
      }
      let text = await file.text();
      // Strip UTF-8 BOM if present
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const allRows = parseCSV(text);
      if (allRows.length < 2) {
        setUploadError('CSV appears empty or has no data rows.');
        e.target.value = '';
        return;
      }
      if (allRows.length > MAX_ROWS + 1) {
        setUploadError(`File has ${allRows.length - 1} rows. Maximum is ${MAX_ROWS}.`);
        e.target.value = '';
        return;
      }
      const headers = allRows[0].map(h => h.replace(/^["']|["']$/g, '').trim().toLowerCase());
      const dataRows = allRows.slice(1);
      const find = (pats) => headers.findIndex(h => pats.some(p => h.includes(p)));
      const detected = {
        dateCol: find(['date']),
        amtCol: find(['amount', 'amt', 'debit', 'credit']),
        descCol: find(['description', 'payee', 'merchant', 'memo', 'narrative', 'name']),
      };
      setRaw({ headers, rows: dataRows });
      setCols(detected);
      if (detected.dateCol >= 0 && detected.amtCol >= 0 && detected.descCol >= 0) {
        buildPreview(dataRows, detected);
        setStep('preview');
      } else {
        setStep('map');
      }
    } catch (err) {
      console.error('[csv-import] handleFile failed:', err);
      setUploadError('Could not read file: ' + (err.message || String(err)));
    } finally {
      e.target.value = '';
    }
  };

  const selCount = rows.filter(r => r.sel).length;

  const doImport = async () => {
    setSaving(true);
    const failures = [];
    let imported = 0;
    try {
      for (const r of rows.filter(r => r.sel)) {
        try {
          await onSave({ id: uid(), bizId, type: r.type, date: r.date, description: r.description, amount: r.amount, category: r.category, vendor: '', notes: '', scope: 'business', receiptFile: null, recurring: null });
          imported++;
        } catch (e) {
          failures.push(`Row ${r.id + 1} (${r.date} ${r.description}): ${e.message || String(e)}`);
        }
      }
      onDone(imported, failures);
    } finally { setSaving(false); }
  };

  return (
    <Modal title="Import from CSV" onClose={onClose} w={720}>
      <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={handleFile} />

      {step === 'upload' && (
        <div style={{ textAlign: 'center', padding: '40px 20px' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
          <p style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.6, marginBottom: 6 }}>Import transactions from your bank's CSV export.</p>
          <p style={{ color: '#64748b', fontSize: 12, marginBottom: 24 }}>Compatible with Chase, Bank of America, Wells Fargo, and most banks.<br />Negative amounts = Expense - Positive amounts = Income</p>
          {uploadError && (
            <div style={{ background: 'rgba(239,68,68,.12)', border: '1px solid rgba(239,68,68,.4)', color: '#fca5a5', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12, textAlign: 'left' }}>
              {uploadError}
            </div>
          )}
          <Btn onClick={() => fileRef.current?.click()}><I name="plus" size={15} /> Choose CSV File</Btn>
        </div>
      )}

      {step === 'map' && raw && (
        <div>
          <p style={{ color: '#f97316', fontSize: 13, marginBottom: 16 }}>Could not auto-detect all columns. Select which columns map to each field:</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 20 }}>
            {[['dateCol', 'Date (required)'], ['amtCol', 'Amount (required)'], ['descCol', 'Description (required)']].map(([key, label]) => (
              <Field key={key} label={label}>
                <select value={cols[key]} onChange={(e) => setCols({ ...cols, [key]: +e.target.value })} style={inp}>
                  <option value={-1}>Select column</option>
                  {raw.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Btn v="ghost" onClick={onClose}>Cancel</Btn>
            <Btn onClick={() => { buildPreview(raw.rows, cols); setStep('preview'); }} disabled={cols.dateCol < 0 || cols.amtCol < 0 || cols.descCol < 0}>Next</Btn>
          </div>
        </div>
      )}

      {step === 'preview' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 13, color: '#94a3b8' }}>{selCount} of {rows.length} rows selected</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <Btn v="ghost" onClick={() => setRows(rows.map(r => ({ ...r, sel: true })))}>All</Btn>
              <Btn v="ghost" onClick={() => setRows(rows.map(r => ({ ...r, sel: false })))}>None</Btn>
              <Btn v="ghost" onClick={() => fileRef.current?.click()}>New File</Btn>
            </div>
          </div>
          <div style={{ maxHeight: 360, overflowY: 'auto', borderRadius: 8, border: '1px solid rgba(255,255,255,.06)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ position: 'sticky', top: 0, background: 'rgba(15,15,26,.98)', zIndex: 1 }}>
                  {['', 'Date', 'Description', 'Amount', 'Type', 'Category'].map((h, i) => (
                    <th key={i} style={{ textAlign: i === 3 ? 'right' : i === 0 ? 'center' : 'left', padding: '8px 10px', fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: .6, borderBottom: '1px solid rgba(255,255,255,.08)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,.03)', opacity: r.sel ? 1 : 0.3 }}>
                    <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                      <input type="checkbox" checked={r.sel} onChange={(e) => setRows(rows.map(x => x.id === r.id ? { ...x, sel: e.target.checked } : x))} style={{ accentColor: '#6366f1' }} />
                    </td>
                    <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', color: '#94a3b8' }}>{r.date}</td>
                    <td style={{ padding: '6px 10px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: "'JetBrains Mono',monospace", fontWeight: 600, color: r.type === 'income' ? '#22c55e' : '#ef4444' }}>${r.amount.toFixed(2)}</td>
                    <td style={{ padding: '6px 10px' }}>
                      <select value={r.type} onChange={(e) => { const t2 = e.target.value; setRows(rows.map(x => x.id === r.id ? { ...x, type: t2, category: (t2 === 'income' ? INC_CATS : SCHEDULE_C)[0]?.code || '' } : x)); }} style={{ ...inp, width: 90, fontSize: 11, padding: '2px 6px' }}>
                        <option value="income">Income</option>
                        <option value="expense">Expense</option>
                      </select>
                    </td>
                    <td style={{ padding: '6px 10px' }}>
                      <select value={r.category} onChange={(e) => setRows(rows.map(x => x.id === r.id ? { ...x, category: e.target.value } : x))} style={{ ...inp, fontSize: 11, padding: '2px 6px' }}>
                        {(r.type === 'income' ? INC_CATS : SCHEDULE_C).map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <Btn v="ghost" onClick={onClose}>Cancel</Btn>
            <Btn v="green" onClick={doImport} disabled={selCount === 0 || saving}>
              {saving ? 'Importing...' : `Import ${selCount} Transaction${selCount !== 1 ? 's' : ''}`}
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}
function TxnForm({ type, prefill = {}, editId, bizId, bCons, onSave, onClose }) {
  const cats = type === "income" ? INC_CATS : SCHEDULE_C;
  const [f, setF] = useState({ description: prefill.description || "", vendor: prefill.vendor || "", date: prefill.date || td(), amount: prefill.amount || "", category: prefill.category || cats[0].code, notes: prefill.notes || "", scope: prefill.scope || "business", contractorId: prefill.contractorId || "", receiptFile: prefill.receiptFile || null, recurringEnabled: !!(prefill.recurring?.freq), recurringFreq: prefill.recurring?.freq || "monthly" });
  const [viewRcpt, setViewRcpt] = useState(false);
  const [scan, setScan] = useState({ busy: false, pct: 0, status: "", error: "" });
  const attachRef = useRef();
  const initialDate = useRef(prefill.date || null); // snapshot at mount; lets scanReceipt know whether the user has changed the date
  const attachReceipt = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setF((prev) => ({ ...prev, receiptFile: { data: reader.result.split(",")[1], mimeType: file.type, filename: file.name } }));
    reader.readAsDataURL(file); e.target.value = "";
    setScan({ busy: false, pct: 0, status: "", error: "" });
  };
  const scanReceipt = async (e) => {
    e?.preventDefault();
    e?.stopPropagation();
    console.log('[App] scanReceipt called. receiptFile =', f.receiptFile ? `${f.receiptFile.filename} (${f.receiptFile.mimeType})` : 'null');
    if (!f.receiptFile) { console.warn('[App] No receiptFile — aborting scan'); return; }
    if (scan.busy) { console.warn('[App] Scan already in progress — aborting'); return; }
    setScan({ busy: true, pct: 0, status: "Starting…", error: "" });

    const OCR_TIMEOUT_MS = 90_000;
    let timeoutId = null;
    const ocrPromise = ocrReceiptFile(f.receiptFile, ({ status, pct }) => {
      console.log('[App] OCR progress:', status, Math.round(pct * 100) + '%');
      setScan(s => ({ ...s, status, pct }));
    });
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        // Cancel the worker — otherwise it keeps running and chewing CPU
        try { ocrPromise.cancel?.(); } catch (_) {}
        reject(new Error('Scan timed out after 90s — try a clearer or smaller image'));
      }, OCR_TIMEOUT_MS);
    });

    try {
      const result = await Promise.race([ocrPromise, timeoutPromise]);
      // Clear the pending timeout — otherwise it would still fire and try to
      // cancel an already-finished worker.
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      console.log('[App] OCR result:', result);
      setF(prev => ({
        ...prev,
        // Only fill date if user hasn't changed it from its initial value
        ...(result.date && prev.date === initialDate.current && { date: result.date }),
        // Only fill amount if user hasn't typed anything yet
        ...(result.amount && !prev.amount && { amount: String(result.amount) }),
        ...(result.vendor && !prev.vendor && { vendor: result.vendor }),
        ...(result.description && !prev.description && { description: result.description }),
      }));
      setScan({ busy: false, pct: 1, status: "Done", error: "" });
    } catch (err) {
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      const msg = err?.message || err?.toString() || "OCR failed (unknown error)";
      console.error('[App] OCR error:', err);
      setScan({ busy: false, pct: 0, status: "", error: msg });
    }
  };
  return <Modal title={`${editId ? "Edit" : "Add"} ${type === "income" ? "Income" : "Expense"}`} onClose={onClose}>
    {prefill.receiptData && <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", background: "rgba(34,197,94,.1)", color: "#4ade80", fontSize: 13, fontWeight: 500, borderRadius: 8, marginBottom: 16 }}><I name="check" size={16} />Receipt scanned — confirm details.</div>}
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      <Field label="Date"><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={inp} /></Field>
      <Field label="Amount ($)"><input type="number" step=".01" placeholder="0.00" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={inp} /></Field>
      <Field label="Description" span><input placeholder="e.g. Web hosting" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} style={inp} /></Field>
      <Field label="Vendor"><input placeholder="e.g. Amazon" value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} style={inp} /></Field>
      <Field label="Category"><div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 11, height: 11, borderRadius: 3, background: type === "expense" ? (CAT_COLORS[f.category] || "#94a3b8") : "#22c55e", flexShrink: 0, transition: "background .2s" }} /><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} style={{ ...inp, flex: 1 }}>{cats.map((c) => <option key={c.code} value={c.code}>Ln {c.line}: {c.label}</option>)}</select></div></Field>
      <Field label="Scope"><select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} style={inp}><option value="business">Business</option><option value="personal">Personal</option></select></Field>
      {type === "expense" && bCons?.length > 0 && <Field label="Contractor"><select value={f.contractorId} onChange={(e) => setF({ ...f, contractorId: e.target.value })} style={inp}><option value="">None</option>{bCons.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
      <Field label="Notes" span><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} style={{ ...inp, resize: "vertical" }} /></Field>
      <Field label="Recurring" span>
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "6px 0" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", fontSize: 13, color: "#d1d5db", userSelect: "none" }}>
            <input type="checkbox" checked={f.recurringEnabled} onChange={(e) => setF({ ...f, recurringEnabled: e.target.checked })} style={{ width: 15, height: 15, cursor: "pointer", accentColor: "#6366f1" }} />
            Repeat automatically
          </label>
          {f.recurringEnabled && (
            <select value={f.recurringFreq} onChange={(e) => setF({ ...f, recurringFreq: e.target.value })} style={{ ...inp, width: 130 }}>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          )}
          {f.recurringEnabled && <span style={{ fontSize: 11, color: "#64748b" }}>Next: {calcNextDue(f.date || td(), f.recurringFreq)}</span>}
        </div>
      </Field>
      <Field label="Receipt / Document" span>
        <input ref={attachRef} type="file" accept="image/*,application/pdf" style={{ display: "none" }} onChange={attachReceipt} />
        {f.receiptFile
          ? <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "rgba(96,165,250,.08)", border: "1px solid #1d4ed8", borderRadius: 8, fontSize: 13 }}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📎 {f.receiptFile.filename}</span>
                <button onClick={() => setViewRcpt(true)} style={{ background: "transparent", border: "none", color: "#60a5fa", cursor: "pointer", fontSize: 12, textDecoration: "underline", whiteSpace: "nowrap" }}>view</button>
                <button onClick={() => { setF({ ...f, receiptFile: null }); setScan({ busy: false, pct: 0, status: "", error: "" }); }} style={{ background: "transparent", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap" }}>remove</button>
              </div>
              {scan.busy
                ? <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>{scan.status}</div>
                    <div style={{ height: 4, background: "#1e293b", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${Math.round(scan.pct * 100)}%`, background: "#6366f1", borderRadius: 4, transition: "width .3s" }} />
                    </div>
                  </div>
                : <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button type="button" onClick={scanReceipt} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", background: "rgba(99,102,241,.15)", border: "1px solid #4f46e5", borderRadius: 7, color: "#a5b4fc", cursor: "pointer", fontSize: 13, fontWeight: 500 }}>
                      🔍 Scan &amp; Auto-fill
                    </button>
                    {scan.status === "Done" && <span style={{ fontSize: 12, color: "#4ade80" }}>✓ Fields filled from receipt</span>}
                    {scan.error && <span style={{ fontSize: 12, color: "#f87171", wordBreak: "break-word", maxWidth: 260 }}>⚠ {scan.error}</span>}
                  </div>
              }
            </div>
          : <button onClick={() => attachRef.current?.click()} style={{ ...inp, textAlign: "left", cursor: "pointer", color: "#64748b", background: "transparent", border: "1px dashed #334155" }}>📎 Attach image or PDF receipt…</button>
        }
      </Field>
    </div>
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}><Btn v="ghost" onClick={onClose}>Cancel</Btn><Btn v="green" onClick={() => {
      if (!f.amount || !f.date) return;
      const { recurringEnabled, recurringFreq, ...data } = f;
      onSave({ id: editId || uid(), bizId, type, ...data, amount: parseFloat(data.amount) || 0, recurring: recurringEnabled ? { freq: recurringFreq, nextDue: calcNextDue(data.date, recurringFreq) } : null });
    }}><I name="check" size={15} /> {editId ? "Update" : "Save"}</Btn></div>
    {viewRcpt && f.receiptFile && <ReceiptViewer receipt={f.receiptFile} onClose={() => setViewRcpt(false)} />}
  </Modal>;
}
function MileForm({ editId, date: d, purpose: p, from: fr, to: t, miles: m, notes: n, bizId, onSave, onClose }) {
  const [f, setF] = useState({ date: d || td(), purpose: p || "", from: fr || "", to: t || "", miles: m || "", notes: n || "" });
  return <Modal title={`${editId ? "Edit" : "Log"} Trip`} onClose={onClose}><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}><Field label="Date"><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={inp} /></Field><Field label="Miles"><input type="number" step=".1" placeholder="0.0" value={f.miles} onChange={(e) => setF({ ...f, miles: e.target.value })} style={inp} /></Field><Field label="Purpose" span><input placeholder="Client meeting" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} style={inp} /></Field><Field label="From"><input placeholder="Start" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} style={inp} /></Field><Field label="To"><input placeholder="Dest" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} style={inp} /></Field><Field label="Notes" span><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} style={{ ...inp, resize: "vertical" }} /></Field></div><div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}><Btn v="ghost" onClick={onClose}>Cancel</Btn><Btn v="green" onClick={() => { if (!f.miles) return; onSave({ id: editId || uid(), bizId, ...f, miles: parseFloat(f.miles) || 0 }); }}><I name="check" size={15} /> {editId ? "Update" : "Save"}</Btn></div></Modal>;
}
function InvForm({ editId, date: d, clientName: cn, clientEmail: ce, description: desc, amount: a, status: st, dueDate: dd, bizId, onSave, onClose }) {
  const [f, setF] = useState({ date: d || td(), clientName: cn || "", clientEmail: ce || "", description: desc || "", amount: a || "", status: st || "Draft", dueDate: dd || "" });
  return <Modal title={`${editId ? "Edit" : "New"} Invoice`} onClose={onClose}><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}><Field label="Date"><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={inp} /></Field><Field label="Due"><input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} style={inp} /></Field><Field label="Client"><input placeholder="Name" value={f.clientName} onChange={(e) => setF({ ...f, clientName: e.target.value })} style={inp} /></Field><Field label="Email"><input placeholder="email" value={f.clientEmail} onChange={(e) => setF({ ...f, clientEmail: e.target.value })} style={inp} /></Field><Field label="Description" span><input placeholder="Services" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} style={inp} /></Field><Field label="Amount ($)"><input type="number" step=".01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={inp} /></Field><Field label="Status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} style={inp}>{INV_ST.map((s) => <option key={s}>{s}</option>)}</select></Field></div><div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}><Btn v="ghost" onClick={onClose}>Cancel</Btn><Btn v="green" onClick={() => { if (!f.amount) return; onSave({ id: editId || uid(), bizId, ...f, amount: parseFloat(f.amount) || 0 }); }}><I name="check" size={15} /> {editId ? "Update" : "Create"}</Btn></div></Modal>;
}
function ConForm({ editId, name: n, ein: e, email: em, phone: ph, address: ad, bizId, onSave, onClose }) {
  const [f, setF] = useState({ name: n || "", ein: e || "", email: em || "", phone: ph || "", address: ad || "" });
  return <Modal title={`${editId ? "Edit" : "Add"} Contractor`} onClose={onClose}><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}><Field label="Name" span><input placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={inp} /></Field><Field label="EIN"><input placeholder="XX-XXXXXXX" value={f.ein} onChange={(e) => setF({ ...f, ein: e.target.value })} style={inp} /></Field><Field label="Email"><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} style={inp} /></Field><Field label="Phone"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} style={inp} /></Field><Field label="Address" span><input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} style={inp} /></Field></div><div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}><Btn v="ghost" onClick={onClose}>Cancel</Btn><Btn v="green" onClick={() => { if (!f.name) return; onSave({ id: editId || uid(), bizId, ...f }); }}><I name="check" size={15} /> {editId ? "Update" : "Add"}</Btn></div></Modal>;
}
function GoalForm({ bizId, onSave, onClose }) {
  const [f, setF] = useState({ name: "", metric: "revenue", target: "", deadline: "" });
  return <Modal title="Set Goal" onClose={onClose} w={420}><div style={{ display: "flex", flexDirection: "column", gap: 14 }}><Field label="Goal"><input placeholder="e.g. $50K revenue" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={inp} /></Field><Field label="Metric"><select value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value })} style={inp}><option value="revenue">Revenue</option><option value="profit">Net Profit</option></select></Field><Field label="Target ($)"><input type="number" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} style={inp} /></Field><Field label="Deadline"><input type="date" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} style={inp} /></Field></div><div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}><Btn v="ghost" onClick={onClose}>Cancel</Btn><Btn v="green" onClick={() => { if (!f.name || !f.target) return; onSave({ id: uid(), bizId, ...f, target: parseFloat(f.target) || 0 }); }}><I name="check" size={15} /> Save</Btn></div></Modal>;
}
