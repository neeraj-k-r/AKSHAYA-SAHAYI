import React, { useState, useEffect } from 'react';
import AddRuleForm from './AddRuleForm'; // Your AI Rule Form Component

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [role, setRole] = useState(localStorage.getItem('role') || '');

  // Login States
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Data State
  const [requests, setRequests] = useState([]);
  const [fetchError, setFetchError] = useState('');

  // Admin Form States
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newDistrict, setNewDistrict] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPass, setNewPass] = useState('');

  const handleLogin = async (e) => {
    e.preventDefault();
    const res = await fetch('http://localhost:5000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (data.token) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('role', data.role);
      setToken(data.token);
      setRole(data.role);
    } else alert(data.message);
  };

  const handleCreateCenter = async (e) => {
    e.preventDefault();
    const res = await fetch('http://localhost:5000/api/admin/create-center', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        center_code: newCode,
        center_name: newName || `Akshaya ${newCode}`,
        district: newDistrict || 'Kerala',
        email: newEmail,
        password: newPass
      }),
    });
    const data = await res.json();
    if (res.ok) {
      alert(data.message || 'Centre Created & Auto-Synced with WhatsApp / Kapso!');
      setNewCode(''); setNewName(''); setNewDistrict(''); setNewEmail(''); setNewPass('');
    } else {
      alert(data.error || data.message);
    }
  };

  useEffect(() => {
    if (token) {
      fetch('http://localhost:5000/api/dashboard/requests', {
        headers: { 'Authorization': `Bearer ${token}` }
      })
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data)) {
            setRequests(data);
            setFetchError('');
          } else {
            setRequests([]);
            setFetchError(data.error || data.message || 'Failed to load requests from server.');
          }
        })
        .catch(err => {
          setRequests([]);
          setFetchError(err.message);
        });
    }
  }, [token]);

  if (!token) {
    return (
      <div style={{ padding: '50px', fontFamily: 'sans-serif', maxWidth: '400px', margin: 'auto' }}>
        <h2>Akshaya Portal Login</h2>
        <form onSubmit={handleLogin}>
          <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <button type="submit" style={{ padding: '10px 20px', width: '100%', background: '#0056b3', color: 'white' }}>Login</button>
        </form>
      </div>
    );
  }

  const grouped = requests.reduce((acc, req) => {
    acc[req.category] = acc[req.category] || [];
    acc[req.category].push(req);
    return acc;
  }, {});

  return (
    <div style={{ padding: '30px', fontFamily: 'sans-serif', backgroundColor: '#f4f6f8', minHeight: '100vh' }}>
      <h1>Akshaya Dashboard {role === 'superadmin' ? '(ADMIN)' : ''}</h1>
      <button onClick={() => { localStorage.clear(); setToken(''); setRole(''); }} style={{ marginBottom: '20px' }}>Logout</button>

      {fetchError && (
        <div style={{ background: '#ffebee', color: '#c62828', padding: '15px', borderRadius: '5px', marginBottom: '20px', border: '1px solid #ef9a9a' }}>
          <strong>⚠️ Server Error:</strong> {fetchError}
        </div>
      )}

      {role === 'superadmin' && (
        <div style={{ background: '#fff', padding: '20px', marginBottom: '30px', border: '2px solid #0056b3', borderRadius: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h3 style={{ margin: 0 }}>Create Regional Centre Account</h3>
            <span style={{ background: '#e8f5e9', color: '#2e7d32', padding: '4px 10px', borderRadius: '12px', fontSize: '13px', fontWeight: 'bold' }}>
              ⚡ Auto-Syncs with Kapso / WhatsApp Bot
            </span>
          </div>
          <form onSubmit={handleCreateCenter} style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <input type="text" placeholder="Code (e.g. KNR-105)" value={newCode} onChange={e => setNewCode(e.target.value)} required style={{ padding: '8px', flex: '1' }} />
            <input type="text" placeholder="Centre Name (e.g. Kannur North)" value={newName} onChange={e => setNewName(e.target.value)} style={{ padding: '8px', flex: '1' }} />
            <input type="text" placeholder="District (e.g. Kannur)" value={newDistrict} onChange={e => setNewDistrict(e.target.value)} style={{ padding: '8px', flex: '1' }} />
            <input type="email" placeholder="Email" value={newEmail} onChange={e => setNewEmail(e.target.value)} required style={{ padding: '8px', flex: '1' }} />
            <input type="password" placeholder="Password" value={newPass} onChange={e => setNewPass(e.target.value)} required style={{ padding: '8px', flex: '1' }} />
            <button type="submit" style={{ padding: '8px 20px', background: '#0056b3', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
              Create & Sync
            </button>
          </form>
        </div>
      )}

      {/* ======================================================== */}
      {/* 🚀 NEW: RAG DOCUMENT RULES UPLOAD FORM                   */}
      {/* ======================================================== */}
      <div style={{ background: '#fff', marginBottom: '30px', borderRadius: '6px' }}>
        <AddRuleForm />
      </div>

      {Object.keys(grouped).map((category) => (
        <div key={category} style={{ background: '#fff', padding: '20px', marginBottom: '20px' }}>
          <h2 style={{ color: '#0056b3' }}>📁 {category.toUpperCase()}</h2>
          <table width="100%" cellPadding="10" style={{ textAlign: 'left', borderCollapse: 'collapse' }}>
            <thead style={{ background: '#eee' }}>
              <tr><th>Token</th><th>Centre</th><th>Phone</th><th>Documents</th></tr>
            </thead>
            <tbody>
              {grouped[category].map((req) => (
                <tr key={req.token_number} style={{ borderBottom: '1px solid #ddd' }}>
                  <td><b>{req.token_number}</b></td>
                  <td>{req.assigned_center_code}</td>
                  <td>{req.citizen_phone}</td>
                  <td>
                    {req.document_urls.map((url, idx) => (
                      <a key={idx} href={url} target="_blank" rel="noreferrer" style={{ marginRight: '10px' }}>📄 Doc {idx + 1}</a>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}