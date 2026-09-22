import { useState, useEffect, useMemo } from 'react';
import { API_BASE } from './api';
import AddRuleForm from './AddRuleForm';
import {
    IconLandmark,
    IconClipboard,
    IconCard,
    IconUsers,
    IconFileText,
    IconRefresh,
    IconLogout,
    IconLock,
    IconAlert,
    IconFolder,
    IconPhone,
    IconClock,
    IconTicket,
    IconBuilding,
    IconInbox,
    IconPlus,
    IconList,
    IconX,
    IconChevronLeft,
    IconChevronRight,
    IconCheck,
    IconXCircle,
    IconChevronDown,
    IconArrowRight,
    IconSun,
    IconMoon,
    IconSparkles,
    IconExternalLink,
    IconShieldCheck,
    IconSearch,
} from './icons';
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
    const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
    
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [loginError, setLoginError] = useState('');
    const [requests, setRequests] = useState([]);
    const [loading, setLoading] = useState(false);
    const [fetchError, setFetchError] = useState('');
    const [query, setQuery] = useState('');
    const [service, setService] = useState('All');
    const [usageMetric, setUsageMetric] = useState('applications'); // applications | citizens | documents
    const [showCreate, setShowCreate] = useState(false);
    const [showRules, setShowRules] = useState(false);
    const [newCenter, setNewCenter] = useState({ center_code: '', center_name: '', district: '', email: '', password: '' });
    const [createMsg, setCreateMsg] = useState('');
    const [createOk, setCreateOk] = useState(null);
    const [viewDocs, setViewDocs] = useState(null); // { app: group, index: number }
    const [showChangePass, setShowChangePass] = useState(false);
    const [passCurrent, setPassCurrent] = useState('');
    const [passNew, setPassNew] = useState('');
    const [passConfirm, setPassConfirm] = useState('');
    const [passMsg, setPassMsg] = useState('');
    const [passOk, setPassOk] = useState(null);

    // Apply theme to document element
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
    }, [theme]);

    const toggleTheme = () => {
        setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
    };

    async function login(e, overrideEmail, overridePass) {
        if (e && e.preventDefault) e.preventDefault();
        setLoginError('');
        const userToLogin = overrideEmail || username;
        const passToLogin = overridePass || password;

        try {
            const res = await fetch(`${API_BASE}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: userToLogin, password: passToLogin })
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
            loadRequests();
        }
    }, [token]);

    // Header shadow on scroll
    useEffect(() => {
        const header = document.querySelector('.dash-header');
        if (!header) return;
        const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 16);
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    // Keyboard ESC for modal
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                if (viewDocs) setViewDocs(null);
                if (showChangePass) setShowChangePass(false);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [viewDocs, showChangePass]);

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
            setCreateOk(res.ok);
            setCreateMsg(res.ok ? data.message || 'Center created successfully' : data.error || 'Failed to create center');
            if (res.ok) setNewCenter({ center_code: '', center_name: '', district: '', email: '', password: '' });
        } catch {
            setCreateOk(false);
            setCreateMsg('Network error');
        }
    }

    async function handleChangePassword(e) {
        e.preventDefault();
        setPassMsg('');
        setPassOk(null);
        if (passNew !== passConfirm) {
            setPassOk(false);
            setPassMsg('New passwords do not match');
            return;
        }
        if (passNew.length < 6) {
            setPassOk(false);
            setPassMsg('New password must be at least 6 characters');
            return;
        }
        try {
            const res = await fetch(`${API_BASE}/api/auth/change-password`, {
                method: 'PUT',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword: passCurrent, newPassword: passNew })
            });
            const data = await res.json();
            if (res.ok) {
                setPassOk(true);
                setPassMsg('Password changed successfully');
                setPassCurrent('');
                setPassNew('');
                setPassConfirm('');
                setTimeout(() => setShowChangePass(false), 1500);
            } else {
                setPassOk(false);
                setPassMsg(data.error || 'Failed to change password');
            }
        } catch {
            setPassOk(false);
            setPassMsg('Network error');
        }
    }

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
            (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
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
                (g.centerCode || '').toLowerCase().includes(q) ||
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

    // Superadmin insight: per-center usage (applications, unique citizens,
    // documents, services). Derived from the same grouped applications as
    // the headline stats, so the numbers always agree.
    const centerUsage = useMemo(() => {
        const map = new Map();
        for (const g of groups) {
            const code = (g.centerCode || '—').trim() || '—';
            let u = map.get(code);
            if (!u) {
                u = { center: code, applications: 0, citizens: new Set(), documents: 0, services: new Set() };
                map.set(code, u);
            }
            u.applications += 1;
            if (g.phone) u.citizens.add(g.phone);
            u.documents += g.docs.length;
            u.services.add(g.category);
        }
        return [...map.values()]
            .map(u => ({
                center: u.center,
                applications: u.applications,
                citizens: u.citizens.size,
                documents: u.documents,
                services: u.services.size
            }))
            .sort((a, b) => b.applications - a.applications || a.center.localeCompare(b.center));
    }, [groups]);

    const groupedByService = useMemo(() => {
        const map = new Map();
        for (const g of filtered) {
            if (!map.has(g.category)) map.set(g.category, []);
            map.get(g.category).push(g);
        }
        return [...map.entries()];
    }, [filtered]);

    const listContent = useMemo(() => {
        if (filtered.length === 0) {
            return (
                <div className="empty">
                    <div className="empty-icon" aria-hidden="true"><IconInbox size={48} strokeWidth={1.5} /></div>
                    <h3>{loading ? 'Loading requests…' : 'No applications found'}</h3>
                    <p>{loading ? 'Retrieving citizen document submissions from Kerala Akshaya network.' : 'WhatsApp submissions and document uploads from citizens will appear here automatically.'}</p>
                </div>
            );
        }
        return groupedByService.map(([svc, items]) => (
            <section key={svc} className="service-group" aria-labelledby={`svc-${svc}`}>
                <h2 id={`svc-${svc}`}><IconFolder size={20} /> {svc} <span className="count">{items.length}</span></h2>
                <div className="cards">
                    {items.map((g, idx) => {
                        const name = g.name || 'Citizen Application';
                        return (
                            <article key={g.key} className="req-card" style={{animationDelay: `${idx * 30}ms`}} onClick={() => g.docs.some(d => d.url) && setViewDocs({ app: g, index: 0 })} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && g.docs.some(d => d.url) && setViewDocs({ app: g, index: 0 })}>
                                <div className="req-top">
                                    <div className="avatar" aria-hidden="true">{(g.name ? g.name[0] : g.phone[0] || '?').toUpperCase()}</div>
                                    <div className="req-user">
                                        <strong>{name}</strong>
                                        <a className="phone" href={`https://wa.me/${g.phone}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} aria-label={`Chat on WhatsApp with ${name}`}>
                                            <IconPhone size={13} /> {g.phone}
                                        </a>
                                    </div>
                                    <time className="time" dateTime={g.createdAt}><IconClock size={13} /> {timeAgo(g.createdAt)}</time>
                                </div>
                                <div className="req-meta">
                                    <span className="pill token" aria-label={`Token: ${g.token}`}><IconTicket size={13} /> {g.token}</span>
                                    <span className="pill center" aria-label={`Center: ${g.centerCode}`}><IconBuilding size={13} /> {g.centerCode}</span>
                                    {g.docs.length > 0 && <span className="pill docs-count" aria-label={`${g.docs.length} documents uploaded`}><IconFileText size={13} /> {g.docs.length} docs</span>}
                                </div>
                                <div className="docs">
                                    {g.docs.map((d, i) => d.url ? (
                                        <a key={i} className="doc-chip" href={d.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} aria-label={`View ${d.label}`}>
                                            <span className="doc-icon" aria-hidden="true"><IconFileText size={15} /></span>
                                            <span className="doc-label">{d.label}</span>
                                            <IconArrowRight size={15} className="doc-arrow-icon" aria-hidden="true" />
                                        </a>
                                    ) : (
                                        <span key={i} className="doc-chip muted" aria-label={`${d.label} (not available)`}>
                                            <span className="doc-icon" aria-hidden="true"><IconFileText size={15} /></span>
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
        ));
    }, [filtered, groupedByService, loading]);

    if (!token) {
        return (
            <div className="login-wrap">
                <div className="login-card">
                    <div className="login-logo" aria-hidden="true"><IconLandmark size={44} strokeWidth={1.8} /></div>
                    <div className="login-badge"><IconShieldCheck size={14} /> State Digital Portal</div>
                    <h1>Akshaya Sahayi</h1>
                    <p className="muted">Government of Kerala — Citizen Document Verification & E-Governance</p>
                    
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
                        {loginError && <div className="login-error" role="alert"><IconAlert size={16} /><span>{loginError}</span></div>}
                        <button className="btn-primary" type="submit" disabled={!username || !password}>
                            <span>Sign In to Dashboard</span>
                            <IconArrowRight size={16} />
                        </button>
                    </form>

                    <div className="demo-quick-section">
                        <div className="demo-title">Quick Demo Sign-In</div>
                        <div className="demo-buttons">
                            <button className="btn-demo" onClick={() => { setUsername('admin@akshaya.com'); setPassword('admin123'); login(null, 'admin@akshaya.com', 'admin123'); }}>
                                <IconSparkles size={14} /> Superadmin
                            </button>
                            <button className="btn-demo" onClick={() => { setUsername('center@akshaya.gov.in'); setPassword('center123'); login(null, 'center@akshaya.gov.in', 'center123'); }}>
                                <IconBuilding size={14} /> Center Official
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="dash">
            <header className="dash-header" role="banner">
                <div className="dash-header-brand">
                    <div className="dash-header-logo" aria-hidden="true"><IconLandmark size={24} strokeWidth={2} /></div>
                    <div>
                        <h1>Akshaya Sahayi</h1>
                        <div className="dash-header-subtitle">
                            <span>Centre <strong>{centerCode}</strong></span>
                            <span className="separator" aria-hidden="true">·</span>
                            <span>{role === 'superadmin' ? 'Superadmin Portal' : 'Official Portal'}</span>
                            <span className="live-indicator"><span className="pulse-dot" /> Live</span>
                        </div>
                    </div>
                </div>
                <div className="header-actions">
                    <button className="btn-ghost btn-icon-only" onClick={toggleTheme} title="Toggle Theme" aria-label="Toggle dark/light theme">
                        {theme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
                    </button>
                    {role !== 'superadmin' && (
                        <button className="btn-ghost" onClick={() => { setPassCurrent(''); setPassNew(''); setPassConfirm(''); setPassMsg(''); setShowChangePass(true); }}>
                            <IconLock size={15} /> Password
                        </button>
                    )}
                    <button className="btn-ghost" onClick={loadRequests} disabled={loading} aria-busy={loading}>
                        {loading ? (
                            <>
                                <span className="spinner" aria-hidden="true" /> Loading…
                            </>
                        ) : (
                            <>
                                <IconRefresh size={15} /> Refresh
                            </>
                        )}
                    </button>
                    <button className="btn-ghost" onClick={logout}><IconLogout size={15} /> Logout</button>
                </div>
            </header>

            {fetchError && <div className="login-error"><IconAlert size={18} /><span>{fetchError}</span></div>}

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
                            <div className="stat-icon" style={{background: 'rgba(59, 130, 246, 0.15)', color: 'var(--sapphire-main)'}} aria-hidden="true"><IconClipboard size={24} strokeWidth={2.2} /></div>
                            <div className="stat-content">
                                <span className="stat-num">{stats.submissions}</span>
                                <span className="stat-label">Applications</span>
                            </div>
                        </article>
                        <article className="stat">
                            <div className="stat-icon" style={{background: 'rgba(245, 158, 11, 0.15)', color: 'var(--kerala-gold)'}} aria-hidden="true"><IconCard size={24} strokeWidth={2.2} /></div>
                            <div className="stat-content">
                                <span className="stat-num">{stats.services}</span>
                                <span className="stat-label">Services</span>
                            </div>
                        </article>
                        <article className="stat">
                            <div className="stat-icon" style={{background: 'var(--emerald-subtle)', color: 'var(--emerald-main)'}} aria-hidden="true"><IconUsers size={24} strokeWidth={2.2} /></div>
                            <div className="stat-content">
                                <span className="stat-num">{stats.citizens}</span>
                                <span className="stat-label">Citizens</span>
                            </div>
                        </article>
                        <article className="stat">
                            <div className="stat-icon" style={{background: 'rgba(244, 63, 94, 0.15)', color: 'var(--danger-rose)'}} aria-hidden="true"><IconFileText size={24} strokeWidth={2.2} /></div>
                            <div className="stat-content">
                                <span className="stat-num">{stats.documents}</span>
                                <span className="stat-label">Documents</span>
                            </div>
                        </article>
                    </>
                )}
            </section>

            {role === 'superadmin' && (
                <section className="panel" aria-label="Center-wise usage">
                    <div className="panel-content usage-block">
                        <h2 className="usage-title"><IconBuilding size={18} /> Center-wise usage</h2>
                        {centerUsage.length === 0 ? (
                            <p className="muted">{loading ? 'Loading usage data…' : 'No usage data yet. Verified WhatsApp submissions will appear here per center.'}</p>
                        ) : (
                            <div className="usage-table-wrap">
                                <table className="usage-table">
                                    <thead>
                                        <tr>
                                            <th scope="col">Center</th>
                                            <th scope="col">Applications</th>
                                            <th scope="col">Citizens</th>
                                            <th scope="col">Documents</th>
                                            <th scope="col">Services</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {centerUsage.map(u => (
                                            <tr key={u.center}>
                                                <td><strong>{u.center}</strong></td>
                                                <td>{u.applications}</td>
                                                <td>{u.citizens}</td>
                                                <td>{u.documents}</td>
                                                <td>{u.services}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </section>
            )}

            {role === 'superadmin' && centerUsage.length > 0 && (
                <section className="panel" aria-label="Center usage graph">
                    <div className="panel-content usage-block">
                        <div className="usage-chart-head">
                            <h2 className="usage-title"><IconCard size={18} /> Usage graph</h2>
                            <div className="metric-tabs" role="group" aria-label="Chart metric">
                                {[
                                    ['applications', 'Applications'],
                                    ['citizens', 'Citizens'],
                                    ['documents', 'Documents'],
                                ].map(([key, label]) => (
                                    <button
                                        key={key}
                                        className={usageMetric === key ? 'metric-tab active' : 'metric-tab'}
                                        onClick={() => setUsageMetric(key)}
                                        aria-pressed={usageMetric === key}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="usage-chart">
                            {centerUsage.map(u => {
                                const value = u[usageMetric] || 0;
                                const max = Math.max(...centerUsage.map(x => x[usageMetric] || 0), 1);
                                return (
                                    <button
                                        key={u.center}
                                        className="ubar-row"
                                        onClick={() => { setService('All'); setQuery(u.center === '—' ? '' : u.center); }}
                                        title={`${u.center}: ${value} — click to filter the list below`}
                                    >
                                        <span className="ubar-label">{u.center}</span>
                                        <span className="ubar-track">
                                            <span className="ubar-fill" style={{ width: `${Math.max((value / max) * 100, value > 0 ? 4 : 0)}%` }} />
                                        </span>
                                        <span className="ubar-value">{value}</span>
                                    </button>
                                );
                            })}
                        </div>
                        <p className="muted usage-hint">Click a bar to filter the applications list by that center.</p>
                    </div>
                </section>
            )}

            <section className="toolbar" aria-label="Search and filters">
                <div className="search-wrapper">
                    <span className="search-icon"><IconSearch size={18} /></span>
                    <input
                        id="search"
                        className="search"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search by citizen name, phone, token ID, or service category…"
                    />
                    {query && (
                        <button className="search-clear-btn" onClick={() => setQuery('')} aria-label="Clear search">
                            <IconX size={16} />
                        </button>
                    )}
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
                                <span className="chip-count">{count}</span>
                            </button>
                        );
                    })}
                </div>
            </section>

            {role === 'superadmin' && (
                <section className="panel">
                    <button className="panel-toggle" onClick={() => setShowCreate(v => !v)} aria-expanded={showCreate}>
                        <span className="panel-title"><IconPlus size={16} /> Create Akshaya Center Account</span>
                        <span className="icon"><IconChevronDown size={16} /></span>
                    </button>
                    {showCreate && (
                        <div className="panel-content">
                            <form className="create-form" onSubmit={createCenter}>
                                <div className="form-group">
                                    <label className="form-label" htmlFor="ccode">Center code</label>
                                    <input id="ccode" placeholder="e.g. TST1" value={newCenter.center_code} onChange={e => setNewCenter({ ...newCenter, center_code: e.target.value })} required className="form-input" />
                                </div>
                                <div className="form-group">
                                    <label className="form-label" htmlFor="cname">Center name</label>
                                    <input id="cname" placeholder="e.g. Ernakulam Central Akshaya" value={newCenter.center_name} onChange={e => setNewCenter({ ...newCenter, center_name: e.target.value })} required className="form-input" />
                                </div>
                                <div className="form-group">
                                    <label className="form-label" htmlFor="cdistrict">District</label>
                                    <input id="cdistrict" placeholder="e.g. Ernakulam" value={newCenter.district} onChange={e => setNewCenter({ ...newCenter, district: e.target.value })} required className="form-input" />
                                </div>
                                <div className="form-group">
                                    <label className="form-label" htmlFor="cemail">Email</label>
                                    <input id="cemail" type="email" placeholder="center@akshaya.gov.in" value={newCenter.email} onChange={e => setNewCenter({ ...newCenter, email: e.target.value })} required className="form-input" />
                                </div>
                                <div className="form-group">
                                    <label className="form-label" htmlFor="cpassword">Password</label>
                                    <input id="cpassword" type="password" placeholder="Set a strong password" value={newCenter.password} onChange={e => setNewCenter({ ...newCenter, password: e.target.value })} required className="form-input" />
                                </div>
                                <button className="btn-primary" type="submit">Create Center Account</button>
                                {createMsg && (
                                    <p className={`create-msg ${createOk ? 'success' : 'error'}`} style={{gridColumn: '1 / -1', marginTop: '0.5rem'}}>
                                        {createOk ? <IconCheck size={15} /> : <IconXCircle size={15} />}
                                        <span>{createMsg}</span>
                                    </p>
                                )}
                            </form>
                        </div>
                    )}
                </section>
            )}

            <section className="panel">
                <button className="panel-toggle" onClick={() => setShowRules(v => !v)} aria-expanded={showRules}>
                    <span className="panel-title"><IconList size={16} /> Document verification guidelines for Center {centerCode}</span>
                    <span className="icon"><IconChevronDown size={16} /></span>
                </button>
                {showRules && <div className="panel-content"><AddRuleForm /></div>}
            </section>

            {listContent}

            {viewDocs && (
                <div className="doc-modal" role="dialog" aria-modal="true" aria-label="Document viewer">
                    <div className="doc-modal-backdrop" onClick={() => setViewDocs(null)} />
                    <div className="doc-modal-content">
                        <button className="doc-modal-close" onClick={() => setViewDocs(null)} aria-label="Close"><IconX size={18} /></button>
                        <div className="doc-modal-header">
                            <div>
                                <strong>{viewDocs.app.name || 'Citizen Application'}</strong>
                                <span className="muted"> · {viewDocs.app.phone}</span>
                            </div>
                            <span className="pill token"><IconTicket size={13} /> {viewDocs.app.token}</span>
                        </div>
                        <div className="doc-modal-carousel">
                            <button className="carousel-btn prev" onClick={e => { e.stopPropagation(); setViewDocs(v => v && ({...v, index: (v.index - 1 + v.app.docs.filter(d => d.url).length) % v.app.docs.filter(d => d.url).length})) }} aria-label="Previous" disabled={viewDocs.index === 0}><IconChevronLeft size={24} /></button>
                            <div className="carousel-viewport">
                                {viewDocs.app.docs.filter(d => d.url).map((d, i) => (
                                    <div key={i} className={`carousel-slide ${i === viewDocs.index ? 'active' : ''}`}>
                                        <img src={d.url} alt={d.label} onError={e => { e.target.style.display = 'none'; e.target.nextElementSibling.style.display = 'flex'; }} />
                                        <div className="image-error" style={{display: 'none', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)'}}>
                                            Failed to load document preview
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <button className="carousel-btn next" onClick={e => { e.stopPropagation(); const visible = viewDocs.app.docs.filter(d => d.url).length; setViewDocs(v => v && ({...v, index: (v.index + 1) % visible})) }} aria-label="Next" disabled={viewDocs.index === viewDocs.app.docs.filter(d => d.url).length - 1}><IconChevronRight size={24} /></button>
                        </div>
                        <div className="doc-modal-dots">
                            {viewDocs.app.docs.filter(d => d.url).map((_, i) => (
                                <button key={i} className={`dot ${i === viewDocs.index ? 'active' : ''}`} onClick={e => { e.stopPropagation(); setViewDocs(v => v && ({...v, index: i})) }} aria-label={`View document ${i + 1}`} />
                            ))}
                        </div>
                        <div className="doc-modal-info">
                            <span>{viewDocs.app.docs.filter(d => d.url)[viewDocs.index]?.label || 'Uploaded Document'}</span>
                            {viewDocs.app.docs.filter(d => d.url)[viewDocs.index]?.url && (
                                <a className="btn-ghost" href={viewDocs.app.docs.filter(d => d.url)[viewDocs.index]?.url} target="_blank" rel="noreferrer" style={{padding: '0.3rem 0.75rem', fontSize: '0.8rem'}}>
                                    <IconExternalLink size={14} /> Open Original
                                </a>
                            )}
                            <span>{viewDocs.index + 1} / {viewDocs.app.docs.filter(d => d.url).length}</span>
                        </div>
                    </div>
                </div>
            )}

            {showChangePass && (
                <div className="doc-modal" role="dialog" aria-modal="true" aria-label="Change password">
                    <div className="doc-modal-backdrop" onClick={() => setShowChangePass(false)} />
                    <div className="doc-modal-content" style={{maxWidth: '420px'}}>
                        <button className="doc-modal-close" onClick={() => setShowChangePass(false)} aria-label="Close"><IconX size={18} /></button>
                        <div className="doc-modal-header">
                            <h3 style={{margin: 0, fontSize: '18px'}}><IconLock size={18} /> Change Account Password</h3>
                        </div>
                        <form onSubmit={handleChangePassword} style={{padding: '1.25rem 0 0 0'}}>
                            <div className="form-group">
                                <label className="form-label" htmlFor="passCurrent">Current password</label>
                                <input id="passCurrent" type="password" value={passCurrent} onChange={e => setPassCurrent(e.target.value)} required autoComplete="current-password" className="form-input" />
                            </div>
                            <div className="form-group">
                                <label className="form-label" htmlFor="passNew">New password</label>
                                <input id="passNew" type="password" value={passNew} onChange={e => setPassNew(e.target.value)} required autoComplete="new-password" minLength={6} className="form-input" />
                            </div>
                            <div className="form-group">
                                <label className="form-label" htmlFor="passConfirm">Confirm new password</label>
                                <input id="passConfirm" type="password" value={passConfirm} onChange={e => setPassConfirm(e.target.value)} required autoComplete="new-password" className="form-input" />
                            </div>
                            {passMsg && (
                                <p className={`rules-status ${passOk ? 'success' : 'error'}`} style={{marginTop: '0.75rem'}}>
                                    {passOk ? <IconCheck size={15} /> : <IconXCircle size={15} />}
                                    <span>{passMsg}</span>
                                </p>
                            )}
                            <div style={{display: 'flex', gap: '0.75rem', marginTop: '1.25rem'}}>
                                <button type="button" className="btn-ghost" style={{flex: 1}} onClick={() => setShowChangePass(false)}>Cancel</button>
                                <button type="submit" className="btn-primary" style={{flex: 1}}>Save Password</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
