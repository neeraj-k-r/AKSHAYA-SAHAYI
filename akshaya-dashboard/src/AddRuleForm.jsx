import { useState, useEffect } from 'react';
import { API_BASE } from './api';
import {
    IconFileText,
    IconCheck,
    IconXCircle,
    IconAlert,
    IconPlus,
    IconList,
    IconPencil,
    IconX,
} from './icons';

function StatusMessage({ status, tone }) {
    if (!status) return null;
    return (
        <p className={`rules-status ${tone}`} role="status">
            {tone === 'pending' ? (
                <span className="rules-spinner" aria-hidden="true" />
            ) : tone === 'success' ? (
                <IconCheck size={15} />
            ) : (
                <IconXCircle size={15} />
            )}
            <span>{status}</span>
        </p>
    );
}

export default function AddRuleForm() {
    const [documentType, setDocumentType] = useState('Income Certificate');
    const [content, setContent] = useState('');
    const [status, setStatus] = useState('');
    const [statusTone, setStatusTone] = useState('');

    // States for displaying and editing existing guidelines
    const [rules, setRules] = useState([]);
    const [editingId, setEditingId] = useState(null);
    const [editContent, setEditContent] = useState('');

    const centerId = localStorage.getItem('center_code');

    // Fetch active rules ONLY for this logged-in center
    const fetchRules = async () => {
        if (!centerId) return;
        try {
            const response = await fetch(`${API_BASE}/api/center-rules/${centerId}`);
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
            setStatusTone('error');
            setStatus('Error: Not logged in properly.');
            return;
        }

        setStatusTone('pending');
        setStatus('Saving guideline & generating AI embeddings…');

        try {
            const response = await fetch(`${API_BASE}/api/add-rule`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ documentType, content, centerId })
            });

            const result = await response.json();

            if (response.ok) {
                setStatusTone('success');
                setStatus('Service & rules successfully added for your center!');
                setContent('');
                fetchRules();
            } else {
                setStatusTone('error');
                setStatus(`Error: ${result.error || 'Failed to save rule'}`);
            }
        } catch {
            setStatusTone('error');
            setStatus('Network error. Check server status.');
        }
    };

    // Handle saving an edited rule
    const handleSaveEdit = async (id) => {
        setStatusTone('pending');
        setStatus('Updating AI agent embeddings…');
        try {
            const response = await fetch(`${API_BASE}/api/edit-rule/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: editContent })
            });

            if (response.ok) {
                setStatusTone('success');
                setStatus('Rule updated successfully!');
                setEditingId(null);
                fetchRules();
            } else {
                setStatusTone('error');
                setStatus('Failed to update rule.');
            }
        } catch {
            setStatusTone('error');
            setStatus('Network error while updating.');
        }
    };

    if (!centerId) {
        return (
            <div className="rules-warning">
                <IconAlert size={18} />
                <span>Please log in to manage your center's guidelines.</span>
            </div>
        );
    }

    return (
        <div className="rules-form">
            <header className="rules-intro">
                <span className="rules-intro-icon" aria-hidden="true"><IconFileText size={22} /></span>
                <div>
                    <h2>Add Center Document Guidelines</h2>
                    <p>Configuring rules for centre <strong>{centerId}</strong></p>
                </div>
            </header>

            {/* ADD RULE FORM */}
            <form className="rules-add" onSubmit={handleSubmit}>
                <div className="form-group">
                    <label className="form-label" htmlFor="documentType">Document type</label>
                    <select
                        id="documentType"
                        className="form-input"
                        value={documentType}
                        onChange={(e) => setDocumentType(e.target.value)}
                    >
                        <option value="Income Certificate">Income Certificate</option>
                        <option value="Ration Card">Ration Card</option>
                        <option value="Aadhaar Card">Aadhaar Card</option>
                        <option value="Caste Certificate">Caste Certificate</option>
                    </select>
                </div>

                <div className="form-group">
                    <label className="form-label" htmlFor="documentContent">Requirements &amp; instructions</label>
                    <textarea
                        id="documentContent"
                        className="form-input rules-textarea"
                        rows="4"
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder="e.g., Requires original Ration Card, Aadhaar Card copy, and recent salary certificate."
                        required
                    />
                </div>

                <button type="submit" className="btn-primary">
                    <IconPlus size={16} /> Save to AI Knowledge Base
                </button>
            </form>

            <StatusMessage status={status} tone={statusTone} />

            <div className="rules-divider" />

            {/* ACTIVE SERVICES & INLINE EDITING */}
            <h3 className="rules-subhead">
                <IconList size={16} /> Currently active services for {centerId}
            </h3>

            {rules.length === 0 ? (
                <div className="rules-empty">
                    <IconFileText size={28} strokeWidth={1.5} />
                    <p>No services added for your center yet.</p>
                </div>
            ) : (
                <div className="rules-list">
                    {rules.map((rule) => (
                        <article key={rule.id} className="rule-card">
                            <div className="rule-card-head">
                                <h4><IconFileText size={16} /> {rule.document_type}</h4>
                                {editingId !== rule.id && (
                                    <button
                                        type="button"
                                        className="btn-ghost"
                                        onClick={() => { setEditingId(rule.id); setEditContent(rule.content); }}
                                    >
                                        <IconPencil size={14} /> Edit
                                    </button>
                                )}
                            </div>

                            {/* Toggles between view mode and editor mode */}
                            {editingId === rule.id ? (
                                <div className="rule-edit">
                                    <textarea
                                        className="form-input rules-textarea"
                                        rows="4"
                                        value={editContent}
                                        onChange={(e) => setEditContent(e.target.value)}
                                    />
                                    <div className="rule-edit-actions">
                                        <button type="button" className="btn-primary" onClick={() => handleSaveEdit(rule.id)}>
                                            <IconCheck size={15} /> Save Changes
                                        </button>
                                        <button type="button" className="btn-ghost" onClick={() => setEditingId(null)}>
                                            <IconX size={15} /> Cancel
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <p className="rule-content">{rule.content}</p>
                            )}
                        </article>
                    ))}
                </div>
            )}
        </div>
    );
}