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
    const [createOk, setCreateOk] = useState(null);
    const [viewDocs, setViewDocs] = useState(null); // { app: group, index: number }
    const [showChangePass, setShowChangePass] = useState(false);
    const [passCurrent, setPassCurrent] = useState('');
    const [passNew, setPassNew] = useState('');
    const [passConfirm, setPassConfirm] = useState('');
    const [passMsg, setPassMsg] = useState('');
    const [passOk, setPassOk] = useState(null);

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

    // Header shadow on scroll
    useEffect(() => {
        const header = document.querySelector('.dash-header');
        if (!header) return;
        const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 16);
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

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
            setCreateMsg(res.ok ? data.message || 'Center created' : data.error || 'Failed');
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

    const listContent = useMemo(() => {
        if (filtered.length === 0) {
            return (
                <div className="empty">
                    <div className="empty-icon" aria-hidden="true"><IconInbox size={64} strokeWidth={1.5} /></div>
                    <h3>{loading ? 'Loading applications…' : 'No applications yet'}</h3>
                    <p>{loading ? 'Please wait while we fetch the latest data.' : 'Verified WhatsApp submissions will appear here once citizens upload documents.'}</p>
                </div>
            );
        }
        return groupedByService.map(([svc, items]) => (
            <section key={svc} className="service-group" aria-labelledby={`svc-${svc}`}>
                <h2 id={`svc-${svc}`}><IconFolder size={20} /> {svc} <span className="count">{items.length}</span></h2>
                <div className="cards">
                    {items.map((g, idx) => {
                        const name = g.name || 'Name not shared';
                        return (
                            <article key={g.key} className="req-card" style={{animationDelay: `${idx * 30}ms`}} onClick={() => g.docs.some(d => d.url) && setViewDocs({ app: g, index: 0 })} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && g.docs.some(d => d.url) && setViewDocs({ app: g, index: 0 })}>
                                <div className="req-top">
                                    <div className="avatar" aria-hidden="true">{(g.name ? g.name[0] : g.phone[0] || '?').toUpperCase()}</div>
                                    <div className="req-user">
                                        <strong>{name}</strong>
                                        <a className="phone" href={`https://wa.me/${g.phone}`} target="_blank" rel="noreferrer" aria-label={`Chat on WhatsApp with ${name}`}>
                                            <IconPhone size={14} /> {g.phone}
                                        </a>
                                    </div>
                                    <time className="time" dateTime={g.createdAt}><IconClock size={13} /> {timeAgo(g.createdAt)}</time>
                                </div>
                                <div className="req-meta">
                                    <span className="pill token" aria-label={`Token: ${g.token}`}><IconTicket size={13} /> {g.token}</span>
                                    <span className="pill center" aria-label={`Center: ${g.centerCode}`}><IconBuilding size={13} /> {g.centerCode}</span>
                                    {g.docs.length > 1 && <span className="pill docs-count" aria-label={`${g.docs.length} documents uploaded`}><IconFileText size={13} /> {g.docs.length} docs</span>}
                                </div>
                                <div className="docs">
                                    {g.docs.map((d, i) => d.url ? (
                                        <a key={i} className="doc-chip" href={d.url} target="_blank" rel="noreferrer" aria-label={`View ${d.label}`}>
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
                    <div className="login-logo" aria-hidden="true"><IconLandmark size={52} strokeWidth={1.6} /></div>
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
                        {loginError && <div className="login-error" role="alert"><IconAlert size={16} /><span>{loginError}</span></div>}
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
            <header className="dash-header" role="banner">
                <div className="dash-header-brand">
                    <div className="dash-header-logo" aria-hidden="true"><IconLandmark size={26} strokeWidth={2} /></div>
                    <div>
                        <h1>Akshaya Sahayi</h1>
                        <div className="dash-header-subtitle">
                            <span>Centre <strong>{centerCode}</strong></span>
                            <span className="separator" aria-hidden="true">·</span>
                            <span>{role === 'superadmin' ? 'Superadmin' : 'Center User'}</span>
                        </div>
                    </div>
                </div>
                <div className="header-actions">
                    {role !== 'superadmin' && (
                        <button className="btn-ghost" onClick={() => { setPassCurrent(''); setPassNew(''); setPassConfirm(''); setPassMsg(''); setShowChangePass(true); }}>
                            <IconLock size={16} /> Change Password
                        </button>
                    )}
                    <button className="btn-ghost" onClick={loadRequests} disabled={loading} aria-busy={loading}>
                        {loading ? (
                            <>
                                <span className="spinner" aria-hidden="true" />
                                Loading…
                            </>
                        ) : (
                            <>
                                <IconRefresh size={16} /> Refresh
                            </>
                        )}
                    </button>
                    <button className="btn-ghost" onClick={logout}><IconLogout size={16} /> Logout</button>
                </div>
            </header>

            {fetchError && <div className="alert-error"><IconAlert size={18} /><span>{fetchError}</span></div>}

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
                            <div className="stat-icon" style={{background: 'var(--brand-100)', color: 'var(--brand-700)'}} aria-hidden="true"><IconClipboard size={24} strokeWidth={2.2} /></div>
                            <div className="stat-content">
                                <span className="stat-num">{stats.submissions}</span>
                                <span className="stat-label">Applications</span>
                            </div>
                        </article>
                        <article className="stat">
                            <div className="stat-icon" style={{background: 'var(--accent-100)', color: 'var(--accent-700)'}} aria-hidden="true"><IconCard size={24} strokeWidth={2.2} /></div>
                            <div className="stat-content">
                                <span className="stat-num">{stats.services}</span>
                                <span className="stat-label">Services</span>
                            </div>
                        </article>
                        <article className="stat">
                            <div className="stat-icon" style={{background: 'var(--success-100)', color: 'var(--success-700)'}} aria-hidden="true"><IconUsers size={24} strokeWidth={2.2} /></div>
                            <div className="stat-content">
                                <span className="stat-num">{stats.citizens}</span>
                                <span className="stat-label">Citizens</span>
                            </div>
                        </article>
                        <article className="stat">
                            <div className="stat-icon" style={{background: 'var(--warn-100)', color: 'var(--warn-700)'}} aria-hidden="true"><IconFileText size={24} strokeWidth={2.2} /></div>
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
                    <button className="panel-toggle" onClick={() => setShowCreate(v => !v)} aria-expanded={showCreate}>
                        <span className="panel-title"><IconPlus size={16} /> Create Akshaya Center</span>
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
                                    <input id="cname" placeholder="e.g. Test Center" value={newCenter.center_name} onChange={e => setNewCenter({ ...newCenter, center_name: e.target.value })} required className="form-input" />
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
                                <button className="btn-primary" type="submit">Create Center</button>
                                {createMsg && (
                                    <p className={`create-msg ${createOk ? 'success' : 'error'}`}>
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
                    <span className="panel-title"><IconList size={16} /> Document guidelines for {centerCode}</span>
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
                            <strong>{viewDocs.app.name || 'Name not shared'}</strong>
                            <span className="muted"> · {viewDocs.app.phone}</span>
                        </div>
                        <span className="pill token"><IconTicket size={13} /> {viewDocs.app.token}</span>
                    </div>
                    <div className="doc-modal-carousel">
                        <button className="carousel-btn prev" onClick={e => { e.stopPropagation(); setViewDocs(v => v && ({...v, index: (v.index - 1 + v.app.docs.filter(d => d.url).length) % v.app.docs.filter(d => d.url).length})) }} aria-label="Previous" disabled={viewDocs.index === 0}><IconChevronLeft size={26} /></button>
                        <div className="carousel-viewport">
                            {viewDocs.app.docs.filter(d => d.url).map((d, i) => (
                                <div key={i} className={`carousel-slide ${i === viewDocs.index ? 'active' : ''}`}>
                                    <img src={d.url} alt={d.label} onError={e => { e.target.style.display = 'none'; e.target.nextElementSibling.style.display = 'flex'; }} />
                                    <div className="image-error" style={{display: 'none', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)'}}>
                                        Failed to load {d.label}
                                    </div>
                                </div>
                            ))}
                        </div>
                        <button className="carousel-btn next" onClick={e => { e.stopPropagation(); const visible = viewDocs.app.docs.filter(d => d.url).length; setViewDocs(v => v && ({...v, index: (v.index + 1) % visible})) }} aria-label="Next" disabled={viewDocs.index === viewDocs.app.docs.filter(d => d.url).length - 1}><IconChevronRight size={26} /></button>
                    </div>
                    <div className="doc-modal-dots">
                        {viewDocs.app.docs.filter(d => d.url).map((_, i) => (
                            <button key={i} className={`dot ${i === viewDocs.index ? 'active' : ''}`} onClick={e => { e.stopPropagation(); setViewDocs(v => v && ({...v, index: i})) }} aria-label={`View document ${i + 1}`} />
                        ))}
                    </div>
                    <div className="doc-modal-info">
                        <span>{viewDocs.app.docs.filter(d => d.url)[viewDocs.index]?.label || 'Document'}</span>
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
                        <h3 style={{margin: 0, fontSize: '18px'}}><IconLock size={18} /> Change Password</h3>
                    </div>
                    <form onSubmit={handleChangePassword} style={{padding: 'var(--space-5)'}}>
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
                            <p className={`create-msg ${passOk ? 'success' : 'error'}`} style={{marginTop: 'var(--space-3)'}}>
                                {passOk ? <IconCheck size={15} /> : <IconXCircle size={15} />}
                                <span>{passMsg}</span>
                            </p>
                        )}
                        <div style={{display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-4)'}}>
                            <button type="button" className="btn-ghost" style={{flex: 1}} onClick={() => setShowChangePass(false)}>Cancel</button>
                            <button type="submit" className="btn-primary" style={{flex: 1}}>Save</button>
                        </div>
                    </form>
                </div>
            </div>
        )}
        </div>
    );
}
