import { useCallback, useEffect, useState } from "react";

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
      ...options,
    });
  } catch {
    throw new Error("Cannot reach Pulseboard API (is it running on :5060?)");
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (!res.ok) {
      throw new Error(
        res.status === 500 || /internal server error/i.test(text)
          ? "Cannot reach Pulseboard API (is it running on :5060?)"
          : text.slice(0, 120) || res.statusText,
      );
    }
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function formatLatency(ms) {
  if (ms == null) return "—";
  return `${Math.round(ms)} ms`;
}

function formatTime(iso) {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusLabel(lastOk) {
  if (lastOk === true) return { text: "Up", className: "pill pill--up" };
  if (lastOk === false) return { text: "Down", className: "pill pill--down" };
  return { text: "Pending", className: "pill pill--pending" };
}

function siteHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function faviconSrc(url) {
  const host = siteHostname(url);
  if (!host) return "";
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`;
}

function SiteIcon({ url, name }) {
  const [failed, setFailed] = useState(false);
  const host = siteHostname(url);
  const src = faviconSrc(url);
  const letter = (name || host || "?").trim().charAt(0).toUpperCase() || "?";

  if (!src || failed) {
    return (
      <span className="site-icon site-icon--fallback" aria-hidden="true">
        {letter}
      </span>
    );
  }

  return (
    <img
      className="site-icon"
      src={src}
      alt=""
      width={56}
      height={56}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function formatUptime(pct) {
  if (pct == null) return "—";
  return `${pct.toFixed(pct % 1 === 0 ? 0 : 2)}%`;
}

/** Prepend https:// when the user omits a scheme. */
function normalizeMonitorUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return `https://${trimmed}`;
}

function CopyableUrl({ url, className = "monitor-row__url" }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const el = document.createElement("textarea");
      el.value = url;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.left = "-9999px";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button
      type="button"
      className={`${className}${copied ? " is-copied" : ""}`}
      onClick={handleCopy}
      title={copied ? "Copied" : "Click to copy"}
      aria-label={copied ? "URL copied" : `Copy URL ${url}`}
    >
      {copied ? "Copied" : url}
    </button>
  );
}

function routeName() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/stats" || path.startsWith("/stats/") || path === "/status" || path.startsWith("/status/")) {
    return "stats";
  }
  return "admin";
}

function StatisticsPage() {
  const [monitors, setMonitors] = useState([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await api("/api/monitors");
      setMonitors(data.monitors || []);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [load]);

  const totals = monitors.reduce(
    (acc, m) => {
      const s = m.stats || {};
      acc.samples += s.samples || 0;
      acc.upCount += s.upCount || 0;
      acc.downCount += s.downCount || 0;
      return acc;
    },
    { samples: 0, upCount: 0, downCount: 0 },
  );
  const overallUptime =
    totals.samples > 0
      ? Math.round((totals.upCount / totals.samples) * 10000) / 100
      : null;

  const q = query.trim().toLowerCase();
  const filtered = monitors.filter((m) => {
    if (!q) return true;
    const host = siteHostname(m.url).toLowerCase();
    return (
      (m.name || "").toLowerCase().includes(q) ||
      (m.url || "").toLowerCase().includes(q) ||
      host.includes(q)
    );
  });

  const sorted = [...filtered].sort((a, b) => {
    const ua = a.stats?.uptimePercent;
    const ub = b.stats?.uptimePercent;
    if (ua == null && ub == null) return a.name.localeCompare(b.name);
    if (ua == null) return 1;
    if (ub == null) return -1;
    return ua - ub || a.name.localeCompare(b.name);
  });

  return (
    <div className="app app--stats">
      <header className="brand">
        <a className="brand__name" href="/">Pulseboard</a>
        <p className="brand__tag">Statistics</p>
        <nav className="nav-links">
          <a href="/">Main</a>
        </nav>
      </header>

      {loading && monitors.length === 0 && <p className="muted">Loading…</p>}
      {error && <div className="alert alert--error">{error}</div>}

      {!loading && monitors.length === 0 && !error && (
        <p className="muted">No monitors yet. Add one from Main.</p>
      )}

      {monitors.length > 0 && (
        <>
          <section className="stats-summary">
            <h2 className="section__title">Overview</h2>
            <div className="stats-summary__grid">
              <div className="stats-summary__item">
                <span className="stats__key">Overall uptime</span>
                <span className="stats-summary__val">{formatUptime(overallUptime)}</span>
              </div>
              <div className="stats-summary__item">
                <span className="stats__key">Monitors</span>
                <span className="stats-summary__val">{monitors.length}</span>
              </div>
              <div className="stats-summary__item">
                <span className="stats__key">Checks</span>
                <span className="stats-summary__val">
                  {totals.upCount}/{totals.samples}
                </span>
              </div>
              <div className="stats-summary__item">
                <span className="stats__key">Failed</span>
                <span className="stats-summary__val">{totals.downCount}</span>
              </div>
            </div>
            <p className="muted stats-summary__note">
              Based on each monitor’s recent check history (up to 100 samples).
            </p>
          </section>

          <section className="section">
            <div className="section__head">
              <h2 className="section__title">By site</h2>
              <div className="field field--search">
                <label htmlFor="stats-search" className="sr-only">Search sites</label>
                <input
                  id="stats-search"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search name or URL"
                  autoComplete="off"
                />
              </div>
            </div>
            {q && (
              <p className="muted stats-filter-meta">
                {sorted.length} of {monitors.length} site{monitors.length === 1 ? "" : "s"}
              </p>
            )}
            <div className="stats-table-wrap">
              <table className="stats-table">
                <thead>
                  <tr>
                    <th>Site</th>
                    <th>Uptime</th>
                    <th>Checks</th>
                    <th>Failed</th>
                    <th>Avg latency</th>
                    <th>Range</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((m) => {
                    const st = statusLabel(m.lastOk);
                    const s = m.stats || {};
                    return (
                      <tr key={m.id}>
                        <td>
                          <div className="stats-table__site">
                            <SiteIcon url={m.url} name={m.name} />
                            <div>
                              <strong>{m.name}</strong>
                              <CopyableUrl url={m.url} />
                            </div>
                          </div>
                        </td>
                        <td className="stats-table__num">{formatUptime(s.uptimePercent)}</td>
                        <td className="stats-table__num">
                          {s.samples ? `${s.upCount}/${s.samples}` : "—"}
                        </td>
                        <td className="stats-table__num">{s.samples ? s.downCount : "—"}</td>
                        <td className="stats-table__num">{formatLatency(s.avgLatencyMs)}</td>
                        <td className="stats-table__num">
                          {s.minLatencyMs != null
                            ? `${formatLatency(s.minLatencyMs)} – ${formatLatency(s.maxLatencyMs)}`
                            : "—"}
                        </td>
                        <td>
                          <span className={st.className}>{st.text}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {sorted.length === 0 && (
              <p className="muted stats-filter-empty">No sites match “{query.trim()}”.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function AdminPage() {
  const [monitors, setMonitors] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    name: "",
    url: "",
    intervalSec: "60",
    timeoutMs: "5000",
    expectedStatus: "200",
  });

  const load = useCallback(async () => {
    try {
      const data = await api("/api/monitors");
      setMonitors(data.monitors || []);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [load]);

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleCreate(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const url = normalizeMonitorUrl(form.url);
    setForm((prev) => ({ ...prev, url }));
    try {
      await api("/api/monitors", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          url,
          intervalSec: Number(form.intervalSec),
          timeoutMs: Number(form.timeoutMs),
          expectedStatus: Number(form.expectedStatus),
        }),
      });
      setForm({
        name: "",
        url: "",
        intervalSec: "60",
        timeoutMs: "5000",
        expectedStatus: "200",
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("Delete this monitor?")) return;
    setError("");
    try {
      await api(`/api/monitors/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function addExample() {
    setBusy(true);
    setError("");
    try {
      await api("/api/monitors", {
        method: "POST",
        body: JSON.stringify({
          name: "Example",
          url: "https://example.com",
          intervalSec: 60,
          timeoutMs: 5000,
          expectedStatus: 200,
        }),
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="brand">
        <h1 className="brand__name">Pulseboard</h1>
        <p className="lead">Watch your endpoints. Track uptime across every site.</p>
        <nav className="nav-links">
          <a className="status-link" href="/stats">Statistics →</a>
        </nav>
      </header>

      <section className="section">
        <h2 className="section__title">Add monitor</h2>
        <form className="composer" onSubmit={handleCreate}>
          <div className="controls">
            <div className="field field--wide">
              <label htmlFor="name">Name</label>
              <input
                id="name"
                required
                maxLength={120}
                value={form.name}
                onChange={(e) => updateField("name", e.target.value)}
                placeholder="API"
              />
            </div>
            <div className="field field--wide">
              <label htmlFor="url">URL</label>
              <input
                id="url"
                type="text"
                inputMode="url"
                autoComplete="url"
                required
                value={form.url}
                onChange={(e) => updateField("url", e.target.value)}
                onBlur={() => updateField("url", normalizeMonitorUrl(form.url))}
                placeholder="example.com or https://example.com/health"
              />
            </div>
            <div className="field">
              <label htmlFor="interval">Interval (sec)</label>
              <input
                id="interval"
                type="number"
                min={30}
                max={3600}
                required
                value={form.intervalSec}
                onChange={(e) => updateField("intervalSec", e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="timeout">Timeout (ms)</label>
              <input
                id="timeout"
                type="number"
                min={500}
                max={60000}
                required
                value={form.timeoutMs}
                onChange={(e) => updateField("timeoutMs", e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="expected">Expected status</label>
              <input
                id="expected"
                type="number"
                min={100}
                max={599}
                required
                value={form.expectedStatus}
                onChange={(e) => updateField("expectedStatus", e.target.value)}
              />
            </div>
          </div>
          <div className="actions">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add monitor"}
            </button>
          </div>
          <p className="muted form-tip">
            Tip: paste <code>mysite.com</code> — <code>https://</code> is added automatically.
            Use <code>http://</code> when you need plain HTTP.
          </p>
        </form>
      </section>

      {error && (
        <div className="alert alert--error">
          {error}
          {/Cannot reach Pulseboard API/i.test(error) && (
            <p className="alert__hint">
              Start the stack with <code>npm run setup && npm run dev</code> from the Pulseboard folder.
            </p>
          )}
        </div>
      )}

      <section className="section">
        <h2 className="section__title">Monitors</h2>
        {loading && monitors.length === 0 && <p className="muted">Loading…</p>}
        {!loading && monitors.length === 0 && !error && (
          <div className="empty-state">
            <p className="muted">No monitors yet. Add a URL above, or try a quick example.</p>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={addExample}
            >
              {busy ? "Adding…" : "Add example.com"}
            </button>
          </div>
        )}
        <ul className="monitor-list">
          {monitors.map((m) => {
            const st = statusLabel(m.lastOk);
            return (
              <li key={m.id} className="monitor-row">
                <SiteIcon url={m.url} name={m.name} />
                <div className="monitor-row__main">
                  <strong>{m.name}</strong>
                  <CopyableUrl url={m.url} />
                  <span className="monitor-row__sub muted">
                    every {m.intervalSec}s · last {formatTime(m.lastCheckAt)}
                    {m.openIncident ? ` · incident: ${m.openIncident.message}` : ""}
                  </span>
                </div>
                <div className="monitor-row__meta">
                  <span className={st.className}>{st.text}</span>
                  <span className="muted">{formatLatency(m.lastLatencyMs)}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => handleDelete(m.id)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

export default function App() {
  const route = routeName();
  if (route === "stats") return <StatisticsPage />;
  return <AdminPage />;
}
