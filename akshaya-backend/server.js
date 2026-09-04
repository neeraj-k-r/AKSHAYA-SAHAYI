require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

// ==========================================
// 1. MIDDLEWARE
// ==========================================
app.use(cors());
app.use(express.json());

// ==========================================
// 2. AI & VECTOR DB SETUP (Gemini + Supabase)
// ==========================================
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// ==========================================
// 3. TOOL CONFIGURATIONS & DB SETUP
// ==========================================
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

let isDbConnected = false;
db.on('error', () => { isDbConnected = false; });

db.query('SELECT 1').then(async () => {
    isDbConnected = true;
    console.log("✅ Connected to PostgreSQL database.");
    try {
        await db.query(`
            INSERT INTO akshaya_centers (center_code, email, password_hash, center_name, district, role)
            VALUES ('HQ-001', 'admin@akshaya.com', '$2a$10$12345678901234567890zu', 'Akshaya HQ', 'Trivandrum', 'superadmin')
            ON CONFLICT (center_code) DO NOTHING;
        `);
    } catch (e) { }
}).catch(() => {
    isDbConnected = false;
    console.log("ℹ️ Cloud PostgreSQL unavailable. Running in Local Mode.");
});

const DB_FILE = path.join(__dirname, 'local_db.json');
function loadLocalDb() {
    if (fs.existsSync(DB_FILE)) {
        try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { }
    }
    const initialData = { centers: [], requests: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    return initialData;
}
const localData = loadLocalDb();
const fallbackCenters = localData.centers;
const fallbackRequests = localData.requests;

// ==========================================
// 4. AUTHENTICATION MIDDLEWARE
// ==========================================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        console.log("❌ Authentication Failed: No token provided in headers");
        return res.status(401).send("Unauthorized: No token provided");
    }

    jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, user) => {
        if (err) {
            console.error("❌ JWT Verification Failed:", err.message);
            return res.status(403).send(`Forbidden: ${err.message}`);
        }
        req.user = user;
        next();
    });
};

// =========================================================================
// DASHBOARD API: SAVE RULE & GENERATE EMBEDDINGS
// =========================================================================
app.post('/api/add-rule', async (req, res) => {
    try {
        const { documentType, content, centerId } = req.body;

        if (!content || !centerId) {
            return res.status(400).json({ error: "Missing content or centerId" });
        }

        console.log(`🌱 Generating embedding for [${documentType}] (Center: ${centerId})...`);

        const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-2" });
        const embedResult = await embeddingModel.embedContent(content);
        const vector = embedResult.embedding.values;

        const { data, error } = await supabase
            .from('document_rules')
            .insert([
                {
                    document_type: documentType,
                    content: content,
                    embedding: vector,
                    center_id: centerId
                }
            ]);

        if (error) throw error;

        console.log("✅ Saved to vector database!");
        res.json({ success: true, message: "Rule successfully stored in vector database!" });

    } catch (error) {
        console.error("❌ Add Rule Error:", error);
        res.status(500).json({ error: "Failed to store rule" });
    }
});

// Helper for wrapping external calls with a quick timeout
function withTimeout(promise, ms = 2500) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('TIMEOUT_EXCEEDED')), ms);
        promise.then(
            res => { clearTimeout(timer); resolve(res); },
            err => { clearTimeout(timer); reject(err); }
        );
    });
}

// =========================================================================
// KAPSO WEBHOOK: CHAT & RAG KNOWLEDGE BASE QUERY (WITH STRICT TIMEOUT)
// =========================================================================
app.post('/api/webhook/chat', async (req, res) => {
    console.log("========== CHAT WEBHOOK ==========");
    console.log("BODY RECEIVED:");
    console.log(JSON.stringify(req.body, null, 2));

    try {
        const userMessageRaw = req.body.message
            || req.body.text
            || req.body.query
            || req.body.Body
            || req.body.service
            || req.body.selected_service
            || req.body.list_reply?.title
            || req.body.interactive?.list_reply?.title
            || req.body.interactive?.button_reply?.title
            || "";
        const userMessage = String(userMessageRaw).replace(/Selected:\s*/i, "").trim();

        const centerIdRaw = req.body.center_id
            || req.body.center
            || req.body.centerId
            || req.body.center_code
            || req.body.assigned_center_code
            || "center_123";
        const centerId = String(centerIdRaw).replace(/Selected:\s*/i, "").trim();

        if (!userMessage) {
            return res.json({
                success: false,
                reply_message: "Please select a service."
            });
        }

        console.log(`💬 User Query: "${userMessage}" | Center: "${centerId}"`);

        // 1. Create a 15-second Kill-Switch
        const timeoutMs = 15000; // 15 seconds
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs)
        );

        // 2. Wrap all external API calls (Gemini & Supabase) in a single async task
        const processChatTask = async () => {
            let matchedRules = [];
            let rulesText = "";

            try {
                const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-2" });
                const embedResult = await withTimeout(embeddingModel.embedContent(userMessage), 3000);
                const queryEmbedding = embedResult.embedding.values;

                const { data, error: rpcError } = await withTimeout(
                    supabase.rpc('match_center_rules', {
                        query_embedding: queryEmbedding,
                        match_threshold: 0.4,
                        match_count: 3,
                        p_center_id: centerId
                    }),
                    3000
                );

                if (rpcError) {
                    console.warn("⚠️ Supabase match_center_rules RPC error:", rpcError.message || rpcError);
                } else if (data && data.length > 0) {
                    matchedRules = data;
                }
            } catch (embedOrRpcErr) {
                console.warn("⚠️ Embedding / Supabase RPC timed out or failed (using AI fallback):", embedOrRpcErr.message);
            }

            // Direct DB Fallback if RPC yielded no results (with 2s timeout)
            if (matchedRules.length === 0) {
                try {
                    const { data: dbRules } = await withTimeout(
                        supabase
                            .from('document_rules')
                            .select('content')
                            .ilike('document_type', `%${userMessage}%`)
                            .limit(3),
                        2000
                    );
                    if (dbRules && dbRules.length > 0) {
                        matchedRules = dbRules;
                    }
                } catch (fallbackDbErr) {
                    console.warn("⚠️ Supabase direct lookup skipped/timed out:", fallbackDbErr.message);
                }
            }

            if (matchedRules && matchedRules.length > 0) {
                rulesText = matchedRules.map(r => r.content).join('\n');
            }

            console.log("📋 Rules Found:", matchedRules?.length || 0);

            // Ask Gemini AI for requirements (works even if Supabase is offline/empty)
            const chatModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const prompt = `
You are an official Akshaya Center assistant in Kerala.
Citizen Request / Service: ${userMessage}
Akshaya Center Code: ${centerId}
${rulesText ? `Specific Center Guidelines:\n${rulesText}` : `Provide standard official Kerala Akshaya Center requirements for applying for "${userMessage}".`}

Instructions:
1. List only the essential required documents clearly using bullet points.
2. Provide a brief, polite explanation of next steps.
3. Keep the format clean and friendly for WhatsApp messages.
`;
            const aiResult = await chatModel.generateContent(prompt);
            return aiResult.response.text();
        };

        // 3. RACE: The AI processing vs The 15-Second Timer
        const finalReply = await Promise.race([processChatTask(), timeoutPromise]);

        console.log("✅ AI Reply Generated before timeout!");

        return res.json({
            success: true,
            reply_message: finalReply
        });

    } catch (error) {
        const isTimeout = error.message === "TIMEOUT";
        console.error(`❌ Chat Webhook ${isTimeout ? 'TIMEOUT' : 'ERROR'}:`, isTimeout ? "Took longer than 15s" : error.message);

        // ALWAYS return JSON so Kapso doesn't crash
        return res.json({
            success: true,
            reply_message: isTimeout
                ? "⏳ *System Busy:* I'm currently experiencing high traffic. Please wait a moment and try selecting the service again."
                : "I am ready to help! Please reply with the document or service you need assistance with."
        });
    }
});

// =========================================================================
// KAPSO WEBHOOK: RAG DOCUMENT VERIFICATION (ANTI-BOT HEADERS + ULTIMATE FALLBACK)
// =========================================================================
app.post('/api/webhook/document-upload', async (req, res) => {
    try {
        console.log("========== DOCUMENT UPLOAD WEBHOOK ==========");
        console.log("BODY RECEIVED:", JSON.stringify(req.body, null, 2));

        // 1. Broadly check for the image URL key
        let rawImageUrl = req.body.image_url || req.body.imageUrl || req.body.message?.image?.link || req.body.message?.kapso?.media_url || req.body.media_url || req.body.url;

        let imageUrl = null;

        // 2. SMART EXTRACTION: Pluck out only the actual 'https://' link
        if (rawImageUrl && typeof rawImageUrl === 'string') {
            const urlMatch = rawImageUrl.match(/(https?:\/\/[^\s"']+)/);
            if (urlMatch) {
                imageUrl = urlMatch[0];
            }
        }

        // 3. ULTIMATE FALLBACK: If Kapso mapped the variable wrong, scan the entire JSON payload for ANY link
        if (!imageUrl) {
            const bodyString = JSON.stringify(req.body);
            const fallbackMatch = bodyString.match(/(https?:\/\/[^\s"'>]+)/);
            if (fallbackMatch) {
                imageUrl = fallbackMatch[0];
                console.log("⚠️ Rescued URL via full body scan:", imageUrl);
            }
        }

        // 4. Rename variable so the AI knows it is a SERVICE, not the required document
        const serviceRequested = req.body.document_type || req.body.documentType || req.body.service || req.body.selected_service || "Income Certificate";
        const centerIdRaw = req.body.center_id || req.body.center || req.body.message?.center_id || "TST1";
        const centerId = String(centerIdRaw).replace(/Selected:\s*/i, "").trim();

        if (!imageUrl) {
            console.log("⚠️ CRITICAL: No image URL found anywhere in webhook payload.");
            return res.json({
                success: true,
                reply_message: "❌ *FAIL:* No image was detected. Please tap the paperclip or camera icon to snap a clear picture and try uploading again."
            });
        }

        console.log(`🔍 Downloading image from: ${imageUrl} (with 20s timeout & Anti-Bot headers)`);

        // 5. Download image buffer securely using Kapso API Key, Browser Headers, and Timeout
        let imageBuffer;
        const fetchController = new AbortController();
        const fetchTimeout = setTimeout(() => {
            fetchController.abort();
        }, 20000); // 20-second strict timeout

        const fetchHeaders = {
            'X-API-Key': process.env.KAPSO_API_KEY || '',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/jpeg, image/png, image/webp, */*'
        };

        try {
            let imgRes = await fetch(imageUrl, {
                headers: fetchHeaders,
                signal: fetchController.signal
            });

            if (!imgRes.ok) {
                console.log(`⚠️ Fetch with X-API-Key failed (Status: ${imgRes.status}). Trying plain fetch...`);
                // Retrying without X-API-Key but keeping browser headers
                const plainHeaders = { ...fetchHeaders };
                delete plainHeaders['X-API-Key'];

                imgRes = await fetch(imageUrl, {
                    headers: plainHeaders,
                    signal: fetchController.signal
                });

                if (!imgRes.ok) {
                    throw new Error(`HTTP error! status: ${imgRes.status}`);
                }
            }

            imageBuffer = await imgRes.arrayBuffer();
            clearTimeout(fetchTimeout);
            console.log("✅ Image successfully downloaded into buffer!");

        } catch (fetchErr) {
            clearTimeout(fetchTimeout);

            const isTimeout = fetchErr.name === 'AbortError' || fetchErr.message.includes('timeout');
            console.error(`❌ Image Download ${isTimeout ? 'TIMEOUT' : 'ERROR'}:`, fetchErr.message);

            return res.json({
                success: true,
                reply_message: isTimeout
                    ? "❌ *FAIL:* The document download timed out. Please check your internet connection and try uploading the image again."
                    : "❌ *FAIL:* Could not securely download the image file from WhatsApp's servers. Please re-upload your document."
            });
        }

        const base64Image = Buffer.from(imageBuffer).toString('base64');
        const mimeType = 'image/jpeg';

        // 6. Vision AI: Identify what the citizen actually uploaded
        const visionModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const visionPrompt = `Examine this uploaded document image. Identify exactly what type of document it is (e.g., Aadhaar Card, Ration Card, Income Certificate, PAN Card, etc.). Extract all visible text, check for official seal stamps, signatures, issue dates, and ID numbers. Summarize the key findings.`;

        const visionResult = await visionModel.generateContent([
            visionPrompt,
            { inlineData: { data: base64Image, mimeType: mimeType } }
        ]);
        const extractedDetails = visionResult.response.text();
        console.log("📝 Vision AI Extracted Details:", extractedDetails);

        // 7. Fetch rules safely using the new serviceRequested variable
        let rulesText = "";
        try {
            const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-2" });
            const embedResult = await embeddingModel.embedContent(serviceRequested);
            const queryEmbedding = embedResult.embedding.values;

            const { data: matchedRules, error: rpcError } = await supabase.rpc('match_center_rules', {
                query_embedding: queryEmbedding,
                match_threshold: 0.2,
                match_count: 3,
                p_center_id: centerId
            });

            if (!rpcError && matchedRules && matchedRules.length > 0) {
                rulesText = matchedRules.map(r => r.content).join('\n');
            } else {
                const { data: fallbackRules } = await supabase
                    .from('document_rules')
                    .select('content')
                    .eq('document_type', serviceRequested)
                    .limit(2);
                if (fallbackRules && fallbackRules.length > 0) {
                    rulesText = fallbackRules.map(r => r.content).join('\n');
                }
            }
        } catch (ruleErr) {
            console.warn("⚠️ Rule matching warning:", ruleErr.message);
        }

        if (!rulesText || rulesText.trim() === "") {
            rulesText = "Document must be a valid, clear official government certificate with visible text, issue date, and issuing authority seal.";
        }

        console.log("⚖️ Active Rules Used for Verification:", rulesText);

        // 8. Verification Agent: Strict prompt to prevent hallucination
        const verificationModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const verificationPrompt = `
You are an official Akshaya Center Document Verification AI Agent.

SERVICE REQUESTED BY CITIZEN: ${serviceRequested.toUpperCase()}

REQUIRED SUPPORTING DOCUMENTS FOR THIS SERVICE:
${rulesText}

EXTRACTED DETAILS FROM THE UPLOADED DOCUMENT:
${extractedDetails}

Instructions:
1. Identify what document the citizen actually uploaded based on the extracted details.
2. Check if this uploaded document matches ANY of the documents listed in the "REQUIRED SUPPORTING DOCUMENTS".
3. If YES, reply with "✅ *PASS:*" and a polite confirmation.
4. If NO, reply with "❌ *FAIL:*" and gently explain what they uploaded versus what is actually required.
5. CRITICAL RULE: The citizen is applying to GET a ${serviceRequested.toUpperCase()}. You must NEVER ask them to upload a ${serviceRequested.toUpperCase()}. You are ONLY checking their supporting documents.
`;

        const finalResult = await verificationModel.generateContent(verificationPrompt);
        const finalDecision = finalResult.response.text();

        console.log("🏁 Verification Verdict:", finalDecision);

        return res.json({
            success: true,
            reply_message: finalDecision
        });

    } catch (error) {
        console.error("🔥 CRITICAL DOCUMENT VERIFICATION CRASH:", error);
        return res.json({
            success: true,
            reply_message: "❌ *FAIL:* An internal error occurred while processing your document. Please ensure the image is clear and try uploading again."
        });
    }
});

// ==========================================
// LEGACY CLOUDINARY UPLOAD WEBHOOK 
// ==========================================
app.post('/api/webhook/document-upload-legacy', async (req, res) => {
    try {
        const payload = req.body;
        const phone_number = payload.message?.from || payload.conversation?.phone_number;
        const imageUrl = payload.message?.image?.link || payload.message?.kapso?.media_url;

        if (imageUrl && phone_number) {
            let permanentUrl = imageUrl;
            try {
                console.log("📥 Downloading image from WhatsApp/Kapso...");
                let buffer;
                const imgRes = await fetch(imageUrl, {
                    headers: {
                        'X-API-Key': process.env.KAPSO_API_KEY || '',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'image/jpeg, image/png, image/webp, */*'
                    }
                });

                if (imgRes.ok) {
                    buffer = Buffer.from(await imgRes.arrayBuffer());
                } else {
                    throw new Error(`Download failed with status ${imgRes.status}`);
                }

                const tempFilePath = path.join(__dirname, `temp_${Date.now()}.jpg`);
                fs.writeFileSync(tempFilePath, buffer);

                console.log("☁️ Uploading to Cloudinary...");
                const uploadResult = await cloudinary.uploader.upload(tempFilePath, { folder: 'akshaya_docs' });
                permanentUrl = uploadResult.secure_url;
                fs.unlinkSync(tempFilePath);
                console.log("✅ Successfully uploaded to Cloudinary!");
            } catch (cloudErr) {
                console.warn("⚠️ Upload Pipeline Failed:", cloudErr.message);
            }

            if (isDbConnected) {
                try {
                    const tokenNumber = `DOC-${Date.now().toString().slice(-6)}`;
                    await db.query(
                        `INSERT INTO service_requests (token_number, category, citizen_phone, document_urls, assigned_center_code) VALUES ($1, $2, $3, $4, $5)`,
                        [tokenNumber, 'Document', phone_number, [permanentUrl], 'HQ-001']
                    );
                    console.log("✅ Saved service request to Supabase!");
                } catch (dbErr) { console.error("🔥 DB Insert Error:", dbErr.message); }
            }
        }
        res.status(200).send('OK');
    } catch (error) { res.status(500).send('Internal Server Error'); }
});

// ==========================================
// DASHBOARD & AUTHENTICATION ENDPOINTS
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (email === 'admin@akshaya.com') {
            const token = jwt.sign({ email, role: 'superadmin' }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '12h' });
            return res.json({ token, role: 'superadmin', center_code: 'HQ-001' });
        }

        const result = await db.query('SELECT * FROM akshaya_centers WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(401).json({ message: 'Invalid credentials' });

        const user = result.rows[0];
        const validPass = await bcrypt.compare(password, user.password_hash);
        if (!validPass) return res.status(401).json({ message: 'Invalid credentials' });

        const token = jwt.sign({ email: user.email, role: user.role }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '12h' });
        res.json({ token, role: user.role, center_code: user.center_code });
    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ message: "Internal server error during login" });
    }
});

app.post('/api/admin/create-center', authenticateToken, async (req, res) => {
    try {
        const { center_code, center_name, district, email, password } = req.body;
        const hash = await bcrypt.hash(password, 10);
        await db.query(
            `INSERT INTO akshaya_centers (center_code, center_name, district, email, password_hash, role) VALUES ($1, $2, $3, $4, $5, 'admin')`,
            [center_code, center_name, district, email, hash]
        );
        res.json({ message: 'Center created successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/dashboard/requests', authenticateToken, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM service_requests ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// RULES MANAGEMENT ENDPOINTS
// ==========================================

// 1. Fetch all rules for a specific center
app.get('/api/center-rules/:centerId', async (req, res) => {
    try {
        const { centerId } = req.params;
        const { data, error } = await supabase
            .from('document_rules')
            .select('id, document_type, content')
            .eq('center_id', centerId)
            .order('id', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error("Fetch Rules Error:", error);
        res.status(500).json({ error: "Failed to fetch rules" });
    }
});

// 2. Edit an existing rule (Updates text AND regenerates AI embedding)
app.put('/api/edit-rule/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { content } = req.body;

        if (!content) return res.status(400).json({ error: "Content is required" });

        console.log(`🔄 Updating rule ID: ${id} and regenerating embeddings...`);

        const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-2" });
        const embedResult = await embeddingModel.embedContent(content);
        const vector = embedResult.embedding.values;

        const { error } = await supabase
            .from('document_rules')
            .update({ content: content, embedding: vector })
            .eq('id', id);

        if (error) throw error;

        res.json({ success: true, message: "Rule successfully updated!" });
    } catch (error) {
        console.error("Edit Rule Error:", error);
        res.status(500).json({ error: "Failed to update rule" });
    }
});

// ==========================================
// KAPSO DYNAMIC MENU ENDPOINTS
// ==========================================

app.get('/api/public/centers', async (req, res) => {
    try {
        let centersList = [];
        if (isDbConnected) {
            try {
                const result = await db.query('SELECT center_code, center_name, district FROM akshaya_centers ORDER BY center_name ASC');
                centersList = result.rows;
            } catch (dbErr) { isDbConnected = false; }
        }
        if (!isDbConnected || centersList.length === 0) {
            centersList = fallbackCenters;
        }
        res.json({ success: true, total: centersList.length, centers: centersList });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/bot/send-centers-menu', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ error: "Phone number is required" });

        let centersList = [];
        if (isDbConnected) {
            try {
                const result = await db.query('SELECT center_code, center_name, district FROM akshaya_centers ORDER BY center_name ASC LIMIT 10');
                centersList = result.rows;
            } catch (dbErr) { }
        }
        if (centersList.length === 0) centersList = fallbackCenters.slice(0, 10);

        const kapsoOptions = centersList.map(c => ({
            id: c.center_code,
            title: (c.center_name || c.center_code).substring(0, 24),
            description: `District: ${c.district}`.substring(0, 72)
        }));

        const payload = {
            "messaging_product": "whatsapp",
            "to": phone,
            "type": "interactive",
            "interactive": {
                "type": "list",
                "body": { "text": "Great! Please select your designated Akshaya Center:" },
                "action": {
                    "button": "View Centers",
                    "sections": [
                        { "title": "Available Centers", "rows": kapsoOptions }
                    ]
                }
            }
        };

        const kapsoUrl = `https://api.kapso.ai/meta/whatsapp/v24.0/${process.env.KAPSO_PHONE_ID}/messages`;
        const kapsoRes = await fetch(kapsoUrl, {
            method: 'POST',
            headers: {
                'X-API-Key': process.env.KAPSO_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!kapsoRes.ok) {
            console.error("🔥 Kapso API Error:", await kapsoRes.text());
            return res.status(500).json({ error: "Failed to push message via Kapso" });
        }

        console.log(`✅ Dynamically pushed Centers Menu to ${phone}`);
        res.json({ success: true, message: "Menu sent!" });

    } catch (error) {
        console.error("🔥 SEND MENU ERROR: ", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/bot/send-services-menu', async (req, res) => {
    try {
        const phoneRaw = req.body.phone || req.body.From || req.body.to || req.body.mobile || req.body.wa_id || "";
        const phone = String(phoneRaw).replace(/whatsapp:\+?/i, "").replace(/\+/g, "").trim();
        const center_id = req.body.center_id || req.body.center || req.body.centerId || "";

        if (!phone) return res.status(400).json({ error: "Phone number is required" });

        const cleanCenterId = (center_id || "").replace(/Selected:\s*/i, "").trim();
        console.log(`🔍 Fetching dynamic services for center: ${cleanCenterId}`);

        let uniqueServices = [];
        try {
            const { data, error } = await supabase
                .from('document_rules')
                .select('document_type')
                .eq('center_id', cleanCenterId);

            if (!error && data && data.length > 0) {
                uniqueServices = [...new Set(data.map(item => item.document_type))];
            }
        } catch (dbErr) {
            console.warn("⚠️ Could not fetch services from Supabase:", dbErr.message);
        }

        if (uniqueServices.length === 0) {
            console.log("⚠️ No services found for this center (or DB offline). Sending default options.");
            uniqueServices = ["Income Certificate", "Ration Card", "Aadhaar Card", "Caste Certificate", "Birth Certificate"];
        }

        const kapsoOptions = uniqueServices.slice(0, 10).map((service) => ({
            id: service.substring(0, 24),
            title: service.substring(0, 24),
            description: `Apply for ${service}`.substring(0, 72)
        }));

        const payload = {
            "messaging_product": "whatsapp",
            "to": phone,
            "type": "interactive",
            "interactive": {
                "type": "list",
                "body": { "text": "What service do you need?" },
                "action": {
                    "button": "View Services",
                    "sections": [
                        { "title": "Available Services", "rows": kapsoOptions }
                    ]
                }
            }
        };

        const kapsoUrl = `https://api.kapso.ai/meta/whatsapp/v24.0/${process.env.KAPSO_PHONE_ID}/messages`;
        const kapsoRes = await fetch(kapsoUrl, {
            method: 'POST',
            headers: {
                'X-API-Key': process.env.KAPSO_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!kapsoRes.ok) {
            console.error("🔥 Kapso API Error:", await kapsoRes.text());
            return res.status(500).json({ error: "Failed to push dynamic services via Kapso" });
        }

        console.log(`✅ Dynamically pushed Services Menu to ${phone}`);
        res.json({ success: true, message: "Dynamic Services Menu sent!" });

    } catch (error) {
        console.error("🔥 SEND SERVICES MENU ERROR: ", error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => {
    res.status(200).send('Bot is healthy and awake!');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));