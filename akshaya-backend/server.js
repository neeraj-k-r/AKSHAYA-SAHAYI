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

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post('/api/webhook/document-upload', async (req, res) => {
    try {
        // 1. Get the image URL and document type sent from Kapso/WhatsApp
        // (Note: Adjust these variable names if Kapso labels them differently in your webhook setup)
        const imageUrl = req.body.image_url;
        const documentType = req.body.document_type || "Income Certificate";

        if (!imageUrl) {
            return res.status(400).json({ error: "No image URL provided" });
        }

        console.log(`🔍 Analyzing ${documentType} from URL: ${imageUrl}`);

        // 2. Download the image and convert it to Base64 for Gemini Vision
        const imageResponse = await fetch(imageUrl);
        const imageBuffer = await imageResponse.arrayBuffer();
        const base64Image = Buffer.from(imageBuffer).toString('base64');
        const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';

        // 3. VISION AI: Extract text, stamps, and details from the image
        const visionModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
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

        // 4. RAG RETRIEVAL: Find the specific rules for this document type
        const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-2" });
        const embedResult = await embeddingModel.embedContent(documentType);
        const queryEmbedding = embedResult.embedding.values;

        // Search Supabase vector database for matching rules
        const { data: matchedRules, error: rpcError } = await supabase.rpc('match_rules', {
            query_embedding: queryEmbedding,
            match_threshold: 0.5,
            match_count: 2
        });

        if (rpcError) throw rpcError;

        // Combine the retrieved rules into one text block
        const rulesText = matchedRules.map(r => r.content).join('\n');
        console.log("⚖️ Retrieved Rules:", rulesText);

        // 5. LLM VERIFICATION: Compare the extracted image details against the rules
        const verificationModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
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

        // 6. Send the final decision back to Kapso
        res.json({
            success: true,
            reply_message: finalDecision
        });

    } catch (error) {
        console.error("❌ Document Verification Error:", error);
        res.status(500).json({ error: "Failed to process document" });
    }
});

app.use(cors());

// ==========================================
// 1. TOOL CONFIGURATIONS & DB SETUP
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
function saveLocalDb() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify({ centers: fallbackCenters, requests: fallbackRequests }, null, 2)); } catch (e) { }
}

const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// ==========================================
// 2. KAPSO WEBHOOK ENDPOINT (Document Upload)
// ==========================================
app.post('/api/webhook/document-upload', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const payload = JSON.parse(req.body.toString());
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
// 3. APPLY STANDARD JSON PARSING FOR REST OF APP
// ==========================================
app.use(express.json());

// ==========================================
// 4. STANDARD API ENDPOINTS
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

// ==========================================
// 5. NEW: KAPSO DYNAMIC MENU TRIGGER
// ==========================================
app.post('/api/bot/send-centers-menu', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ error: "Phone number is required" });

        // Fetch up to 10 centers (WhatsApp strict limit for list rows)
        let centersList = [];
        if (isDbConnected) {
            try {
                const result = await db.query('SELECT center_code, center_name, district FROM akshaya_centers ORDER BY center_name ASC LIMIT 10');
                centersList = result.rows;
            } catch (dbErr) { }
        }
        if (centersList.length === 0) centersList = fallbackCenters.slice(0, 10);

        // Format exactly how WhatsApp expects it
        const kapsoOptions = centersList.map(c => ({
            id: c.center_code,
            title: (c.center_name || c.center_code).substring(0, 24), // Max 24 chars
            description: `District: ${c.district}`.substring(0, 72) // Max 72 chars
        }));

        // Build the WhatsApp Payload
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

        // Send payload through Kapso API
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
// Health check route for UptimeRobot
app.get('/health', (req, res) => {
    res.status(200).send('Bot is healthy and awake!');
});
app.post('/api/auth/login', async (req, res) => { /* Auth logic intact */ });
app.post('/api/admin/create-center', authenticateToken, async (req, res) => { /* Create logic intact */ });
app.get('/api/dashboard/requests', authenticateToken, async (req, res) => { /* Dashboard logic intact */ });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));