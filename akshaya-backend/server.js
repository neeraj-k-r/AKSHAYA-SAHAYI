require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ==========================================
// 1. MIDDLEWARE
// ==========================================
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// ==========================================
// 2. GEMINI + SUPABASE
// ==========================================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY
);

// ==========================================
// 3. CLOUDINARY
// ==========================================
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ==========================================
// 4. POSTGRES (used only for dashboard/auth)
// ==========================================
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

let isDbConnected = false;

db.on('error', (error) => {
    console.error("❌ PostgreSQL pool error:", error.message);
    isDbConnected = false;
});

db.query('SELECT 1')
    .then(() => {
        isDbConnected = true;
        console.log("✅ Connected to PostgreSQL database.");
    })
    .catch((error) => {
        isDbConnected = false;
        console.log("ℹ️ PostgreSQL unavailable. Dashboard/auth features limited.");
        console.log("Reason:", error.message);
    });

// ==========================================
// 5. LOCAL FALLBACK FILE
// ==========================================
const DB_FILE = path.join(__dirname, 'local_db.json');

function loadLocalDb() {
    if (fs.existsSync(DB_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        } catch (error) {
            console.warn("⚠️ local_db.json parse failed:", error.message);
        }
    }

    const initialData = { centers: [], requests: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    return initialData;
}

const localData = loadLocalDb();
const fallbackCenters = localData.centers || [];

// ==========================================
// 6. SESSION MEMORY (per phone number)
//
// Stores selected center + service list.
// NOTE: cleared when Render restarts.
// Move to Redis/DB for production.
// ==========================================
const userSessions = new Map();

function getSession(phone) {
    if (!phone) return {};

    if (!userSessions.has(phone)) {
        userSessions.set(phone, {
            centerId: null,
            centerName: null,
            services: {},
            lastService: null
        });
    }

    return userSessions.get(phone);
}

function updateSession(phone, values) {
    if (!phone) return;

    const current = getSession(phone);
    userSessions.set(phone, { ...current, ...values });
}

// ==========================================
// 7. HELPERS
// ==========================================
function withTimeout(promise, ms = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('TIMEOUT_EXCEEDED'));
        }, ms);

        promise.then(
            (result) => { clearTimeout(timer); resolve(result); },
            (error) => { clearTimeout(timer); reject(error); }
        );
    });
}

function cleanPhoneNumber(value) {
    return String(value || "")
        .replace(/whatsapp:\+?/gi, "")
        .replace(/\+/g, "")
        .replace(/\s/g, "")
        .trim();
}

function truncate(value, maxLength) {
    return String(value || "").trim().substring(0, maxLength);
}

function safeId(value) {
    return String(value || "")
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .substring(0, 100);
}

function normalizeText(value) {
    return String(value || "")
        .replace(/Selected:\s*/gi, "")
        .trim();
}

/*
  Converts WhatsApp row id back to real center code.

  center_1_HQ-001  ->  HQ-001
  center_3_EKM-001 ->  EKM-001
*/
function normalizeCenterId(value) {
    return normalizeText(value).replace(/^center_\d+_/i, "");
}

function getPhoneFromBody(body) {
    return cleanPhoneNumber(
        body.phone ||
        body.Phone ||
        body.from ||
        body.From ||
        body.to ||
        body.To ||
        body.mobile ||
        body.wa_id ||
        body.waId ||
        body.sender ||
        body.sender_id ||
        body.conversation?.phone_number ||
        body.message?.from ||
        body.contact?.phone ||
        body.contact?.wa_id ||
        body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from ||
        ""
    );
}

function getSelectedListId(body) {
    return normalizeText(
        body.list_reply?.id ||
        body.interactive?.list_reply?.id ||
        body.message?.interactive?.list_reply?.id ||
        body.selected_id ||
        body.selectedId ||
        ""
    );
}

function getSelectedListTitle(body) {
    return normalizeText(
        body.list_reply?.title ||
        body.interactive?.list_reply?.title ||
        body.message?.interactive?.list_reply?.title ||
        body.selected_title ||
        body.selectedTitle ||
        ""
    );
}

function getUserMessage(body) {
    return normalizeText(
        body.message ||
        body.text ||
        body.query ||
        body.Body ||
        body.service ||
        body.selected_service ||
        body.service_title ||
        getSelectedListTitle(body) ||
        getSelectedListId(body) ||
        ""
    );
}

function extractImageUrl(body) {
    const rawImageUrl =
        body.image_url ||
        body.imageUrl ||
        body.message?.image?.link ||
        body.message?.kapso?.media_url ||
        body.media_url ||
        body.url ||
        "";

    if (typeof rawImageUrl === "string") {
        const match = rawImageUrl.match(/(https?:\/\/[^\s"']+)/);
        if (match) return match[0];
    }

    // Last resort: scan entire payload for any URL
    const bodyString = JSON.stringify(body);
    const fallbackMatch = bodyString.match(/(https?:\/\/[^\s"'>]+)/);

    return fallbackMatch ? fallbackMatch[0] : null;
}

// ==========================================
// 8. AUTH MIDDLEWARE
// ==========================================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).send("Unauthorized: No token provided");
    }

    jwt.verify(
        token,
        process.env.JWT_SECRET || 'fallback_secret',
        (error, user) => {
            if (error) {
                console.error("❌ JWT failed:", error.message);
                return res.status(403).send("Forbidden");
            }
            req.user = user;
            next();
        }
    );
};

// ==========================================
// 9. ADD RULE (dashboard)
// ==========================================
app.post('/api/add-rule', async (req, res) => {
    try {
        const { documentType, content, centerId } = req.body;

        if (!documentType || !content) {
            return res.status(400).json({
                error: "documentType and content are required"
            });
        }

        console.log(`🌱 Adding rule: ${documentType} | Center: ${centerId || 'GLOBAL'}`);

        const embeddingModel = genAI.getGenerativeModel({
            model: "gemini-embedding-2"
        });

        const embedResult = await embeddingModel.embedContent(content);
        const vector = embedResult.embedding.values;

        const { error } = await supabase
            .from('document_rules')
            .insert([{
                document_type: documentType,
                content: content,
                embedding: vector,
                center_id: centerId || null
            }]);

        if (error) throw error;

        return res.json({
            success: true,
            message: "Rule successfully stored"
        });

    } catch (error) {
        console.error("❌ Add Rule Error:", error);
        return res.status(500).json({ error: "Failed to store rule" });
    }
});

// ==========================================
// 10. CHAT WEBHOOK
//
// Saved DB rules are returned DIRECTLY.
// Gemini is used only when nothing is saved.
// ==========================================
app.post('/api/webhook/chat', async (req, res) => {
    console.log("\n========== CHAT WEBHOOK ==========");
    console.log(JSON.stringify(req.body, null, 2));

    try {
        const phone = getPhoneFromBody(req.body);
        const session = getSession(phone);

        const selectedId = getSelectedListId(req.body);
        let userMessage = getUserMessage(req.body);

        // Recover real service name if Kapso sent service_1 style id
        if (
            selectedId &&
            /^service_\d+$/i.test(selectedId) &&
            session.services?.[selectedId]
        ) {
            userMessage = session.services[selectedId];
        }

        if (!userMessage) {
            return res.json({
                success: true,
                reply_message: "Please select a service from the list."
            });
        }

        const centerId = normalizeCenterId(
            req.body.center_id ||
            req.body.center ||
            req.body.centerId ||
            req.body.center_code ||
            req.body.assigned_center_code ||
            session.centerId ||
            ""
        );

        updateSession(phone, { lastService: userMessage });

        console.log(`📱 Phone: ${phone}`);
        console.log(`🏢 Center: ${centerId || 'GLOBAL'}`);
        console.log(`🛎️ Service: ${userMessage}`);

        let savedRules = [];

        // STEP 1: exact match for this center
        if (centerId) {
            const { data, error } = await supabase
                .from('document_rules')
                .select('id, document_type, content, center_id')
                .eq('center_id', centerId)
                .ilike('document_type', userMessage)
                .limit(10);

            if (error) {
                console.warn("⚠️ Center rule query error:", error.message);
            }

            if (data && data.length > 0) {
                savedRules = data;
                console.log(`✅ ${data.length} center-specific rule(s) found`);
            }
        }

        // STEP 2: global exact match
        if (savedRules.length === 0) {
            const { data, error } = await supabase
                .from('document_rules')
                .select('id, document_type, content, center_id')
                .ilike('document_type', userMessage)
                .limit(10);

            if (error) {
                console.warn("⚠️ Global rule query error:", error.message);
            }

            if (data && data.length > 0) {
                savedRules = data;
                console.log(`✅ ${data.length} global rule(s) found`);
            }
        }

        // STEP 3: partial match
        if (savedRules.length === 0) {
            const { data, error } = await supabase
                .from('document_rules')
                .select('id, document_type, content, center_id')
                .ilike('document_type', `%${userMessage}%`)
                .limit(10);

            if (error) {
                console.warn("⚠️ Partial rule query error:", error.message);
            }

            if (data && data.length > 0) {
                savedRules = data;
                console.log(`✅ ${data.length} partial rule(s) found`);
            }
        }

        // RETURN SAVED RULES DIRECTLY (no AI rewriting)
        if (savedRules.length > 0) {
            const rulesText = savedRules
                .map((rule, index) =>
                    savedRules.length > 1
                        ? `*${index + 1}. ${rule.document_type}*\n${rule.content}`
                        : rule.content
                )
                .join('\n\n');

            const reply =
                `📋 *Requirements for ${userMessage}*\n\n` +
                `${rulesText}\n\n` +
                `📎 *Next Step:* Please upload a clear photo of your document using the 📎 or 📷 icon.`;

            console.log("✅ Returned SAVED DATABASE RULES");

            return res.json({
                success: true,
                source: "database",
                service: userMessage,
                reply_message: reply
            });
        }

        // FALLBACK: Gemini
        console.log("⚠️ No saved rule found. Using Gemini fallback.");

        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("TIMEOUT")), 15000);
        });

        const aiTask = async () => {
            const chatModel = genAI.getGenerativeModel({
                model: "gemini-2.5-flash"
            });

            const prompt = `
You are an official Akshaya Center assistant in Kerala.

Citizen service request: ${userMessage}

List only the essential required documents as short bullet points.
Keep it WhatsApp friendly and under 120 words.
End by noting that final requirements should be confirmed at the center.
`;

            const aiResult = await chatModel.generateContent(prompt);
            return aiResult.response.text();
        };

        const aiReply = await Promise.race([aiTask(), timeoutPromise]);

        return res.json({
            success: true,
            source: "gemini_fallback",
            service: userMessage,
            reply_message:
                `${aiReply}\n\n📎 *Next Step:* Please upload a clear photo of your document.`
        });

    } catch (error) {
        const isTimeout = error.message === "TIMEOUT";

        console.error(
            `❌ Chat webhook ${isTimeout ? "TIMEOUT" : "ERROR"}:`,
            error.message
        );

        return res.json({
            success: true,
            reply_message: isTimeout
                ? "⏳ The service is busy right now. Please select the service again in a moment."
                : "Sorry, I could not process that. Please select the service again."
        });
    }
});

// ==========================================
// 11. DOCUMENT VERIFICATION
//
// Strict PASS / FAIL against saved rules.
// FAIL -> asks user to retake the photo.
// ==========================================
app.post('/api/webhook/document-upload', async (req, res) => {
    try {
        console.log("\n========== DOCUMENT UPLOAD WEBHOOK ==========");
        console.log(JSON.stringify(req.body, null, 2));

        const phone = getPhoneFromBody(req.body);
        const session = getSession(phone);

        // ---------- 1. Image URL ----------
        const imageUrl = extractImageUrl(req.body);

        if (!imageUrl) {
            console.warn("⚠️ No image URL found in payload.");

            return res.json({
                success: true,
                verification_status: "RETRY",
                is_valid: false,
                reply_message:
                    "❌ *No image received.*\n\n" +
                    "Please tap 📎 or 📷 and send a clear photo of your document."
            });
        }

        // ---------- 2. Which document type ----------
        let serviceRequested = normalizeText(
            req.body.document_type ||
            req.body.documentType ||
            req.body.service ||
            req.body.selected_service ||
            req.body.service_title ||
            ""
        );

        const selectedId = getSelectedListId(req.body);

        if (
            !serviceRequested &&
            selectedId &&
            session.services?.[selectedId]
        ) {
            serviceRequested = session.services[selectedId];
        }

        if (!serviceRequested) {
            serviceRequested = session.lastService || "Income Certificate";
        }

        const centerId = normalizeCenterId(
            req.body.center_id ||
            req.body.center ||
            req.body.centerId ||
            session.centerId ||
            ""
        );

        updateSession(phone, { lastService: serviceRequested });

        console.log(`📄 Verifying "${serviceRequested}" | Center: ${centerId || 'GLOBAL'}`);

        // ---------- 3. Load saved rule ----------
        let rulesText = "";

        if (centerId) {
            const { data } = await supabase
                .from('document_rules')
                .select('content')
                .eq('center_id', centerId)
                .ilike('document_type', serviceRequested)
                .limit(3);

            if (data && data.length > 0) {
                rulesText = data.map(r => r.content).join("\n");
                console.log("✅ Using center-specific rule");
            }
        }

        if (!rulesText) {
            const { data } = await supabase
                .from('document_rules')
                .select('content')
                .ilike('document_type', serviceRequested)
                .limit(3);

            if (data && data.length > 0) {
                rulesText = data.map(r => r.content).join("\n");
                console.log("✅ Using global rule");
            }
        }

        if (!rulesText) {
            console.warn("⚠️ No saved rule. Using generic criteria.");

            rulesText =
                "The document must be an official government-issued document, " +
                "fully readable, not blurred or cropped, with visible name, " +
                "official seal or stamp, and issuing authority signature.";
        }

        console.log("⚖️ Rules used:", rulesText);

        // ---------- 4. Download image ----------
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);

        let imageBuffer;

        try {
            let response = await fetch(imageUrl, {
                headers: {
                    'X-API-Key': process.env.KAPSO_API_KEY || '',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'image/jpeg,image/png,image/webp,*/*'
                },
                signal: controller.signal
            });

            if (!response.ok) {
                console.log(`⚠️ Auth fetch failed (${response.status}). Retrying plain.`);

                response = await fetch(imageUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'image/jpeg,image/png,image/webp,*/*'
                    },
                    signal: controller.signal
                });
            }

            if (!response.ok) {
                throw new Error(`Download failed: ${response.status}`);
            }

            imageBuffer = await response.arrayBuffer();
            console.log("✅ Image downloaded");

        } catch (downloadErr) {
            console.error("❌ Image download failed:", downloadErr.message);

            return res.json({
                success: true,
                verification_status: "RETRY",
                is_valid: false,
                reply_message:
                    "❌ *Could not open your image.*\n\n" +
                    "Please send the photo again using 📎 or 📷."
            });
        } finally {
            clearTimeout(timeout);
        }

        const base64Image = Buffer.from(imageBuffer).toString('base64');

        // ---------- 5. Strict AI verification ----------
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: {
                temperature: 0.1,
                responseMimeType: "application/json"
            }
        });

        const prompt = `
You are a strict Akshaya Center document verification officer in Kerala.

EXPECTED DOCUMENT TYPE:
${serviceRequested}

OFFICIAL ACCEPTANCE RULES:
${rulesText}

TASK:
Inspect the uploaded image and decide if it can be ACCEPTED.

Set status = "FAIL" if ANY of these are true:
- Image is blurred, dark, glared, cropped, or text is unreadable
- It is NOT a "${serviceRequested}" (wrong document type)
- Any element required by the rules is missing (seal, signature, name, number, date)
- It is a screenshot, an unreadable photocopy, or a handwritten note
- The document appears expired according to the rules

Set status = "PASS" only if the document is the correct type,
fully readable, and satisfies every rule above.

Return ONLY valid JSON in exactly this shape:
{
  "status": "PASS" or "FAIL",
  "detected_document": "what document you actually see",
  "is_readable": true or false,
  "missing_or_problem": ["short issue 1", "short issue 2"],
  "reason": "one short sentence explaining the decision"
}
`;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: base64Image, mimeType: "image/jpeg" } }
        ]);

        const rawText = result.response.text();
        console.log("🤖 Raw AI output:", rawText);

        let verdict;

        try {
            verdict = JSON.parse(rawText);
        } catch (parseErr) {
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);

            verdict = jsonMatch
                ? JSON.parse(jsonMatch[0])
                : {
                    status: "FAIL",
                    detected_document: "",
                    reason: "Could not read the document clearly.",
                    missing_or_problem: []
                };
        }

        const isPass = String(verdict.status).toUpperCase() === "PASS";

        const problems = Array.isArray(verdict.missing_or_problem)
            ? verdict.missing_or_problem.filter(Boolean)
            : [];

        // ---------- 6. Build WhatsApp reply ----------
        let replyMessage;

        if (isPass) {
            replyMessage =
                `✅ *DOCUMENT ACCEPTED*\n\n` +
                `📄 Document: *${verdict.detected_document || serviceRequested}*\n` +
                `✔️ ${verdict.reason || "All required details are clearly visible."}\n\n` +
                `Your document meets the Akshaya Center requirements. ` +
                `You may now visit the center to complete your application. 🙏`;

        } else {
            const problemList = problems.length > 0
                ? problems.map(p => `• ${p}`).join("\n")
                : `• ${verdict.reason || "Required details are not clearly visible."}`;

            replyMessage =
                `❌ *DOCUMENT REJECTED — PLEASE RETAKE THE PHOTO*\n\n` +
                (verdict.detected_document
                    ? `📄 We detected: *${verdict.detected_document}*\n`
                    : "") +
                `📌 Expected: *${serviceRequested}*\n\n` +
                `*Issues found:*\n${problemList}\n\n` +
                `📷 *How to retake:*\n` +
                `1. Place the document flat on a plain surface\n` +
                `2. Use bright light, avoid shadows and glare\n` +
                `3. Capture the *full* document — all four corners\n` +
                `4. Hold steady so the text is sharp\n\n` +
                `Please tap 📎 or 📷 and upload again.`;
        }

        console.log(`🏁 Verdict: ${isPass ? "PASS ✅" : "FAIL ❌"}`);

        // ---------- 7. Save accepted document ----------
        if (isPass) {
            try {
                await supabase.from('user_documents').insert({
                    phone_number: phone,
                    document_name: serviceRequested,
                    file_url: imageUrl,
                    resource_type: 'image'
                });

                console.log("💾 Saved to user_documents");

            } catch (saveErr) {
                console.warn("⚠️ Save failed:", saveErr.message);
            }
        }

        return res.json({
            success: true,
            verification_status: isPass ? "PASS" : "FAIL",
            is_valid: isPass,
            detected_document: verdict.detected_document || "",
            expected_document: serviceRequested,
            reply_message: replyMessage
        });

    } catch (error) {
        console.error("🔥 Document verification crash:", error);

        return res.json({
            success: true,
            verification_status: "RETRY",
            is_valid: false,
            reply_message:
                "⚠️ *Something went wrong while checking your document.*\n\n" +
                "Please take a clear, well-lit photo and upload it again."
        });
    }
});

// ==========================================
// 12. LEGACY CLOUDINARY UPLOAD
// ==========================================
app.post('/api/webhook/document-upload-legacy', async (req, res) => {
    try {
        const payload = req.body;

        const phone_number =
            payload.message?.from ||
            payload.conversation?.phone_number;

        const imageUrl =
            payload.message?.image?.link ||
            payload.message?.kapso?.media_url;

        if (imageUrl && phone_number) {
            let permanentUrl = imageUrl;

            try {
                const imgRes = await fetch(imageUrl, {
                    headers: {
                        'X-API-Key': process.env.KAPSO_API_KEY || '',
                        'User-Agent': 'Mozilla/5.0',
                        'Accept': 'image/jpeg,image/png,image/webp,*/*'
                    }
                });

                if (!imgRes.ok) {
                    throw new Error(`Download failed: ${imgRes.status}`);
                }

                const buffer = Buffer.from(await imgRes.arrayBuffer());
                const tempFilePath = path.join(__dirname, `temp_${Date.now()}.jpg`);

                fs.writeFileSync(tempFilePath, buffer);

                const uploadResult = await cloudinary.uploader.upload(tempFilePath, {
                    folder: 'akshaya_docs'
                });

                permanentUrl = uploadResult.secure_url;
                fs.unlinkSync(tempFilePath);

                console.log("✅ Uploaded to Cloudinary");

            } catch (cloudErr) {
                console.warn("⚠️ Cloudinary pipeline failed:", cloudErr.message);
            }

            if (isDbConnected) {
                try {
                    const tokenNumber = `DOC-${Date.now().toString().slice(-6)}`;

                    await db.query(
                        `INSERT INTO service_requests
                        (token_number, category, citizen_phone, document_urls, assigned_center_code)
                        VALUES ($1, $2, $3, $4, $5)`,
                        [tokenNumber, 'Document', phone_number, [permanentUrl], 'HQ-001']
                    );

                } catch (dbErr) {
                    console.error("🔥 DB insert error:", dbErr.message);
                }
            }
        }

        res.status(200).send('OK');

    } catch (error) {
        console.error("Legacy upload error:", error);
        res.status(500).send('Internal Server Error');
    }
});

// ==========================================
// 13. AUTH ENDPOINTS
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (email === 'admin@akshaya.com') {
            const token = jwt.sign(
                { email, role: 'superadmin' },
                process.env.JWT_SECRET || 'fallback_secret',
                { expiresIn: '12h' }
            );

            return res.json({
                token,
                role: 'superadmin',
                center_code: 'HQ-001'
            });
        }

        const result = await db.query(
            'SELECT * FROM akshaya_centers WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const user = result.rows[0];
        const validPass = await bcrypt.compare(password, user.password_hash);

        if (!validPass) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { email: user.email, role: user.role },
            process.env.JWT_SECRET || 'fallback_secret',
            { expiresIn: '12h' }
        );

        return res.json({
            token,
            role: user.role,
            center_code: user.center_code
        });

    } catch (error) {
        console.error("Login error:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
});

app.post('/api/admin/create-center', authenticateToken, async (req, res) => {
    try {
        const { center_code, center_name, district, email, password } = req.body;

        if (!center_code || !center_name || !district || !email || !password) {
            return res.status(400).json({ error: "All fields are required" });
        }

        const hash = await bcrypt.hash(password, 10);

        await db.query(
            `INSERT INTO akshaya_centers
            (center_code, center_name, district, email, password_hash, role)
            VALUES ($1, $2, $3, $4, $5, 'admin')`,
            [center_code, center_name, district, email, hash]
        );

        return res.json({ success: true, message: 'Center created successfully' });

    } catch (error) {
        console.error("Create center error:", error);
        return res.status(500).json({ error: error.message });
    }
});

app.get('/api/dashboard/requests', authenticateToken, async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM service_requests ORDER BY created_at DESC'
        );

        return res.json(result.rows);

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 14. RULES MANAGEMENT
// ==========================================
app.get('/api/center-rules/:centerId', async (req, res) => {
    try {
        const { centerId } = req.params;

        const { data, error } = await supabase
            .from('document_rules')
            .select('id, document_type, content, center_id')
            .eq('center_id', centerId)
            .order('id', { ascending: false });

        if (error) throw error;

        return res.json(data);

    } catch (error) {
        console.error("Fetch rules error:", error);
        return res.status(500).json({ error: "Failed to fetch rules" });
    }
});

app.get('/api/all-rules', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('document_rules')
            .select('id, document_type, content, center_id')
            .order('id', { ascending: false });

        if (error) throw error;

        return res.json({ success: true, total: data.length, rules: data });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

app.put('/api/edit-rule/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { content } = req.body;

        if (!content) {
            return res.status(400).json({ error: "Content is required" });
        }

        const embeddingModel = genAI.getGenerativeModel({
            model: "gemini-embedding-2"
        });

        const embedResult = await embeddingModel.embedContent(content);
        const vector = embedResult.embedding.values;

        const { error } = await supabase
            .from('document_rules')
            .update({ content: content, embedding: vector })
            .eq('id', id);

        if (error) throw error;

        return res.json({ success: true, message: "Rule updated" });

    } catch (error) {
        console.error("Edit rule error:", error);
        return res.status(500).json({ error: "Failed to update rule" });
    }
});

// ==========================================
// 15. PUBLIC CENTERS
// ==========================================
app.get('/api/public/centers', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('akshaya_centers')
            .select('center_code, center_name, district')
            .order('center_name', { ascending: true });

        if (error) throw error;

        let centersList = data || [];

        if (centersList.length === 0) {
            centersList = fallbackCenters;
        }

        return res.json({
            success: true,
            total: centersList.length,
            centers: centersList
        });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 16. SEND CENTERS MENU
// ==========================================
app.post('/api/bot/send-centers-menu', async (req, res) => {
    try {
        console.log("\n========== SEND CENTERS MENU ==========");
        console.log(JSON.stringify(req.body, null, 2));

        const phone = getPhoneFromBody(req.body);

        if (!phone) {
            console.error("❌ Phone number missing.");
            return res.status(400).json({
                error: "Phone number is required",
                received_body: req.body
            });
        }

        if (!process.env.KAPSO_API_KEY) {
            return res.status(500).json({ error: "KAPSO_API_KEY is missing" });
        }

        if (!process.env.KAPSO_PHONE_ID) {
            return res.status(500).json({ error: "KAPSO_PHONE_ID is missing" });
        }

        const { data, error } = await supabase
            .from('akshaya_centers')
            .select('center_code, center_name, district')
            .order('center_name', { ascending: true })
            .limit(10);

        if (error) {
            console.error("🔥 Supabase center fetch error:", error.message);
            return res.status(500).json({
                error: "Failed to fetch centers",
                supabase_error: error.message
            });
        }

        let centersList = data || [];

        if (centersList.length === 0) {
            console.warn("⚠️ No centers in Supabase. Using fallback.");

            centersList = [{
                center_code: "HQ-001",
                center_name: "Akshaya HQ",
                district: "Trivandrum"
            }];
        }

        const kapsoOptions = centersList.slice(0, 10).map((center, index) => {
            const centerCode = safeId(
                center.center_code || `CENTER_${index + 1}`
            );

            return {
                // Unique row id — prevents "Duplicated row id"
                id: `center_${index + 1}_${centerCode}`,
                title: truncate(center.center_name || centerCode, 24),
                description: truncate(`District: ${center.district || "N/A"}`, 72)
            };
        });

        console.log("✅ Center rows:", kapsoOptions.map(r => r.id));

        const payload = {
            messaging_product: "whatsapp",
            to: phone,
            type: "interactive",
            interactive: {
                type: "list",
                body: {
                    text: "Welcome to Akshaya Sahayi 🙏\nPlease select your Akshaya Center:"
                },
                action: {
                    button: "View Centers",
                    sections: [{
                        title: "Available Centers",
                        rows: kapsoOptions
                    }]
                }
            }
        };

        const kapsoUrl =
            `https://api.kapso.ai/meta/whatsapp/v24.0/${process.env.KAPSO_PHONE_ID}/messages`;

        const kapsoResponse = await fetch(kapsoUrl, {
            method: "POST",
            headers: {
                "X-API-Key": process.env.KAPSO_API_KEY,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const responseText = await kapsoResponse.text();

        if (!kapsoResponse.ok) {
            console.error("🔥 Kapso center menu error:", responseText);
            return res.status(500).json({
                error: "Failed to push centers menu",
                kapso_error: responseText
            });
        }

        console.log(`✅ Centers menu sent to ${phone}`);

        return res.json({
            success: true,
            message: "Centers menu sent",
            centers: centersList
        });

    } catch (error) {
        console.error("🔥 Send centers menu error:", error);
        return res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 17. SEND SERVICES MENU
// ==========================================
app.post('/api/bot/send-services-menu', async (req, res) => {
    try {
        console.log("\n========== SEND SERVICES MENU ==========");
        console.log(JSON.stringify(req.body, null, 2));

        const phone = getPhoneFromBody(req.body);

        if (!phone) {
            return res.status(400).json({
                error: "Phone number is required",
                received_body: req.body
            });
        }

        if (!process.env.KAPSO_API_KEY || !process.env.KAPSO_PHONE_ID) {
            return res.status(500).json({
                error: "KAPSO_API_KEY or KAPSO_PHONE_ID is missing"
            });
        }

        const session = getSession(phone);

        const selectedCenterId =
            getSelectedListId(req.body) ||
            req.body.center_id ||
            req.body.center ||
            req.body.centerId ||
            req.body.center_code ||
            "";

        const selectedCenterTitle =
            getSelectedListTitle(req.body) ||
            req.body.selected_center ||
            "";

        let centerId = normalizeCenterId(selectedCenterId);

        // Resolve by center name if only the title came through
        if (!centerId && selectedCenterTitle) {
            const { data } = await supabase
                .from('akshaya_centers')
                .select('center_code')
                .ilike('center_name', selectedCenterTitle)
                .limit(1);

            if (data && data.length > 0) {
                centerId = data[0].center_code;
            }
        }

        if (!centerId) {
            centerId = session.centerId || "";
        }

        if (!centerId) {
            console.warn("⚠️ No center selected. Using GLOBAL rules.");
        }

        updateSession(phone, {
            centerId: centerId || null,
            centerName: selectedCenterTitle || session.centerName || centerId
        });

        console.log(`🏢 Center for ${phone}: ${centerId || 'GLOBAL'}`);

        let services = [];

        // Center-specific services
        if (centerId) {
            const { data, error } = await supabase
                .from('document_rules')
                .select('document_type')
                .eq('center_id', centerId);

            if (error) {
                console.warn("⚠️ Center service fetch error:", error.message);
            }

            if (data && data.length > 0) {
                services = [...new Set(
                    data.map(i => normalizeText(i.document_type)).filter(Boolean)
                )];
            }
        }

        // Global services (your seeded rules have center_id = null)
        if (services.length === 0) {
            const { data, error } = await supabase
                .from('document_rules')
                .select('document_type');

            if (error) {
                console.warn("⚠️ Global service fetch error:", error.message);
            }

            if (data && data.length > 0) {
                services = [...new Set(
                    data.map(i => normalizeText(i.document_type)).filter(Boolean)
                )];

                console.log("✅ Using GLOBAL service list");
            }
        }

        if (services.length === 0) {
            console.warn("⚠️ No services in DB. Using defaults.");

            services = [
                "Income Certificate",
                "Ration Card",
                "Aadhaar Card",
                "Caste Certificate"
            ];
        }

        services.sort();

        const serviceMap = {};

        const kapsoOptions = services.slice(0, 10).map((service, index) => {
            const serviceId = `service_${index + 1}`;
            serviceMap[serviceId] = service;

            return {
                id: serviceId,
                title: truncate(service, 24),
                description: truncate(`Apply for ${service}`, 72)
            };
        });

        updateSession(phone, {
            centerId: centerId || null,
            services: serviceMap
        });

        console.log("✅ Services:", services);

        const payload = {
            messaging_product: "whatsapp",
            to: phone,
            type: "interactive",
            interactive: {
                type: "list",
                body: { text: "What service do you need?" },
                action: {
                    button: "View Services",
                    sections: [{
                        title: "Available Services",
                        rows: kapsoOptions
                    }]
                }
            }
        };

        const kapsoUrl =
            `https://api.kapso.ai/meta/whatsapp/v24.0/${process.env.KAPSO_PHONE_ID}/messages`;

        const kapsoResponse = await fetch(kapsoUrl, {
            method: "POST",
            headers: {
                "X-API-Key": process.env.KAPSO_API_KEY,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const responseText = await kapsoResponse.text();

        if (!kapsoResponse.ok) {
            console.error("🔥 Kapso service menu error:", responseText);
            return res.status(500).json({
                error: "Failed to push services menu",
                kapso_error: responseText
            });
        }

        console.log(`✅ Services menu sent to ${phone}`);

        return res.json({
            success: true,
            message: "Services menu sent",
            center_id: centerId || null,
            services
        });

    } catch (error) {
        console.error("🔥 Send services menu error:", error);
        return res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 18. DEBUG (remove after testing)
// ==========================================
app.get('/api/debug/status', async (req, res) => {
    try {
        const { data: rules } = await supabase
            .from('document_rules')
            .select('id, document_type, center_id');

        const { data: centers } = await supabase
            .from('akshaya_centers')
            .select('center_code, center_name');

        return res.json({
            supabase_project: (process.env.SUPABASE_URL || "")
                .replace("https://", "")
                .replace(".supabase.co", ""),
            postgres_connected: isDbConnected,
            kapso_key_set: Boolean(process.env.KAPSO_API_KEY),
            kapso_phone_id_set: Boolean(process.env.KAPSO_PHONE_ID),
            total_rules: rules?.length || 0,
            rules: rules || [],
            total_centers: centers?.length || 0,
            centers: centers || [],
            active_sessions: userSessions.size
        });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 19. HEALTH
// ==========================================
app.get('/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: "Akshaya Sahayi bot is healthy"
    });
});

// ==========================================
// 20. START
// ==========================================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});