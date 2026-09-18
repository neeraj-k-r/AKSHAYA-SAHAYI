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
// 4. POSTGRES (dashboard / auth only)
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
        console.log("ℹ️ PostgreSQL unavailable. Dashboard/auth limited.");
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
// Cleared on Render restart.
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
            lastService: null,
            senderName: null,
            // serviceKey -> [canonicalDocKey, ...] of accepted supporting docs
            acceptedDocs: {}
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
// 7. GEMINI RETRY + MODEL FALLBACK
//
// Handles 503 "high demand", 429 rate limit,
// and 500 internal errors automatically.
// ==========================================

/*
  VERIFIED against this API key on /api/debug/gemini:

    gemini-flash-latest   -> WORKS  ✅
    gemini-2.5-flash      -> WORKS  ✅
    gemini-2.0-flash      -> 404    ❌ (not available)
    gemini-1.5-flash      -> 404    ❌ (not available)

  gemini-flash-latest is FIRST because it auto-routes to a
  healthy version and is less likely to return 503.

  gemini-flash-lite-latest is FIRST because it is the fastest model
  and most likely to answer inside Kapso's webhook time budget.
  If it 404s the loop simply moves on to the heavier models.
*/
const MODEL_CHAIN = [
    "gemini-flash-lite-latest",
    "gemini-flash-latest",
    "gemini-2.5-flash"
];

/*
  gemini-embedding-2 does NOT exist and always 404s.
  These are the real embedding model names.
*/
const EMBEDDING_MODEL_CHAIN = [
    "text-embedding-004",
    "gemini-embedding-001",
    "embedding-001"
];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Caps how long we wait for a promise. Rejects with a timeout error
 * so the webhook can reply to Kapso in time instead of letting
 * Kapso time out (citizen would get no reply at all).
 */
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([
        promise.then(
            (v) => { clearTimeout(timer); return v; },
            (e) => { clearTimeout(timer); throw e; }
        ),
        timeout
    ]);
}

function isRetryableError(error) {
    const status = error?.status;
    // Lowercased once so checks match "TIMEOUT_EXCEEDED",
    // "Timed out", "timed out", etc. alike.
    const message = String(error?.message || "").toLowerCase();

    return (
        status === 503 ||
        status === 429 ||
        status === 500 ||
        message.includes("503") ||
        message.includes("429") ||
        message.includes("500") ||
        message.includes("timeout") ||
        message.includes("timed out") ||
        message.includes("exceeded") ||
        message.includes("high demand") ||
        message.includes("overloaded") ||
        message.includes("service unavailable") ||
        message.includes("rate limit")
    );
}

/**
 * Calls Gemini across multiple models with exponential backoff.
 *
 * @param {Array} contentParts  Array passed to generateContent
 * @param {Object} options      { temperature, maxRetriesPerModel }
 * @returns {Promise<string>}   Response text
 */
async function callGeminiWithRetry(contentParts, options = {}) {
    const temperature = options.temperature ?? 0.2;
    const maxRetriesPerModel = options.maxRetriesPerModel ?? 2;
    // Cap output length: the verification verdict is a tiny JSON object,
    // and fewer tokens = faster response inside Kapso's webhook budget.
    const maxOutputTokens = options.maxOutputTokens ?? 600;

    let lastError = null;

    for (const modelName of MODEL_CHAIN) {
        for (let attempt = 1; attempt <= maxRetriesPerModel; attempt++) {
            try {
                console.log(`🤖 ${modelName} (attempt ${attempt}/${maxRetriesPerModel})`);

                const model = genAI.getGenerativeModel({
                    model: modelName,
                    generationConfig: { temperature, maxOutputTokens }
                });

                const result = await model.generateContent(contentParts);
                const text = result.response.text();

                console.log(`✅ ${modelName} succeeded`);
                return text;

            } catch (error) {
                lastError = error;

                console.warn(
                    `⚠️ ${modelName} attempt ${attempt} failed ` +
                    `[${error.status || "?"}]: ${String(error.message).substring(0, 130)}`
                );

                // Not retryable (404 model missing, 400 bad request) -> next model
                if (!isRetryableError(error)) break;

                if (attempt < maxRetriesPerModel) {
                    const delay = 1200 * Math.pow(2, attempt - 1); // 1.2s, 2.4s
                    console.log(`⏳ Waiting ${delay}ms before retry...`);
                    await sleep(delay);
                }
            }
        }

        console.log(`↪️ Falling back from ${modelName}`);
    }

    throw lastError || new Error("All Gemini models failed");
}

/**
 * Generates an embedding vector with model fallback.
 * Returns null instead of throwing, so rule saving never hard-fails.
 */
async function generateEmbedding(text) {
    let lastError = null;

    for (const modelName of EMBEDDING_MODEL_CHAIN) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.embedContent(text);

            console.log(`✅ Embedding via ${modelName}`);
            return result.embedding.values;

        } catch (error) {
            lastError = error;
            console.warn(
                `⚠️ Embedding ${modelName} failed: ${String(error.message).substring(0, 100)}`
            );
        }
    }

    console.error("❌ All embedding models failed:", lastError?.message);
    return null;
}

// ==========================================
// 8. GENERAL HELPERS
// ==========================================
// NOTE: the AI time-budget helper withTimeout(promise, ms, label) is
// defined once in section 7 above. Do NOT add another withTimeout here —
// a duplicate declaration would shadow it and change the timeout error
// message that isRetryableError() classifies on.

const KNOWN_DOC_KEYS = new Set(
    ["aadhaar", "caste", "ration", "income", "pan", "passbook"]
);

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

/*
  Canonical key for a supporting document name, so "aadhar",
  "Aadhaar Card" and "1. Aadhaar Card - ..." all count as the SAME item.
  Used to track which requirements are already submitted.
*/
function canonicalDocKey(value) {
    const v = String(value || "").toLowerCase();
    if (/aadhar|aadhaar|adhar|\buid\b/.test(v)) return "aadhaar";
    if (/caste|community/.test(v)) return "caste";
    if (/ration/.test(v)) return "ration";
    if (/income/.test(v)) return "income";
    if (/(^|[^a-z])pan([^a-z]|$)/.test(v)) return "pan";
    if (/bank|passbook/.test(v)) return "passbook";
    return v.trim();
}

/*
  Next sequential queue token for a category at a centre.

  Each (category, centre) pair has its own queue that starts at 001,
  so a citizen's token shows exactly how many earlier requests are
  ahead of them at THAT centre. Example: "INC-003" for the third
  Income Certificate request at a centre.
*/
async function nextQueueToken(category, centerCode) {
    const prefix = String(category || "").substring(0, 3).toUpperCase() || "DOC";
    let existing = 0;

    try {
        const result = await db.query(
            `SELECT COUNT(*)::int AS n FROM service_requests
             WHERE category ILIKE $1 AND assigned_center_code ILIKE $2`,
            [String(category || ""), String(centerCode || "")]
        );
        existing = result.rows[0]?.n || 0;
    } catch (err) {
        console.warn("⚠️ Token count query failed:", err.message);
    }

    return `${prefix}-${String(existing + 1).padStart(3, "0")}`;
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

/*
  Best-effort WhatsApp display name (profile pushname / contact name).
  Returns "" when the payload carries no name — callers fall back to phone.
  NOTE: the Kapso workflow must forward a sender_name field for this to
  be populated; otherwise only the phone number is shown on the dashboard.
*/
function getSenderName(body) {
    if (!body || typeof body !== "object") return "";

    const nested = body.entry?.[0]?.changes?.[0]?.value;
    const contactName = nested?.contacts?.[0]?.profile?.name || "";

    const raw =
        body.sender_name ||
        body.senderName ||
        body.pushname ||
        body.pushName ||
        body.profile?.name ||
        body.contact?.name ||
        body.sender?.name ||
        body.conversation?.sender_name ||
        body.message?.pushname ||
        contactName ||
        "";

    const name = String(raw || "").trim().substring(0, 100);
    // Guard against numeric-only "names" (that's just the phone again)
    if (!name || /^\+?\d[\d\s-]*$/.test(name)) return "";
    return name;
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

    if (typeof rawImageUrl === "string" && rawImageUrl.trim()) {
        const match = rawImageUrl.match(/(https?:\/\/[^\s"']+)/);
        if (match) return match[0];
    }

    // Last resort: scan entire payload for any URL
    const bodyString = JSON.stringify(body);
    const fallbackMatch = bodyString.match(/(https?:\/\/[^\s"'>]+)/);

    return fallbackMatch ? fallbackMatch[0] : null;
}

// ==========================================
// 9. AUTH MIDDLEWARE
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
// 10. ADD RULE (dashboard)
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

        // Embedding is optional — rule still saves if it fails
        const vector = await generateEmbedding(content);

        const insertRow = {
            document_type: documentType,
            content: content,
            center_id: centerId || null
        };

        if (vector) insertRow.embedding = vector;

        const { error } = await supabase
            .from('document_rules')
            .insert([insertRow]);

        if (error) throw error;

        return res.json({
            success: true,
            embedded: Boolean(vector),
            message: vector
                ? "Rule stored with embedding"
                : "Rule stored (embedding unavailable, text search still works)"
        });

    } catch (error) {
        console.error("❌ Add Rule Error:", error);
        return res.status(500).json({ error: "Failed to store rule" });
    }
});

app.put('/api/edit-rule/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { content } = req.body;

        if (!content) {
            return res.status(400).json({ error: "content is required" });
        }

        // Embedding is optional — rule still saves if it fails
        const vector = await generateEmbedding(content);

        const updateRow = { content };
        if (vector) updateRow.embedding = vector;

        const { error } = await supabase
            .from('document_rules')
            .update(updateRow)
            .eq('id', id);

        if (error) throw error;

        return res.json({ success: true, embedded: Boolean(vector) });

    } catch (error) {
        console.error("❌ Edit Rule Error:", error);
        return res.status(500).json({ error: "Failed to update rule" });
    }
});

// ==========================================
// 11. CHAT WEBHOOK
//
// Saved DB rules returned DIRECTLY.
// Gemini used only when nothing is saved.
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
            try {
                const { data, error } = await supabase
                    .from('document_rules')
                    .select('id, document_type, content, center_id')
                    .eq('center_id', centerId)
                    .ilike('document_type', userMessage)
                    .limit(10);

                if (error) console.warn("⚠️ Center rule query:", error.message);

                if (data && data.length > 0) {
                    savedRules = data;
                    console.log(`✅ ${data.length} center-specific rule(s)`);
                }
            } catch (e) {
                console.warn("⚠️ Center rule lookup failed:", e.message);
            }
        }

        // STEP 2: global exact match
        if (savedRules.length === 0) {
            try {
                const { data, error } = await supabase
                    .from('document_rules')
                    .select('id, document_type, content, center_id')
                    .ilike('document_type', userMessage)
                    .limit(10);

                if (error) console.warn("⚠️ Global rule query:", error.message);

                if (data && data.length > 0) {
                    savedRules = data;
                    console.log(`✅ ${data.length} global rule(s)`);
                }
            } catch (e) {
                console.warn("⚠️ Global rule lookup failed:", e.message);
            }
        }

        // STEP 3: partial match
        if (savedRules.length === 0) {
            try {
                const { data, error } = await supabase
                    .from('document_rules')
                    .select('id, document_type, content, center_id')
                    .ilike('document_type', `%${userMessage}%`)
                    .limit(10);

                if (error) console.warn("⚠️ Partial rule query:", error.message);

                if (data && data.length > 0) {
                    savedRules = data;
                    console.log(`✅ ${data.length} partial rule(s)`);
                }
            } catch (e) {
                console.warn("⚠️ Partial rule lookup failed:", e.message);
            }
        }

        // A service selection starts a NEW application: clear previously
        // accepted supporting docs so "remaining" starts full again.
        // Plain questions must NOT wipe mid-application progress, so only
        // reset when the message is a known service or matched saved rules.
        const knownServices = Object.values(session.services || {})
            .map(s => String(s).toLowerCase().trim());
        const isServiceStart =
            knownServices.includes(String(userMessage).toLowerCase().trim()) ||
            savedRules.length > 0;

        if (isServiceStart) {
            const freshKey = String(userMessage || "").toLowerCase().trim();
            const keptAccepted = { ...((getSession(phone).acceptedDocs) || {}) };
            if (freshKey) keptAccepted[freshKey] = [];
            updateSession(phone, { acceptedDocs: keptAccepted });
            console.log(`🆕 New application for "${userMessage}" — accepted docs reset`);
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

        // FALLBACK: Gemini with retry
        console.log("⚠️ No saved rule found. Using Gemini fallback.");

        const prompt = `
You are an official Akshaya Center assistant in Kerala.

Citizen service request: ${userMessage}

List only the essential required documents as short bullet points.
Keep it WhatsApp friendly and under 120 words.
End by noting that final requirements should be confirmed at the center.
`;

        let aiReply;

        try {
            aiReply = await callGeminiWithRetry([prompt], {
                temperature: 0.3,
                maxRetriesPerModel: 2
            });

        } catch (aiError) {
            console.error("❌ All Gemini models failed:", aiError.message);

            return res.json({
                success: true,
                source: "unavailable",
                service: userMessage,
                reply_message:
                    `📋 *${userMessage}*\n\n` +
                    `Our assistant is very busy right now.\n\n` +
                    `📎 You can still upload your document photo and we will verify it, ` +
                    `or contact your Akshaya Center for the document list. 🙏`
            });
        }

        return res.json({
            success: true,
            source: "gemini_fallback",
            service: userMessage,
            reply_message:
                `${aiReply}\n\n📎 *Next Step:* Please upload a clear photo of your document.`
        });

    } catch (error) {
        console.error("❌ Chat webhook error:", error.message);

        return res.json({
            success: true,
            reply_message:
                "Sorry, I could not process that. Please select the service again."
        });
    }
});

// ==========================================
// 12. DOCUMENT VERIFICATION
//
// PASS / FAIL against saved rules.
// FAIL -> asks user to retake the photo.
// ==========================================
app.post('/api/webhook/document-upload', async (req, res) => {

    // Set to false once everything works in production
    const DEBUG = true;

    try {
        console.log("\n========== DOCUMENT UPLOAD WEBHOOK ==========");
        console.log(JSON.stringify(req.body, null, 2));

        const phone = getPhoneFromBody(req.body);
        const session = getSession(phone);

        // Remember the sender's display name for the dashboard ("" if absent)
        const senderName = getSenderName(req.body) || session.senderName || "";
        if (getSenderName(req.body)) {
            updateSession(phone, { senderName: getSenderName(req.body) });
        }

        // ---------- 1. Image URL ----------
        const imageUrl = extractImageUrl(req.body);

        if (!imageUrl) {
            console.warn("⚠️ No image URL in payload.");

            return res.json({
                success: true,
                verification_status: "RETRY",
                is_valid: false,
                reply_message:
                    "❌ *No image received.*\n\n" +
                    "Please tap 📎 or 📷 and send a clear photo of your document."
            });
        }

        // ---------- 2. Document type ----------
        let serviceRequested = normalizeText(
            req.body.document_type ||
            req.body.documentType ||
            req.body.service ||
            req.body.selected_service ||
            req.body.service_title ||
            ""
        );

        const selectedId = getSelectedListId(req.body);

        if (!serviceRequested && selectedId && session.services?.[selectedId]) {
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

        // ---------- 3. Load saved rules (guarded) ----------
        let rulesText = "";

        try {
            if (centerId) {
                const { data } = await supabase
                    .from('document_rules')
                    .select('content')
                    .eq('center_id', centerId)
                    .ilike('document_type', serviceRequested)
                    .limit(3);

                if (data && data.length > 0) {
                    rulesText = data.map(r => r.content).join("\n");
                    console.log("✅ Center-specific rule loaded");
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
                    console.log("✅ Global rule loaded");
                }
            }
        } catch (ruleErr) {
            console.warn("⚠️ Rule lookup failed (continuing):", ruleErr.message);
        }

        if (!rulesText) {
            console.warn("⚠️ No saved rule. Using generic criteria.");

            rulesText =
                "The document must be an official government-issued document, " +
                "readable, not severely blurred or cropped, showing the holder's " +
                "name and identifying details.";
        }

        console.log("⚖️ Rules:", rulesText.substring(0, 200));

        // ---------- 4. Download image + detect MIME ----------
        // Kept short: every second here eats into Kapso's webhook timeout.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        let imageBuffer;
        let mimeType = "image/jpeg";

        try {
            let response = await fetch(imageUrl, {
                headers: {
                    'X-API-Key': process.env.KAPSO_API_KEY || '',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'image/*,*/*'
                },
                signal: controller.signal
            });

            if (!response.ok) {
                console.log(`⚠️ Auth fetch ${response.status}. Retrying plain.`);

                response = await fetch(imageUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'image/*,*/*'
                    },
                    signal: controller.signal
                });
            }

            if (!response.ok) {
                throw new Error(`Download failed: ${response.status}`);
            }

            const contentType = response.headers.get('content-type') || "";

            if (contentType.includes('png')) mimeType = 'image/png';
            else if (contentType.includes('webp')) mimeType = 'image/webp';
            else if (contentType.includes('heic')) mimeType = 'image/heic';
            else if (contentType.includes('jpeg') || contentType.includes('jpg')) mimeType = 'image/jpeg';

            imageBuffer = await response.arrayBuffer();

            console.log(`✅ Image downloaded | ${mimeType} | ${imageBuffer.byteLength} bytes`);

            if (imageBuffer.byteLength < 1000) {
                throw new Error("File too small to be a valid image");
            }

        } catch (downloadErr) {
            clearTimeout(timeout);
            console.error("❌ Download failed:", downloadErr.message);

            return res.json({
                success: true,
                verification_status: "RETRY",
                is_valid: false,
                debug: DEBUG ? `download: ${downloadErr.message}` : undefined,
                reply_message:
                    "❌ *Could not open your image.*\n\n" +
                    "Please send the photo again using 📎 or 📷."
            });
        } finally {
            clearTimeout(timeout);
        }

        const base64Image = Buffer.from(imageBuffer).toString('base64');

        // ---------- 5. AI verification with retry ----------
        const prompt = `
You are an Akshaya Center document verification officer in Kerala.

The citizen is APPLYING FOR: ${serviceRequested}

They must SUBMIT these supporting documents:
${rulesText}

CRITICAL INSTRUCTION:
The citizen is applying to OBTAIN a "${serviceRequested}".
They are NOT expected to upload a "${serviceRequested}".
You are ONLY checking their supporting documents.

TASK:
Identify what document is in the image, then check whether it matches
ANY item in the supporting documents list above.

Match generously. Common name variations are the SAME document:
- "aadhar", "aadhaar", "adhar", "UID", "Aadhaar Card" -> Aadhaar Card
- "caste", "caste certificate", "community certificate" -> Caste Certificate
- "ration", "ration card" -> Ration Card
- "income", "income certificate" -> Income Certificate
- "pan", "pan card" -> PAN Card
- "bank", "passbook", "bank passbook" -> Bank Passbook

Set status = "PASS" if:
- The uploaded document matches ANY ONE item in the supporting list, AND
- The image is readable

Set status = "FAIL" only if:
- The document is NOT in the supporting documents list at all, OR
- Text is genuinely unreadable (severe blur, extreme darkness, heavy glare), OR
- Major parts of the document are cut off

Minor wear, slight angle, coloured background, lamination, and normal
phone photos are ACCEPTABLE.

Reply with ONLY this JSON. No markdown fences, no extra text:
{
  "status": "PASS",
  "detected_document": "name of document you see",
  "matched_requirement": "which item from the supporting list it matches, or empty",
  "is_readable": true,
  "missing_or_problem": [],
  "reason": "one short sentence"
}
`;

        let rawText;

        try {
            // One attempt per model (fail fast to next model, no backoff
            // sleeps) + hard time budget, so Kapso gets a reply in time
            // instead of timing out and sending the citizen nothing.
            rawText = await withTimeout(
                callGeminiWithRetry(
                    [
                        prompt,
                        { inlineData: { data: base64Image, mimeType } }
                    ],
                    { temperature: 0.2, maxRetriesPerModel: 1 }
                ),
                20000,
                "AI verification"
            );

        } catch (aiError) {
            console.error("❌ All Gemini models failed:", aiError.message);

            const overloaded = isRetryableError(aiError);

            return res.json({
                success: true,
                verification_status: "RETRY",
                is_valid: false,
                debug: DEBUG ? `ai: ${aiError.message}` : undefined,
                reply_message: overloaded
                    ? "⏳ *Our verification service is very busy right now.*\n\n" +
                    "Please wait about 30 seconds, then upload your document again. 🙏"
                    : "⚠️ *Could not check your document right now.*\n\n" +
                    "Please upload it again in a moment."
            });
        }

        console.log("🤖 Raw AI output:", rawText);

        // ---------- 6. Parse JSON safely ----------
        let verdict;

        try {
            const cleaned = String(rawText)
                .replace(/```json/gi, "")
                .replace(/```/g, "")
                .trim();

            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

            verdict = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);

        } catch (parseErr) {
            console.warn("⚠️ JSON parse failed. Falling back to text scan.");

            const upper = String(rawText).toUpperCase();

            const looksPass =
                upper.includes('"PASS"') ||
                (upper.includes("PASS") && !upper.includes("FAIL"));

            verdict = {
                status: looksPass ? "PASS" : "FAIL",
                detected_document: "",
                missing_or_problem: [],
                reason: "Automatic verification completed."
            };
        }

        const isPass = String(verdict.status || "").trim().toUpperCase() === "PASS";

        const problems = Array.isArray(verdict.missing_or_problem)
            ? verdict.missing_or_problem.filter(Boolean)
            : [];

        // ---------- 7. Build WhatsApp reply ----------
        // Rule text comes in two shapes:
        //   "aadhar,caste" (compact, maybe with trailing newline from forms)
        //   multi-line descriptive rules (commas inside descriptions are kept).
        // A single comma-line is split ONLY if every fragment is a known
        // document; otherwise the line is kept whole.
        const ruleLines = rulesText
            .split(/\n+/)
            .map(s => s.trim())
            // Drop header lines like "Required supporting documents:"
            .filter(s => s && !/:$/.test(s));

        let requiredList = ruleLines;
        if (ruleLines.length === 1 && ruleLines[0].includes(",")) {
            const parts = ruleLines[0]
                .split(/[,;]+/)
                .map(s => s.trim())
                .filter(Boolean);
            if (
                parts.length > 1 &&
                parts.every(p => KNOWN_DOC_KEYS.has(canonicalDocKey(p)))
            ) {
                requiredList = parts;
            }
        }

        // Supporting docs already accepted for THIS service (earlier uploads),
        // so "remaining" shrinks across uploads instead of repeating.
        const serviceKey = String(serviceRequested || "").toLowerCase().trim();
        const previouslyAccepted =
            (session.acceptedDocs && session.acceptedDocs[serviceKey]) || [];
        const currentKey = canonicalDocKey(verdict.matched_requirement);

        const acceptedKeys = new Set(
            [...previouslyAccepted, ...(isPass && currentKey ? [currentKey] : [])]
                .filter(Boolean)
        );

        const remaining = requiredList.filter(
            r => !acceptedKeys.has(canonicalDocKey(r))
        );

        console.log(`📋 Required: [${requiredList.join(" | ")}] | Accepted: [${[...acceptedKeys].join(" | ")}] | Remaining: [${remaining.join(" | ")}]`);

        let replyMessage;

        if (isPass) {
            // Remember this accepted doc for the next upload in this session
            if (currentKey) {
                updateSession(phone, {
                    acceptedDocs: {
                        ...(session.acceptedDocs || {}),
                        [serviceKey]: [...acceptedKeys]
                    }
                });
            }

            replyMessage =
                `✅ *DOCUMENT ACCEPTED*\n\n` +
                `📄 Received: *${verdict.detected_document || "Document"}*\n` +
                (verdict.matched_requirement
                    ? `✔️ Matches requirement: *${verdict.matched_requirement}*\n`
                    : "") +
                `\n📌 Applying for: *${serviceRequested}*\n\n` +
                (remaining.length > 0
                    ? `📋 *Remaining documents to upload:*\n` +
                      remaining.map(r => `• ${r}`).join("\n") +
                      `\n\nUpload the next document, or visit the center if you are done. 🙏`
                    : `🎉 *All required documents received!*\n\n` +
                      `You may now visit the Akshaya Center to complete your application. 🙏`);

        } else {
            const problemList = problems.length > 0
                ? problems.map(p => `• ${p}`).join("\n")
                : `• ${verdict.reason || "Document could not be verified."}`;

            replyMessage =
                `❌ *DOCUMENT NOT ACCEPTED*\n\n` +
                (verdict.detected_document
                    ? `📄 We detected: *${verdict.detected_document}*\n`
                    : "") +
                `📌 Applying for: *${serviceRequested}*\n\n` +
                `📋 *Accepted supporting documents:*\n` +
                requiredList.map(r => `• ${r}`).join("\n") +
                `\n\n*Issue:*\n${problemList}\n\n` +
                `📷 *Tips for a clear photo:*\n` +
                `1. Place the document flat on a plain surface\n` +
                `2. Use bright light, avoid shadows and glare\n` +
                `3. Capture all four corners\n` +
                `4. Hold steady so the text is sharp\n\n` +
                `Please tap 📎 or 📷 and upload again.`;
        }

        console.log(`🏁 Verdict: ${isPass ? "PASS ✅" : "FAIL ❌"}`);

        // ---------- 8. Save accepted document ----------
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
                console.warn("⚠️ Save skipped:", saveErr.message);
            }

            // Mirror into Postgres service_requests so the center dashboard
            // lists every verified WhatsApp submission (legacy flow only
            // wrote here, so the new flow was invisible on the dashboard).
            // document_urls entries are "label|url" (dashboard parses both
            // this and legacy plain-URL entries).
            // Always attempt the mirror insert: a past transient DB error
            // must not latch isDbConnected=false forever and silently drop
            // every later save. A successful insert re-arms the flag.
            {
                const dashToken = await nextQueueToken(serviceRequested, centerId || 'GLOBAL');
                const docLabel = verdict.detected_document || verdict.matched_requirement || serviceRequested;

                try {
                    await db.query(
                        `INSERT INTO service_requests
                         (token_number, category, citizen_phone, citizen_name, document_urls, assigned_center_code)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [
                            dashToken,
                            serviceRequested,
                            phone,
                            senderName || null,
                            [`${docLabel}|${imageUrl}`],
                            centerId || 'GLOBAL'
                        ]
                    );

                    console.log("💾 Saved to service_requests for dashboard");
                    isDbConnected = true;

                } catch (dashErr) {
                    // Older DBs lack the citizen_name column — retry without it
                    if (/citizen_name/i.test(dashErr.message)) {
                        try {
                            await db.query(
                                `INSERT INTO service_requests
                                 (token_number, category, citizen_phone, document_urls, assigned_center_code)
                                 VALUES ($1, $2, $3, $4, $5)`,
                                [
                                    dashToken,
                                    serviceRequested,
                                    phone,
                                    [`${docLabel}|${imageUrl}`],
                                    centerId || 'GLOBAL'
                                ]
                            );

                            console.log("💾 Saved to service_requests (legacy schema)");
                            isDbConnected = true;
                        } catch (retryErr) {
                            console.warn("⚠️ Dashboard save skipped:", retryErr.message);
                        }
                    } else {
                        console.warn("⚠️ Dashboard save skipped:", dashErr.message);
                    }
                }
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
        console.error("🔥 CRASH:", error);
        console.error("🔥 STACK:", error.stack);

        return res.json({
            success: true,
            verification_status: "RETRY",
            is_valid: false,
            debug: DEBUG ? `${error.name}: ${error.message}` : undefined,
            reply_message:
                "⚠️ *Something went wrong while checking your document.*\n\n" +
                "Please take a clear, well-lit photo and upload it again."
        });
    }
});

// ==========================================
// 13. LEGACY CLOUDINARY UPLOAD
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
                        'Accept': 'image/*,*/*'
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
                    const tokenNumber = await nextQueueToken('Document', 'HQ-001');

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
// 14. AUTH ENDPOINTS
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

// Change password endpoint
app.put('/api/auth/change-password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const userEmail = req.user.email;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current password and new password are required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }

        // Superadmin (hardcoded) cannot change password via this endpoint
        if (userEmail === 'admin@akshaya.com') {
            return res.status(403).json({ error: 'Superadmin password cannot be changed here' });
        }

        // Get user from database
        const result = await db.query(
            'SELECT * FROM akshaya_centers WHERE email = $1',
            [userEmail]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Center not found' });
        }

        const user = result.rows[0];

        // Verify current password
        const validPass = await bcrypt.compare(currentPassword, user.password_hash);
        if (!validPass) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        // Hash new password
        const newHash = await bcrypt.hash(newPassword, 10);

        // Update password in database
        await db.query(
            'UPDATE akshaya_centers SET password_hash = $1 WHERE email = $2',
            [newHash, userEmail]
        );

        return res.json({ success: true, message: 'Password changed successfully' });

    } catch (error) {
        console.error("Change password error:", error);
        return res.status(500).json({ error: 'Failed to change password' });
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
            'SELECT * FROM service_requests ORDER BY created_at ASC'
        );

        return res.json(result.rows);

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 15. RULES MANAGEMENT
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

        const vector = await generateEmbedding(content);

        const updateRow = { content: content };
        if (vector) updateRow.embedding = vector;

        const { error } = await supabase
            .from('document_rules')
            .update(updateRow)
            .eq('id', id);

        if (error) throw error;

        return res.json({
            success: true,
            embedded: Boolean(vector),
            message: "Rule updated"
        });

    } catch (error) {
        console.error("Edit rule error:", error);
        return res.status(500).json({ error: "Failed to update rule" });
    }
});

// ==========================================
// 16. PUBLIC CENTERS
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
// 17. SEND CENTERS MENU
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
            const centerCode = safeId(center.center_code || `CENTER_${index + 1}`);

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
// 18. SEND SERVICES MENU
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
            try {
                const { data } = await supabase
                    .from('akshaya_centers')
                    .select('center_code')
                    .ilike('center_name', selectedCenterTitle)
                    .limit(1);

                if (data && data.length > 0) {
                    centerId = data[0].center_code;
                }
            } catch (e) {
                console.warn("⚠️ Center title lookup failed:", e.message);
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
            try {
                const { data, error } = await supabase
                    .from('document_rules')
                    .select('document_type')
                    .eq('center_id', centerId);

                if (error) console.warn("⚠️ Center service fetch:", error.message);

                if (data && data.length > 0) {
                    services = [...new Set(
                        data.map(i => normalizeText(i.document_type)).filter(Boolean)
                    )];
                }
            } catch (e) {
                console.warn("⚠️ Center services failed:", e.message);
            }
        }

        // Global services (seeded rules have center_id = null)
        if (services.length === 0) {
            try {
                const { data, error } = await supabase
                    .from('document_rules')
                    .select('document_type');

                if (error) console.warn("⚠️ Global service fetch:", error.message);

                if (data && data.length > 0) {
                    services = [...new Set(
                        data.map(i => normalizeText(i.document_type)).filter(Boolean)
                    )];

                    console.log("✅ Using GLOBAL service list");
                }
            } catch (e) {
                console.warn("⚠️ Global services failed:", e.message);
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
// 19. DEBUG (remove before production)
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
            deployed_commit: process.env.RENDER_GIT_COMMIT || "local/unknown",
            postgres_connected: isDbConnected,
            gemini_key_set: Boolean(process.env.GEMINI_API_KEY),
            kapso_key_set: Boolean(process.env.KAPSO_API_KEY),
            kapso_phone_id_set: Boolean(process.env.KAPSO_PHONE_ID),
            model_chain: MODEL_CHAIN,
            embedding_chain: EMBEDDING_MODEL_CHAIN,
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

// Tests which models in MODEL_CHAIN actually respond
app.get('/api/debug/gemini', async (req, res) => {
    const results = [];

    for (const modelName of MODEL_CHAIN) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent(["Reply with the single word: OK"]);

            results.push({
                model: modelName,
                ok: true,
                response: result.response.text().trim().substring(0, 40)
            });

        } catch (error) {
            results.push({
                model: modelName,
                ok: false,
                status: error.status || null,
                error: String(error.message).substring(0, 160)
            });
        }
    }

    return res.json({ results });
});

// Lists EVERY model your API key can actually use
app.get('/api/debug/list-models', async (req, res) => {
    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
        );

        const data = await response.json();

        if (!data.models) {
            return res.status(500).json({
                error: "No models returned",
                raw: data
            });
        }

        const generation = [];
        const embedding = [];

        for (const model of data.models) {
            const name = model.name.replace("models/", "");
            const methods = model.supportedGenerationMethods || [];

            if (methods.includes("generateContent")) generation.push(name);
            if (methods.includes("embedContent")) embedding.push(name);
        }

        return res.json({
            total: data.models.length,
            currently_using_generation: MODEL_CHAIN,
            currently_using_embedding: EMBEDDING_MODEL_CHAIN,
            available_generateContent: generation,
            available_embedContent: embedding
        });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 20. HEALTH
// ==========================================
app.get('/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: "Akshaya Sahayi bot is healthy"
    });
});

// ==========================================
// 21. START
// ==========================================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});