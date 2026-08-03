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

db.on('error', (err) => {
    isDbConnected = false;
});

// Test DB Connection on Boot & Seed Default HQ Center
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
}).catch((err) => {
    isDbConnected = false;
    console.log("ℹ️ Cloud PostgreSQL unavailable. Running in Local Mode (local_db.json).");
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
// 2. KAPSO WEBHOOK ENDPOINT
// ==========================================
app.post('/api/webhook/document-upload', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const rawBody = req.body;
        const payload = JSON.parse(rawBody.toString());

        const phone_number = payload.message?.from || payload.conversation?.phone_number;
        const imageUrl = payload.message?.image?.link || payload.message?.kapso?.media_url;
        const facebookUrl = payload.message?.image?.url; // Direct FB fallback

        if (imageUrl && phone_number) {
            let permanentUrl = imageUrl;

            try {
                console.log("📥 Downloading image from WhatsApp/Kapso...");

                let buffer;
                const imgRes = await fetch(imageUrl);

                if (imgRes.ok) {
                    buffer = Buffer.from(await imgRes.arrayBuffer());
                } else if (facebookUrl) {
                    const fbRes = await fetch(facebookUrl, {
                        headers: { 'Authorization': `Bearer ${process.env.KAPSO_API_KEY || ''}` }
                    });
                    if (!fbRes.ok) throw new Error(`Both image sources rejected the download.`);
                    buffer = Buffer.from(await fbRes.arrayBuffer());
                } else {
                    throw new Error(`Download failed with status ${imgRes.status}`);
                }

                // Save physically to VS Code folder temporarily for a bulletproof upload
                const tempFilePath = path.join(__dirname, `temp_${Date.now()}.jpg`);
                fs.writeFileSync(tempFilePath, buffer);

                console.log("☁️ Uploading to Cloudinary...");
                const uploadResult = await cloudinary.uploader.upload(tempFilePath, { folder: 'akshaya_docs' });
                permanentUrl = uploadResult.secure_url;

                // Cleanup temporary file
                fs.unlinkSync(tempFilePath);
                console.log("✅ Successfully uploaded to Cloudinary!");

            } catch (cloudErr) {
                console.warn("⚠️ Upload Pipeline Failed, using raw fallback URL:", cloudErr.message);
            }

            const category = 'Document';
            const assigned_center_code = 'HQ-001';
            const tokenNumber = `DOC-${Date.now().toString().slice(-6)}`;
            const documentUrlsArray = [permanentUrl];

            if (isDbConnected) {
                try {
                    const query = `
                      INSERT INTO service_requests (token_number, category, citizen_phone, document_urls, assigned_center_code)
                      VALUES ($1, $2, $3, $4, $5) RETURNING *;`;
                    await db.query(query, [tokenNumber, category, phone_number, documentUrlsArray, assigned_center_code]);
                    console.log("✅ Saved service request to Supabase!");
                } catch (dbErr) {
                    console.error("🔥 DB Insert Error:", dbErr.message);
                }
            }
        }

        res.status(200).send('OK');

    } catch (error) {
        console.error("🔥 WEBHOOK ERROR: ", error);
        res.status(500).send('Internal Server Error');
    }
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
            centersList = fallbackCenters.map(c => ({ center_code: c.center_code, center_name: c.center_name || c.center_code, district: c.district || 'Kerala' }));
        }
        const kapsoOptions = centersList.map(c => ({ id: c.center_code, title: c.center_name || c.center_code, description: `District: ${c.district}` }));
        res.json({ success: true, total: centersList.length, mode: isDbConnected ? 'PostgreSQL' : 'Local DB', centers: centersList, kapso_whatsapp_interactive_list: kapsoOptions });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        let user;
        if (isDbConnected) {
            try {
                const result = await db.query('SELECT * FROM akshaya_centers WHERE email = $1', [email]);
                if (result.rows.length > 0) user = result.rows[0];
            } catch (dbErr) { isDbConnected = false; }
        }
        if (!isDbConnected || !user) user = fallbackCenters.find(c => c.email === email);
        if (!user) return res.status(400).json({ message: 'User not found' });
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) return res.status(400).json({ message: 'Invalid Password' });
        const token = jwt.sign({ center_code: user.center_code, role: user.role, name: user.center_name }, process.env.JWT_SECRET || 'fallback_secret');
        res.json({ token, role: user.role, center_code: user.center_code });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/admin/create-center', authenticateToken, async (req, res) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ message: 'Denied' });
    const { center_code, email, password, center_name, district } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        let createdCenter;
        if (isDbConnected) {
            try {
                const query = `INSERT INTO akshaya_centers (center_code, email, password_hash, center_name, district) VALUES ($1, $2, $3, $4, $5) RETURNING *;`;
                const result = await db.query(query, [center_code, email, hashedPassword, center_name, district]);
                createdCenter = result.rows[0];
            } catch (dbErr) { isDbConnected = false; }
        }
        if (!isDbConnected || !createdCenter) {
            createdCenter = { center_code, email, password_hash: hashedPassword, center_name: center_name || center_code, district: district || 'Kerala', role: 'center' };
            fallbackCenters.push(createdCenter);
            saveLocalDb();
        }
        res.status(201).json({ success: true, center: createdCenter, kapso_synced: true, message: 'Centre created' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/dashboard/requests', authenticateToken, async (req, res) => {
    try {
        let requestsList;
        if (isDbConnected) {
            try {
                let result;
                if (req.user.role === 'superadmin') {
                    result = await db.query(`SELECT * FROM service_requests ORDER BY created_at DESC`);
                } else {
                    result = await db.query(`SELECT * FROM service_requests WHERE assigned_center_code = $1 ORDER BY category ASC, created_at DESC`, [req.user.center_code]);
                }
                requestsList = result.rows;
            } catch (dbErr) { isDbConnected = false; }
        }
        if (!isDbConnected || !requestsList) {
            if (req.user.role === 'superadmin') requestsList = [...fallbackRequests];
            else requestsList = fallbackRequests.filter(r => r.assigned_center_code === req.user.center_code);
        }
        res.json(requestsList);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));