import React, { useState } from 'react';

export default function AddRuleForm() {
    const [documentType, setDocumentType] = useState('Income Certificate');
    const [content, setContent] = useState('');
    const [status, setStatus] = useState('');

    // Replace this with the logged-in center's ID dynamically when ready
    const centerId = "center_123";

    const handleSubmit = async (e) => {
        e.preventDefault();
        setStatus('⏳ Saving rule & generating AI embeddings...');

        try {
            // Use your local backend URL for testing, or your live Render URL in production
            const response = await fetch('http://localhost:5000/api/add-rule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ documentType, content, centerId })
            });

            const result = await response.json();

            if (response.ok) {
                setStatus('✅ Rule successfully saved to the AI database!');
                setContent(''); // Clear the text area
            } else {
                setStatus(`❌ Error: ${result.error || 'Failed to save rule'}`);
            }
        } catch (error) {
            console.error(error);
            setStatus('❌ Network error. Make sure your server.js is running.');
        }
    };

    return (
        <div style={{ maxWidth: '600px', margin: '30px auto', padding: '20px', border: '1px solid #ccc', borderRadius: '8px', fontFamily: 'sans-serif' }}>
            <h2>Add Center Document Guidelines</h2>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>

                <div>
                    <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Document Type:</label>
                    <select
                        value={documentType}
                        onChange={(e) => setDocumentType(e.target.value)}
                        style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #ccc' }}
                    >
                        <option value="Income Certificate">Income Certificate</option>
                        <option value="Ration Card">Ration Card</option>
                        <option value="Aadhaar Card">Aadhaar Card</option>
                        <option value="Caste Certificate">Caste Certificate</option>
                    </select>
                </div>

                <div>
                    <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Requirements & Instructions:</label>
                    <textarea
                        rows="6"
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder="e.g., Requires original Ration Card, Aadhaar Card copy, and recent salary certificate. Processing fee is ₹50."
                        style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #ccc' }}
                        required
                    />
                </div>

                <button
                    type="submit"
                    style={{ padding: '12px', backgroundColor: '#007BFF', color: '#FFF', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                    Save to AI Knowledge Base
                </button>
            </form>

            {status && <p style={{ marginTop: '15px', fontWeight: 'bold' }}>{status}</p>}
        </div>
    );
}