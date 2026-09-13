import { useState, useEffect } from 'react';
import { API_BASE } from './api';

export default function AddRuleForm() {
    const [documentType, setDocumentType] = useState('Income Certificate');
    const [content, setContent] = useState('');
    const [status, setStatus] = useState('');

    // States for displaying and editing existing guidelines
    const [rules, setRules] = useState([]);
    const [editingId, setEditingId] = useState(null);
    const [editContent, setEditContent] = useState('');

    const centerId = localStorage.getItem('center_code');
    const API_BASE_URL = API_BASE;

    // Fetch active rules ONLY for this logged-in center
    const fetchRules = async () => {
        if (!centerId) return;
        try {
            const response = await fetch(`${API_BASE_URL}/api/center-rules/${centerId}`);
            if (response.ok) {
                const data = await response.json();
                setRules(data);
            }
        } catch (error) {
            console.error("Failed to fetch rules:", error);
        }
    };

    useEffect(() => {
        // Initial load on login: fetch-once in effect is intentional.
        // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
        fetchRules();
    }, [centerId]);

    // Handle adding a new rule tied to this center
    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!centerId) {
            setStatus('❌ Error: Not logged in properly.');
            return;
        }

        setStatus('⏳ Saving guideline & generating AI embeddings...');

        try {
            const response = await fetch(`${API_BASE_URL}/api/add-rule`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ documentType, content, centerId })
            });

            const result = await response.json();

            if (response.ok) {
                setStatus('✅ Service & Rules successfully added for your center!');
                setContent('');
                fetchRules();
            } else {
                setStatus(`❌ Error: ${result.error || 'Failed to save rule'}`);
            }
        } catch {
            setStatus('❌ Network error. Check server status.');
        }
    };

    // Handle saving an edited rule
    const handleSaveEdit = async (id) => {
        setStatus('⏳ Updating AI Agent embeddings...');
        try {
            const response = await fetch(`${API_BASE_URL}/api/edit-rule/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: editContent })
            });

            if (response.ok) {
                setStatus('✅ Rule updated successfully!');
                setEditingId(null);
                fetchRules();
            } else {
                setStatus('❌ Failed to update rule.');
            }
        } catch {
            setStatus('❌ Network error while updating.');
        }
    };

    if (!centerId) {
        return <div style={{ textAlign: 'center', marginTop: '50px' }}>⚠️ Please log in to manage your center's guidelines.</div>;
    }

    return (
        <div style={{ maxWidth: '800px', margin: '30px auto', padding: '25px', fontFamily: 'sans-serif', backgroundColor: '#fff', borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>

            <h2 style={{ textAlign: 'center', marginBottom: '5px' }}>Add Center Document Guidelines</h2>
            <p style={{ textAlign: 'center', color: '#666', fontSize: '14px', marginBottom: '25px' }}>
                Configuring rules for Center: <strong>{centerId}</strong>
            </p>

            {/* ADD RULE FORM */}
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginBottom: '20px' }}>
                <div>
                    <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Document Type:</label>
                    <select value={documentType} onChange={(e) => setDocumentType(e.target.value)} style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #ccc' }}>
                        <option value="Income Certificate">Income Certificate</option>
                        <option value="Ration Card">Ration Card</option>
                        <option value="Aadhaar Card">Aadhaar Card</option>
                        <option value="Caste Certificate">Caste Certificate</option>
                    </select>
                </div>
                <div>
                    <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Requirements & Instructions:</label>
                    <textarea
                        rows="4"
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder="e.g., Requires original Ration Card, Aadhaar Card copy, and recent salary certificate."
                        style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #ccc' }}
                        required
                    />
                </div>
                <button type="submit" style={{ padding: '12px', backgroundColor: '#007BFF', color: '#FFF', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                    Save to AI Knowledge Base
                </button>
            </form>

            {status && <p style={{ fontWeight: 'bold', textAlign: 'center', color: status.includes('❌') ? 'red' : 'green' }}>{status}</p>}

            <hr style={{ margin: '30px 0', border: 'none', borderTop: '1px solid #eee' }} />

            {/* ACTIVE SERVICES & INLINE EDITING */}
            <h3 style={{ textAlign: 'center', marginBottom: '20px' }}>Currently Active Services for {centerId}</h3>
            {rules.length === 0 ? (
                <p style={{ color: '#666', textAlign: 'center' }}>No services added for your center yet.</p>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                    {rules.map((rule) => (
                        <div key={rule.id} style={{ padding: '15px', border: '1px solid #ddd', borderRadius: '6px', backgroundColor: '#fafafa' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                                <h4 style={{ margin: 0, color: '#333' }}>📁 {rule.document_type}</h4>

                                {editingId !== rule.id && (
                                    <button
                                        onClick={() => { setEditingId(rule.id); setEditContent(rule.content); }}
                                        style={{ padding: '6px 14px', backgroundColor: '#ffc107', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                                    >
                                        Edit
                                    </button>
                                )}
                            </div>

                            {/* Toggles between view mode and editor mode */}
                            {editingId === rule.id ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                    <textarea
                                        rows="4"
                                        value={editContent}
                                        onChange={(e) => setEditContent(e.target.value)}
                                        style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #ccc' }}
                                    />
                                    <div style={{ display: 'flex', gap: '10px' }}>
                                        <button onClick={() => handleSaveEdit(rule.id)} style={{ padding: '8px 15px', backgroundColor: '#28a745', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Save Changes</button>
                                        <button onClick={() => setEditingId(null)} style={{ padding: '8px 15px', backgroundColor: '#dc3545', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Cancel</button>
                                    </div>
                                </div>
                            ) : (
                                <p style={{ margin: 0, color: '#555', whiteSpace: 'pre-wrap' }}>{rule.content}</p>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}