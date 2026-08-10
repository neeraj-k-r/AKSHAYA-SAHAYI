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

// =========================================================================
// KAPSO WEBHOOK: CHAT & RAG KNOWLEDGE BASE QUERY
// =========================================================================
app.post('/api/webhook/chat', async (req, res) => {
    console.log("========== CHAT WEBHOOK ==========");
    console.log("BODY RECEIVED:");
    console.log(JSON.stringify(req.body, null, 2));

    try {
        // FIXED: Stripping "Selected:" from Kapso's list/button replies
        const userMessageRaw = req.body.message || req.body.text || req.body.query || "";
        const userMessage = userMessageRaw.replace(/Selected:\s*/i, "").trim();

        const centerIdRaw = req.body.center_id || req.body.center || "center_123";
        const centerId = centerIdRaw.replace(/Selected:\s*/i, "").trim();

        if (!userMessage) {
            return res.json({
                success: false,
                reply_message: "Please select a service."
            });
        }

        console.log(`💬 User Query: "${userMessage}" | Center: "${centerId}"`);

        const embeddingModel = genAI.getGenerativeModel({
            model: "gemini-embedding-2"
        });

        const embedResult = await embeddingModel.embedContent(userMessage);
        const queryEmbedding = embedResult.embedding.values;

        const { data: matchedRules, error: rpcError } =
            await supabase.rpc('match_center_rules', {
                query_embedding: queryEmbedding,
                match_threshold: 0.4,
                match_count: 3,
                p_center_id: centerId
            });

        if (rpcError) throw rpcError;

        const rulesText =
            matchedRules && matchedRules.length > 0
                ? matchedRules.map(r => r.content).join('\n')
                : "";

        console.log("📋 Rules Found:", matchedRules?.length || 0);

        const chatModel = genAI.getGenerativeModel({
            model: "gemini-2.5-flash"
        });

        const prompt = `
You are an Akshaya Center assistant.

Citizen Request:
${userMessage}

Center Rules:
${rulesText}

Instructions:
1. List only the required documents.
2. Use bullet points.
3. If no rules are found, say:
"I currently do not have the specific document list for this service at your chosen center. Please contact the center directly."
4. Do not invent documents.
`;

        const aiResult = await chatModel.generateContent(prompt);
        const finalReply = aiResult.response.text();

        console.log("✅ AI Reply Generated");

        return res.json({
            success: true,
            reply_message: finalReply
        });

    } catch (error) {
        console.error("❌ Chat Webhook Error:");
        console.error(error);

        return res.json({
            success: false,
            reply_message:
                "Sorry, I am having trouble fetching the center information right now."
        });
    }
});

// =========================================================================
// KAPSO WEBHOOK: RAG DOCUMENT VERIFICATION
// =========================================================================
app.post('/api/webhook/document-upload', async (req, res) => {
    try {
        const imageUrl = req.body.image_url;
        const documentType = req.body.document_type || "Income Certificate";

        if (!imageUrl) {
            return res.status(400).json({ error: "No image URL provided" });
        }

        console.log(`🔍 Analyzing ${documentType} from URL: ${imageUrl}`);

        const imageResponse = await fetch(imageUrl);
        const imageBuffer = await imageResponse.arrayBuffer();
        const base64Image = Buffer.from(imageBuffer).toString('base64');
        const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';

        const visionModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const visionPrompt = `Look at this document. It is supposed to be a ${documentType}. Extract all visible text, check for official stamps, signatures, and dates. Summarize the contents clearly.`;

        const imagePart = {
            inlineData: {
                data: base64Image,
                mimeType: mimeType
            }
        };

        const visionResult = await visionModel.generateContent([visionPrompt, imagePart]);
        const extractedDetails = visionResult.response.text();
        console.log("📝 Vision AI Extracted:", extractedDetails);

        const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-2" });
        const embedResult = await embeddingModel.embedContent(documentType);
        const queryEmbedding = embedResult.embedding.values;

        const { data: matchedRules, error: rpcError } = await supabase.rpc('match_rules', {
            query_embedding: queryEmbedding,
            match_threshold: 0.5,
            match_count: 2
        });

        if (rpcError) throw rpcError;

        const rulesText = matchedRules ? matchedRules.map(r => r.content).join('\n') : "";
        console.log("⚖️ Retrieved Rules:", rulesText);

        const verificationModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const verificationPrompt = `
      You are an Akshaya Center verification assistant.
      
      OFFICIAL RULES FOR THIS DOCUMENT:
      ${rulesText}
      
      DETAILS EXTRACTED FROM UPLOADED IMAGE:
      ${extractedDetails}
      
      Does the uploaded document meet ALL the official rules? 
      Reply with either "✅ PASS:" or "❌ FAIL:" followed by a short, polite explanation for the citizen.
    `;

        const finalResult = await verificationModel.generateContent(verificationPrompt);
        const finalDecision = finalResult.response.text();

        console.log("🏁 Final Decision:", finalDecision);

        res.json({
            success: true,
            reply_message: finalDecision
        });

    } catch (error) {
        console.error("❌ Document Verification Error:", error);
        res.status(500).json({ error: "Failed to process document" });
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
                const imgRes = await fetch(imageUrl);
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
            return res.json({ token, role: 'superadmin' });
        }

        const result = await db.query('SELECT * FROM akshaya_centers WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(401).json({ message: 'Invalid credentials' });

        const user = result.rows[0];
        const validPass = await bcrypt.compare(password, user.password_hash);
        if (!validPass) return res.status(401).json({ message: 'Invalid credentials' });

        const token = jwt.sign({ email: user.email, role: user.role }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '12h' });
        res.json({ token, role: user.role });
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
// STANDARD API ENDPOINTS
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

app.get('/health', (req, res) => {
    res.status(200).send('Bot is healthy and awake!');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));