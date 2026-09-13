import { useState, useEffect, useMemo } from 'react';
import './App.css';
import { API_BASE, authHeaders } from './api';
import AddRuleForm from './AddRuleForm';

// Backend stores new entries as "label|url"; legacy rows are plain URLs.
function parseDoc(entry, index) {
    const text = String(entry || '');
    const sep = text.indexOf('|');
    if (sep > 0 && /^https?:\/\//i.test(text.slice(sep + 1).trim())) {
        return { label: text.slice(0, sep).trim() || `Doc ${index + 1}`, url: text.slice(sep + 1).trim() };
    }
    return { label: `Doc ${index + 1}`, url: text };
}

function timeAgo(value) {
    if (!value) return '';
    const diff = Date.now() - new Date(value).getTime();
    if (Number.isNaN(diff) || diff < 0) return '';
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(value).toLocaleDateString();
}

function avatarLetter(req) {
    const base = (req.citizen_name || req.citizen_phone || '?').trim();
    return (base.charAt(0) || '?').toUpperCase();
}

export default function App() {
    const [token, setToken] = useState(localStorage.getItem('token') || '');
    const [role, setRole] = useState(localStorage.getItem('role') || '');
    const [centerCode, setCenterCode] = useState(localStorage.getItem('center_code') || '');

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loginError, setLoginError] = useState('');

    const [requests, setRequests] = useState([]);
    const [fetchError, setFetchError] = useState('');
    const [loading, setLoading] = useState(false);

    const [search, setSearch] = useState('');
    const [serviceFilter, setServiceFilter] = useState('All');
    const [showCreate, setShowCreate] = useState(false);
    const [showRules, setShowRules] = useState(false);

    const [newCode, setNewCode] = useState('');
    const [newName, setNewName] = useState('');
    const [newDistrict, setNewDistrict] = useState('');
    const [newEmail, setNewEmail] = useState('');
    const [newPass, setNewPass] = useState('');

    const handleLogin = async (e) => {
        e.preventDefault();
        setLoginError('');
        try {
            const res = await fetch(`${API_BASE}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();
            if (data.token) {
                localStorage.setItem('token', data.token);
                localStorage.setItem('role', data.role);
                localStorage.setItem('center_code', data.center_code || '');
                setToken(data.token);
                setRole(data.role);
                setCenterCode(data.center_code || '');
            } else {
                setLoginError(data.message || 'Invalid login credentials');
            }
        } catch {
            setLoginError('Could not reach the server. Check your connection.');
        }
    };

    const handleLogout = () => {
        localStorage.clear();
        setToken('');
        setRole('');
        setCenterCode('');
        setRequests([]);
    };

    const loadRequests = async () => {
        if (!token) return;
        setLoading(true);
        try {
            const res = await fetch(`${API_BASE}/api/dashboard/requests`, {
                headers: authHeaders(token)
            });
            if (!res.ok) {
                const errorText = await res.text();
                throw new Error(`Error ${res.status}: ${errorText}`);
            }
            const data = await res.json();
            if (Array.isArray(data)) {
                setRequests(data);
                setFetchError('');
            } else {
                setRequests([]);
                setFetchError(data.error || data.message || 'Failed to load requests.');
            }
        } catch (err) {
            setRequests([]);
            setFetchError(err.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        // Initial load on login: fetch-once in effect is intentional.
        // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
        loadRequests();
    }, [token]);

    const handleCreateCenter = async (e) => {
        e.preventDefault();
        const res = await fetch(`${API_BASE}/api/admin/create-center`, {
            method: 'POST',
            headers: authHeaders(token),
            body: JSON.stringify({
                center_code: newCode,
                center_name: newName || `Akshaya ${newCode}`,
                district: newDistrict || 'Kerala',
                email: newEmail,
                password: newPass
            })
        });
        const data = await res.json();
        if (res.ok) {
            alert(data.message || 'Centre created & synced!');
            setNewCode(''); setNewName(''); setNewDistrict(''); setNewEmail(''); setNewPass('');
            setShowCreate(false);
        } else {
            alert(data.error || data.message);
        }
    };

    const services = useMemo(() => {
        const set = new Set();
        requests.forEach(r => { if (r.category) set.add(r.category); });
        return ['All', ...[...set].sort()];
    }, [requests]);

    const stats = useMemo(() => {
        const citizens = new Set(requests.map(r => r.citizen_phone).filter(Boolean));
        const docs = requests.reduce((n, r) => n + (Array.isArray(r.document_urls) ? r.document_urls.length : 0), 0);
        return {
            total: requests.length,
            services: services.length - 1,
            citizens: citizens.size,
            docs
        };
    }, [requests, services]);

    const visible = useMemo(() => {
        const q = search.trim().toLowerCase();
        return requests.filter(r => {
            if (serviceFilter !== 'All' && r.category !== serviceFilter) return false;
            if (!q) return true;
            return [r.citizen_name, r.citizen_phone, r.token_number, r.category, r.assigned_center_code]
                .some(v => String(v || '').toLowerCase().includes(q));
        });
    }, [requests, search, serviceFilter]);

    const grouped = useMemo(() => {
        const acc = {};
        visible.forEach(req => {
            const key = req.category || 'Other';
            acc[key] = acc[key] || [];
            acc[key].push(req);
        });
        Object.values(acc).forEach(list =>
            list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        );
        return Object.entries(acc).sort((a, b) => a[0].localeCompare(b[0]));
    }, [visible]);

    if (!token) {
        return (
            <div className="login-wrap">
                <div className="login-card">
                    <div className="login-logo">🏛️</div>
                    <h1>Akshaya Sahayi</h1>
                    <p className="muted">Centre dashboard sign in</p>
                    <form onSubmit={handleLogin}>
                        <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
                        <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required />
                        {loginError && <div className="login-error">{loginError}</div>}
                        <button type="submit" className="btn-primary">Login</button>
                    </form>
                </div>
            </div>
        );
    }

    return (
        <div className="dash">
            <header className="dash-header">
                <div>
                    <h1>🏛️ Akshaya Sahayi</h1>
                    <p className="muted">
                        {role === 'superadmin' ? 'Administrator' : `Centre ${centerCode || ''}`}
                    </p>
                </div>
                <div className="header-actions">
                    <button className="btn-ghost" onClick={loadRequests} disabled={loading}>
                        {loading ? 'Refreshing…' : '↻ Refresh'}
                    </button>
                    <button className="btn-ghost" onClick={handleLogout}>Logout</button>
                </div>
            </header>

            {fetchError && <div className="alert-error">⚠️ {fetchError}</div>}

            <section className="stats">
                <div className="stat"><span className="stat-num">{stats.total}</span><span className="stat-label">Submissions</span></div>
                <div className="stat"><span className="stat-num">{stats.services}</span><span className="stat-label">Services</span></div>
                <div className="stat"><span className="stat-num">{stats.citizens}</span><span className="stat-label">Citizens</span></div>
                <div className="stat"><span className="stat-num">{stats.docs}</span><span className="stat-label">Documents</span></div>
            </section>

            <section className="toolbar">
                <input
                    className="search"
                    placeholder="🔍 Search name, phone, token, service…"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                />
                <div className="chips">
                    {services.map(s => (
                        <button
                            key={s}
                            className={serviceFilter === s ? 'chip active' : 'chip'}
                            onClick={() => setServiceFilter(s)}
                        >
                            {s}
                        </button>
                    ))}
                </div>
            </section>

            {role === 'superadmin' && (
                <section className="panel">
                    <button className="panel-toggle" onClick={() => setShowCreate(v => !v)}>
                        {showCreate ? '▾' : '▸'} Create regional centre account
                    </button>
                    {showCreate && (
                        <form onSubmit={handleCreateCenter} className="create-form">
                            <input placeholder="Code (e.g. KNR-105)" value={newCode} onChange={e => setNewCode(e.target.value)} required />
                            <input placeholder="Centre name" value={newName} onChange={e => setNewName(e.target.value)} />
                            <input placeholder="District" value={newDistrict} onChange={e => setNewDistrict(e.target.value)} />
                            <input type="email" placeholder="Email" value={newEmail} onChange={e => setNewEmail(e.target.value)} required />
                            <input type="password" placeholder="Password" value={newPass} onChange={e => setNewPass(e.target.value)} required />
                            <button type="submit" className="btn-primary">Create &amp; Sync</button>
                        </form>
                    )}
                </section>
            )}

            <section className="panel">
                <button className="panel-toggle" onClick={() => setShowRules(v => !v)}>
                    {showRules ? '▾' : '▸'} Document guidelines for {centerCode || 'your centre'}
                </button>
                {showRules && <AddRuleForm />}
            </section>

            {grouped.length === 0 && !loading && (
                <div className="empty">No submissions yet. Verified WhatsApp documents will appear here.</div>
            )}

            {grouped.map(([category, list]) => (
                <section key={category} className="service-group">
                    <h2>📁 {category} <span className="count">{list.length}</span></h2>
                    <div className="cards">
                        {list.map(req => {
                            const docs = Array.isArray(req.document_urls) ? req.document_urls : [];
                            return (
                                <article key={req.id || req.token_number} className="req-card">
                                    <div className="req-top">
                                        <div className="avatar">{avatarLetter(req)}</div>
                                        <div className="req-user">
                                            <strong>{req.citizen_name || req.citizen_phone || 'Unknown'}</strong>
                                            {req.citizen_name && req.citizen_phone && (
                                                <a className="phone" href={`https://wa.me/${String(req.citizen_phone).replace(/\D/g, '')}`} target="_blank" rel="noreferrer">
                                                    📱 {req.citizen_phone}
                                                </a>
                                            )}
                                            {!req.citizen_name && <span className="muted">name not shared</span>}
                                        </div>
                                        <span className="time" title={req.created_at ? new Date(req.created_at).toLocaleString() : ''}>
                                            {timeAgo(req.created_at)}
                                        </span>
                                    </div>
                                    <div className="req-meta">
                                        <span className="pill">🎫 {req.token_number}</span>
                                        <span className="pill">🏢 {req.assigned_center_code}</span>
                                    </div>
                                    <div className="docs">
                                        {docs.length === 0 && <span className="muted">No documents attached</span>}
                                        {docs.map((d, idx) => {
                                            const { label, url } = parseDoc(d, idx);
                                            return url ? (
                                                <a key={idx} className="doc-chip" href={url} target="_blank" rel="noreferrer">
                                                    📄 {label}
                                                </a>
                                            ) : (
                                                <span key={idx} className="doc-chip muted">📄 {label}</span>
                                            );
                                        })}
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
