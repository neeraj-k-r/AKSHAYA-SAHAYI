import { useState, useEffect, useMemo } from 'react';
import { API_BASE } from './api';
import AddRuleForm from './AddRuleForm';
import './App.css';

function timeAgo(iso) {
    if (!iso) return '';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

function digits(phone) {
    return String(phone || '').replace(/\D/g, '');
}

function displayNameRaw(r) {
    return (r.citizen_name || '').trim() || null;
}

function parseDoc(entry) {
    if (typeof entry === 'string' && entry.includes('|')) {
        const i = entry.indexOf('|');
        return { label: entry.slice(0, i) || 'Document', url: entry.slice(i + 1) || null };
    }
    return { label: 'Document', url: typeof entry === 'string' ? entry : null };
}

function rowDocs(r) {
    const urls = Array.isArray(r.document_urls) ? r.document_urls : [];
    if (urls.length === 0) return [{ label: 'Document', url: null }];
    return urls.map(parseDoc);
}

export default function App() {
    const [token, setToken] = useState(() => localStorage.getItem('token') || '');
    const [role, setRole] = useState(() => localStorage.getItem('role') || '');
    const [centerCode, setCenterCode] = useState(() => localStorage.getItem('center_code') || '');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [loginError, setLoginError] = useState('');
    const [requests, setRequests] = useState([]);
    const [loading, setLoading] = useState(false);
    const [fetchError, setFetchError] = useState('');
    const [query, setQuery] = useState('');
    const [service, setService] = useState('All');
    const [showCreate, setShowCreate] = useState(false);
    const [showRules, setShowRules] = useState(false);
    const [newCenter, setNewCenter] = useState({ center_code: '', center_name: '', district: '', email: '', password: '' });
    const [createMsg, setCreateMsg] = useState('');

    async function login(e) {
        e.preventDefault();
        setLoginError('');
        try {
            const res = await fetch(`${API_BASE}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: username, password })
            });
            const data = await res.json();
            if (!res.ok || !data.token) {
                setLoginError(data.message || data.error || 'Login failed');
                return;
            }
            localStorage.setItem('token', data.token);
            localStorage.setItem('role', data.role);
            localStorage.setItem('center_code', data.center_code);
            setToken(data.token);
            setRole(data.role);
            setCenterCode(data.center_code);
        } catch {
            setLoginError('Cannot reach server. Check connection.');
        }
    }

    function logout() {
        localStorage.removeItem('token');
        localStorage.removeItem('role');
        localStorage.removeItem('center_code');
        setToken('');
        setRole('');
        setCenterCode('');
        setRequests([]);
    }

    async function loadRequests() {
        // Use the live login-state token (not localStorage) so the
        // Authorization header is guaranteed whenever this screen shows.
        const tok = token || localStorage.getItem('token') || '';
        if (!tok) return;
        setLoading(true);
        setFetchError('');
        try {
            const res = await fetch(`${API_BASE}/api/dashboard/requests`, {
                headers: { Authorization: `Bearer ${tok}` }
            });
            const data = await res.json();
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) { logout(); return; }
                throw new Error(data.error || 'Failed to load');
            }
            setRequests(Array.isArray(data) ? data : []);
        } catch (err) {
            setFetchError(err.message);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        if (token) {
            // Initial load on login: fetch-once in effect is intentional.
            // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
            loadRequests();
        }
    }, [token]);

    async function createCenter(e) {
        e.preventDefault();
        setCreateMsg('');
        try {
            const res = await fetch(`${API_BASE}/api/admin/create-center`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(newCenter)
            });
            const data = await res.json();
            setCreateMsg(res.ok ? `✅ ${data.message}` : `❌ ${data.error || 'Failed'}`);
            if (res.ok) setNewCenter({ center_code: '', center_name: '', district: '', email: '', password: '' });
        } catch {
            setCreateMsg('❌ Network error');
        }
    }

    // One card per application: group rows by service + person + center,
    // merging every verified upload into a single document list.
    const groups = useMemo(() => {
        const map = new Map();
        const sorted = [...requests].sort(
            (a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0)
        );
        for (const r of sorted) {
            const key = [
                (r.category || 'Other').trim().toLowerCase(),
                digits(r.citizen_phone),
                (r.assigned_center_code || '').trim().toUpperCase()
            ].join('|');
            let g = map.get(key);
            if (!g) {
                g = {
                    key,
                    category: (r.category || '').trim() || 'Other service',
                    phone: digits(r.citizen_phone),
                    name: displayNameRaw(r),
                    centerCode: r.assigned_center_code || '—',
                    token: r.token_number || '—',
                    createdAt: r.created_at,
                    docs: []
                };
                map.set(key, g);
            }
            const nm = displayNameRaw(r);
            if (nm && !g.name) g.name = nm;
            if (r.token_number) g.token = r.token_number;
            if (r.created_at) g.createdAt = r.created_at;
            g.docs.push(...rowDocs(r));
        }
        return [...map.values()].sort(
            (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
        );
    }, [requests]);

    const services = useMemo(
        () => ['All', ...new Set(groups.map(g => g.category))],
        [groups]
    );

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return groups.filter(g => {
            if (service !== 'All' && g.category !== service) return false;
            if (!q) return true;
            return (
                g.phone.includes(q.replace(/\D/g, '')) ||
                (g.name || '').toLowerCase().includes(q) ||
                (g.token || '').toLowerCase().includes(q) ||
                g.category.toLowerCase().includes(q) ||
                g.docs.some(d => d.label.toLowerCase().includes(q))
            );
        });
    }, [groups, query, service]);

    const stats = useMemo(() => ({
        submissions: groups.length,
        services: new Set(groups.map(g => g.category)).size,
        citizens: new Set(groups.map(g => g.phone)).size,
        documents: groups.reduce((n, g) => n + g.docs.length, 0)
    }), [groups]);

    const groupedByService = useMemo(() => {
        const map = new Map();
        for (const g of filtered) {
            if (!map.has(g.category)) map.set(g.category, []);
            map.get(g.category).push(g);
        }
        return [...map.entries()];
    }, [filtered]);

    if (!token) {
        return (
            <div className="login-wrap">
                <div className="login-card">
                    <div className="login-logo" aria-hidden="true">🏛️</div>
                    <h1>Akshaya Sahayi</h1>
                    <p className="muted">Kerala Akshaya Center — Document Verification Dashboard</p>
                    <form onSubmit={login} noValidate>
                        <div className="form-group">
                            <label className="form-label" htmlFor="email">Email address</label>
                            <input
                                id="email"
                                type="email"
                                value={username}
                                onChange={e => setUsername(e.target.value)}
                                placeholder="center@akshaya.gov.in"
                                autoComplete="email"
                                required
                                autoFocus
                                className="form-input"
                            />
                        </div>
                        <div className="form-group">
                            <label className="form-label" htmlFor="password">Password</label>
                            <input
                                id="password"
                                type="password"
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                placeholder="Enter your password"
                                autoComplete="current-password"
                                required
                                className="form-input"
                            />
                        </div>
                        {loginError && <div className="login-error" role="alert">{loginError}</div>}
                        <button className="btn-primary" type="submit" disabled={!username || !password}>
                            <span>Sign In</span>
                        </button>
                    </form>
                    <p className="login-hint">Demo: admin@akshaya.com / any password</p>
                </div>
            </div>
        );
    }

    return (
        <div className="dash">
            <header className="dash-header">
                <div>
                    <h1>🏛️ Akshaya Sahayi</h1>
                    <p className="muted">Centre {centerCode}{role === 'superadmin' ? ' · Superadmin' : ''}</p>
                </div>
                <div className="header-actions">
                    <button className="btn-ghost" onClick={loadRequests} disabled={loading}>
                        {loading ? 'Loading…' : '⟳ Refresh'}
                    </button>
                    <button className="btn-ghost" onClick={logout}>Logout</button>
                </div>
            </header>

            {fetchError && <div className="alert-error">⚠️ {fetchError}</div>}

            <section className="stats" aria-label="Dashboard statistics" aria-busy={loading}>
                {loading ? (
                    <>
                        <article className="stat skeleton" aria-hidden="true"><div className="stat-icon loading-skeleton" /><div className="stat-content"><div className="loading-skeleton" style={{height: '32px', width: '60%'}} /><div className="loading-skeleton" style={{height: '14px', width: '40%'}} /></div></article>
                        <article className="stat skeleton" aria-hidden="true"><div className="stat-icon loading-skeleton" /><div className="stat-content"><div className="loading-skeleton" style={{height: '32px', width: '60%'}} /><div className="loading-skeleton" style={{height: '14px', width: '40%'}} /></div></article>
                        <article className="stat skeleton" aria-hidden="true"><div className="stat-icon loading-skeleton" /><div className="stat-content"><div className="loading-skeleton" style={{height: '32px', width: '60%'}} /><div className="loading-skeleton" style={{height: '14px', width: '40%'}} /></div></article>
                        <article className="stat skeleton" aria-hidden="true"><div className="stat-icon loading-skeleton" /><div className="stat-content"><div className="loading-skeleton" style={{height: '32px', width: '60%'}} /><div className="loading-skeleton" style={{height: '14px', width: '40%'}} /></div></article>
                    </>
                ) : (
                    <>
                        <article className="stat">
                            <div className="stat-icon" style={{background: 'var(--brand-100)', color: 'var(--brand-700)'}} aria-hidden="true">📋</div>
                            <div className="stat-content">
                                <span className="stat-num">{stats.submissions}</span>
                                <span className="stat-label">Applications</span>
                            </div>
                        </article>
                        <article className="stat">
                            <div className="stat-icon" style={{background: 'var(--accent-100)', color: 'var(--accent-700)'}} aria-hidden="true">🛂</div>
                            <div className="stat-content">
                                <span className="stat-num">{stats.services}</span>
                                <span className="stat-label">Services</span>
                            </div>
                        </article>
                        <article className="stat">
                            <div className="stat-icon" style={{background: 'var(--success-100)', color: 'var(--success-700)'}} aria-hidden="true">👥</div>
                            <div className="stat-content">
                                <span className="stat-num">{stats.citizens}</span>
                                <span className="stat-label">Citizens</span>
                            </div>
                        </article>
                        <article className="stat">
                            <div className="stat-icon" style={{background: 'var(--warn-100)', color: 'var(--warn-700)'}} aria-hidden="true">📄</div>
                            <div className="stat-content">
                                <span className="stat-num">{stats.documents}</span>
                                <span className="stat-label">Documents</span>
                            </div>
                        </article>
                    </>
                )}
            </section>

            <section className="toolbar" aria-label="Search and filters">
                <div className="search-wrapper">
                    <label htmlFor="search" className="visually-hidden">Search applications</label>
                    <input
                        id="search"
                        className="search"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search name, phone, token, service…"
                    />
                </div>
                <div className="chips" role="group" aria-label="Filter by service">
                    {services.map(s => {
                        const count = s === 'All' ? filtered.length : filtered.filter(g => g.category === s).length;
                        return (
                            <button
                                key={s}
                                className={service === s ? 'chip active' : 'chip'}
                                onClick={() => setService(s)}
                                aria-pressed={service === s}
                            >
                                {s}
                                {s !== 'All' && <span className="chip-count">{count}</span>}
                            </button>
                        );
                    })}
                </div>
            </section>

            {role === 'superadmin' && (
                <section className="panel">
                    <button className="panel-toggle" onClick={() => setShowCreate(v => !v)}>
                        {showCreate ? '▾' : '▸'} Create Akshaya Center
                    </button>
                    {showCreate && (
                        <form className="create-form" onSubmit={createCenter}>
                            <input placeholder="Center code" value={newCenter.center_code} onChange={e => setNewCenter({ ...newCenter, center_code: e.target.value })} required />
                            <input placeholder="Center name" value={newCenter.center_name} onChange={e => setNewCenter({ ...newCenter, center_name: e.target.value })} required />
                            <input placeholder="District" value={newCenter.district} onChange={e => setNewCenter({ ...newCenter, district: e.target.value })} required />
                            <input placeholder="Email" value={newCenter.email} onChange={e => setNewCenter({ ...newCenter, email: e.target.value })} required />
                            <input placeholder="Password" type="password" value={newCenter.password} onChange={e => setNewCenter({ ...newCenter, password: e.target.value })} required />
                            <button className="btn-primary" type="submit">Create</button>
                            {createMsg && <span className="muted">{createMsg}</span>}
                        </form>
                    )}
                </section>
            )}

            <section className="panel">
                <button className="panel-toggle" onClick={() => setShowRules(v => !v)}>
                    {showRules ? '▾' : '▸'} Document guidelines for {centerCode}
                </button>
                {showRules && <AddRuleForm />}
            </section>

            {filtered.length === 0 ? (
                <div className="empty">
                    <div className="empty-icon" aria-hidden="true">📭</div>
                    <h3>{loading ? 'Loading applications…' : 'No applications yet'}</h3>
                    <p>{loading ? 'Please wait while we fetch the latest data.' : 'Verified WhatsApp submissions will appear here once citizens upload documents.'}</p>
                </div>
            ) : groupedByService.map(([svc, items]) => (
                <section key={svc} className="service-group" aria-labelledby={`svc-${svc}`}>
                    <h2 id={`svc-${svc}`}>📁 {svc} <span className="count">{items.length}</span></h2>
                    <div className="cards">
                        {items.map((g, idx) => {
                            const name = g.name || 'Name not shared';
                            return (
                                <article key={g.key} className="req-card" style={{animationDelay: `${idx * 30}ms`}}>
                                    <div className="req-top">
                                        <div className="avatar" aria-hidden="true">{(g.name ? g.name[0] : g.phone[0] || '?').toUpperCase()}</div>
                                        <div className="req-user">
                                            <strong>{name}</strong>
                                            <a className="phone" href={`https://wa.me/${g.phone}`} target="_blank" rel="noreferrer" aria-label={`Chat on WhatsApp with ${name}`}>
                                                📱 {g.phone}
                                            </a>
                                        </div>
                                        <time className="time" dateTime={g.createdAt}>{timeAgo(g.createdAt)}</time>
                                    </div>
                                    <div className="req-meta">
                                        <span className="pill token" aria-label={`Token: ${g.token}`}>🎫 {g.token}</span>
                                        <span className="pill center" aria-label={`Center: ${g.centerCode}`}>🏢 {g.centerCode}</span>
                                        {g.docs.length > 1 && <span className="pill docs-count" aria-label={`${g.docs.length} documents uploaded`}>📄 {g.docs.length} docs</span>}
                                    </div>
                                    <div className="docs">
                                        {g.docs.map((d, i) => d.url ? (
                                            <a key={i} className="doc-chip" href={d.url} target="_blank" rel="noreferrer" aria-label={`View ${d.label}`}>
                                                <span className="doc-icon" aria-hidden="true">📄</span>
                                                <span className="doc-label">{d.label}</span>
                                                <span className="doc-arrow" aria-hidden="true">→</span>
                                            </a>
                                        ) : (
                                            <span key={i} className="doc-chip muted" aria-label={`${d.label} (not available)`}>
                                                <span className="doc-icon" aria-hidden="true">📄</span>
                                                <span className="doc-label">{d.label}</span>
                                                <span className="doc-badge" aria-hidden="true">—</span>
                                            </span>
                                        ))}
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                </section>
            ))}
        </div>
    );
}
