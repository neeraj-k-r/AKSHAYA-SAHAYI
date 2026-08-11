import React, { useState, useEffect } from 'react';

export default function AddRuleForm() {
    const [documentType, setDocumentType] = useState('Income Certificate');
    const [content, setContent] = useState('');
    const [status, setStatus] = useState('');

    // States for displaying and editing existing rules
    const [rules, setRules] = useState([]);
    const [editingId, setEditingId] = useState(null);
    const [editContent, setEditContent] = useState('');

    const centerId = localStorage.getItem('center_code');

    // Fetch existing rules when the component loads
    const fetchRules = async () => {
        if (!centerId) return;
        try {
            const response = await fetch(`http://localhost:5000/api/center-rules/${centerId}`);
            const data = await response.json();
            if (response.ok) {
                setRules(data);
            }
        } catch (error) {
            console.error("Failed to fetch rules:", error);
        }
    };

    useEffect(() => {
        fetchRules();
    }, [centerId]);

    // Handle adding a new rule
    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!centerId) {
            setStatus('❌ Error: No center ID found. Please log in again.');
            return;
        }

        setStatus('⏳ Saving rule & generating AI embeddings...');

        try {
            const response = await fetch('http://localhost:5000/api/add-rule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ documentType, content, centerId })
            });

            const result = await response.json();

            if (response.ok) {
                setStatus('✅ Rule successfully saved to the AI database!');
                setContent('');
                fetchRules(); // Refresh the list automatically!
            } else {
                setStatus(`❌ Error: ${result.error || 'Failed to save rule'}`);
            }
        } catch (error) {
            setStatus('❌ Network error. Make sure your server is running.');
        }
    };

    // Handle saving an edited rule
    const handleSaveEdit = async (id) => {
        setStatus('⏳ Updating rule & embeddings...');
        try {
            const response = await fetch(`http://localhost:5000/api/edit-rule/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: editContent })
            });

            if (response.ok) {
                setStatus('✅ Rule updated successfully!');
                setEditingId(null); // Close the edit box
                fetchRules(); // Refresh the list
            } else {
                setStatus('❌ Failed to update rule.');
            }
        } catch (error) {
            setStatus('❌ Network error while updating.');
        }
    };

    return (
        <div style={{ maxWidth: '700px', margin: '30px auto', padding: '20px', border: '1px solid #ccc', borderRadius: '8px', fontFamily: 'sans-serif', backgroundColor: '#fff' }}>

            {/* --- ADD RULE FORM --- */}
            <h2>Add Center Document Guidelines</h2>
            <p style={{ fontSize: '14px', color: '#666' }}>Posting as Center: <strong>{centerId || 'Not Logged In'}</strong></p>

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
                    <textarea rows="4" value={content} onChange={(e) => setContent(e.target.value)} placeholder="e.g., Requires original Ration Card and Aadhaar Card copy." style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #ccc' }} required />
                </div>
                <button type="submit" style={{ padding: '12px', backgroundColor: '#007BFF', color: '#FFF', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                    Save to AI Knowledge Base
                </button>
            </form>

            {status && <p style={{ fontWeight: 'bold', color: status.includes('❌') ? 'red' : 'green' }}>{status}</p>}

            <hr style={{ margin: '30px 0', border: 'none', borderTop: '1px solid #eee' }} />

            {/* --- SAVED RULES LIST --- */}
            <h2>Currently Active Services</h2>
            {rules.length === 0 ? (
                <p style={{ color: '#666' }}>No services added for this center yet.</p>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                    {rules.map((rule) => (
                        <div key={rule.id} style={{ padding: '15px', border: '1px solid #ddd', borderRadius: '6px', backgroundColor: '#fafafa' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                                <h3 style={{ margin: 0, color: '#333', fontSize: '16px' }}>📁 {rule.document_type}</h3>

                                {editingId !== rule.id && (
                                    <button
                                        onClick={() => { setEditingId(rule.id); setEditContent(rule.content); }}
                                        style={{ padding: '6px 12px', backgroundColor: '#ffc107', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                                    >
                                        Edit
                                    </button>
                                )}
                            </div>

                            {/* Toggles between text view and edit text-area */}
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