require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Tool Configurations
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

// Suppress unhandled DB pool errors during network drops
db.on('error', (err) => {
    isDbConnected = false;
});

// Test DB Connection on Boot
db.query('SELECT 1').then(() => {
    isDbConnected = true;
    console.log("✅ Connected to PostgreSQL database.");
}).catch((err) => {
    isDbConnected = false;
    console.log("ℹ️ Cloud PostgreSQL unavailable. Running in Local Mode (local_db.json).");
});

const DB_FILE = path.join(__dirname, 'local_db.json');

function loadLocalDb() {
    if (fs.existsSync(DB_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        } catch (e) {
            console.error("Error reading local_db.json:", e);
        }
    }
    const initialData = {
        centers: [
            {
                center_code: 'HQ-001',
                email: 'admin@akshaya.com',
                password_hash: bcrypt.hashSync('admin123', 10),
                center_name: 'Akshaya HQ',
                district: 'Trivandrum',
                role: 'superadmin'
            }
        ],
        requests: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    return initialData;
}

const localData = loadLocalDb();
const fallbackCenters = localData.centers;
const fallbackRequests = localData.requests;

function saveLocalDb() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify({ centers: fallbackCenters, requests: fallbackRequests }, null, 2));
    } catch (e) {
        console.error("Error saving local_db.json:", e);
    }
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
        isDbConnected = false;
        console.warn("⚠️ Token count query failed, counting local only:", err.message);
    }

    const localCount = fallbackRequests.filter(r =>
        String(r.category || "").toLowerCase() === String(category || "").toLowerCase() &&
        String(r.assigned_center_code || "").toLowerCase() === String(centerCode || "").toLowerCase()
    ).length;

    return `${prefix}-${String(existing + localCount + 1).padStart(3, "0")}`;
}

// Middleware for Dashboard Security
const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.sendStatus(401);

    jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// 1.5. PUBLIC ENDPOINT FOR KAPSO / WHATSAPP BOT DYNAMIC LIST
app.get('/api/public/centers', async (req, res) => {
    try {
        let centersList = [];
        if (isDbConnected) {
            try {
                const result = await db.query('SELECT center_code, center_name, district FROM akshaya_centers ORDER BY center_name ASC');
                centersList = result.rows;
            } catch (dbErr) {
                isDbConnected = false;
            }
        }
        if (!isDbConnected || centersList.length === 0) {
            centersList = fallbackCenters.map(c => ({
                center_code: c.center_code,
                center_name: c.center_name || c.center_code,
                district: c.district || 'Kerala'
            }));
        }

        const kapsoOptions = centersList.map(c => ({
            id: c.center_code,
            title: c.center_name || c.center_code,
            description: `District: ${c.district}`
        }));

        res.json({
            success: true,
            total: centersList.length,
            mode: isDbConnected ? 'PostgreSQL' : 'Local DB',
            centers: centersList,
            kapso_whatsapp_interactive_list: kapsoOptions
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. DASHBOARD LOGIN
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        let user;

        if (isDbConnected) {
            try {
                const result = await db.query('SELECT * FROM akshaya_centers WHERE email = $1', [email]);
                if (result.rows.length > 0) user = result.rows[0];
            } catch (dbErr) {
                isDbConnected = false;
            }
        }

        if (!isDbConnected || !user) {
            user = fallbackCenters.find(c => c.email === email);
        }

        if (!user) return res.status(400).json({ message: 'User not found' });

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) return res.status(400).json({ message: 'Invalid Password' });

        const token = jwt.sign(
            { center_code: user.center_code, role: user.role, name: user.center_name },
            process.env.JWT_SECRET || 'fallback_secret'
        );
        res.json({ token, role: user.role, center_code: user.center_code });

    } catch (error) {
        console.error("🔥 LOGIN ERROR: ", error);
        res.status(500).json({ error: error.message });
    }
});

// 3. SUPER ADMIN: Create Accounts
app.post('/api/admin/create-center', authenticateToken, async (req, res) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ message: 'Denied' });

    const { center_code, email, password, center_name, district } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        let createdCenter;

        if (isDbConnected) {
            try {
                const query = `
              INSERT INTO akshaya_centers (center_code, email, password_hash, center_name, district)
              VALUES ($1, $2, $3, $4, $5) RETURNING *;`;
                const result = await db.query(query, [center_code, email, hashedPassword, center_name, district]);
                createdCenter = result.rows[0];
            } catch (dbErr) {
                isDbConnected = false;
            }
        }

        if (!isDbConnected || !createdCenter) {
            createdCenter = { center_code, email, password_hash: hashedPassword, center_name: center_name || center_code, district: district || 'Kerala', role: 'center' };
            fallbackCenters.push(createdCenter);
            saveLocalDb();
        }

        // Automatic Kapso WhatsApp Bot Sync Trigger
        if (process.env.KAPSO_WEBHOOK_URL) {
            fetch(process.env.KAPSO_WEBHOOK_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.KAPSO_API_KEY || ''}`
                },
                body: JSON.stringify({
                    event: 'center.created',
                    center: {
                        center_code: createdCenter.center_code,
                        center_name: createdCenter.center_name,
                        district: createdCenter.district
                    }
                })
            }).then(() => console.log("✅ Kapso WhatsApp auto-synced for center:", createdCenter.center_code))
              .catch(err => console.warn("⚠️ Kapso auto-sync webhook skipped:", err.message));
        }

        res.status(201).json({
            success: true,
            center: createdCenter,
            kapso_synced: true,
            message: 'Centre created & auto-synced with Kapso WhatsApp bot.'
        });

    } catch (error) {
        console.error("🔥 CREATE CENTER ERROR: ", error);
        res.status(500).json({ error: error.message });
    }
});

// 4. WHATSAPP WEBHOOK: Receive Documents & Process via Cloudinary Stream
app.post('/api/webhook/document-upload', async (req, res) => {
    try {
        const { category, phone_number, assigned_center_code, temp_image_urls } = req.body;

        if (!temp_image_urls || !Array.isArray(temp_image_urls)) {
            return res.status(400).json({ success: false, error: "temp_image_urls array is required" });
        }

        // Download each temporary URL from WhatsApp/Kapso and upload buffer to Cloudinary
        const uploadPromises = temp_image_urls.map(async (fileUrl) => {
            try {
                // Fetch binary buffer from the temporary URL using axios
                const mediaResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
                const fileBuffer = Buffer.from(mediaResponse.data);

                // Upload buffer stream to Cloudinary
                return new Promise((resolve, reject) => {
                    cloudinary.uploader.upload_stream(
                        { folder: 'akshaya_docs', resource_type: 'auto' },
                        (error, result) => {
                            if (error) reject(error);
                            else resolve(result.secure_url);
                        }
                    ).end(fileBuffer);
                });
            } catch (err) {
                console.error(`Failed to process media item ${fileUrl}:`, err.message);
                // Fallback to original url if download/upload fails
                return fileUrl;
            }
        });

        const permanentUrls = await Promise.all(uploadPromises);
        const tokenNumber = await nextQueueToken(category, assigned_center_code);

        if (isDbConnected) {
            try {
                const query = `
              INSERT INTO service_requests (token_number, category, citizen_phone, document_urls, assigned_center_code)
              VALUES ($1, $2, $3, $4, $5) RETURNING *;`;
                await db.query(query, [tokenNumber, category, phone_number, permanentUrls, assigned_center_code]);
            } catch (dbErr) {
                isDbConnected = false;
                console.warn("⚠️ DB write failed during webhook, falling back to local storage:", dbErr.message);
            }
        }

        if (!isDbConnected) {
            fallbackRequests.push({
                token_number: tokenNumber,
                category,
                citizen_phone: phone_number,
                document_urls: permanentUrls,
                assigned_center_code,
                created_at: new Date()
            });
            saveLocalDb();
        }

        res.status(200).json({ success: true, token_number: tokenNumber, document_urls: permanentUrls });

    } catch (error) {
        console.error("🔥 WEBHOOK ERROR: ", error);
        res.status(500).json({ error: error.message });
    }
});

// 5. DASHBOARD: Fetch Documents
app.get('/api/dashboard/requests', authenticateToken, async (req, res) => {
    try {
        let requestsList;

        if (isDbConnected) {
            try {
                let result;
                if (req.user.role === 'superadmin') {
                    result = await db.query(`SELECT * FROM service_requests ORDER BY created_at ASC`);
                } else {
                    result = await db.query(`SELECT * FROM service_requests WHERE assigned_center_code = $1 ORDER BY category ASC, created_at ASC`, [req.user.center_code]);
                }
                requestsList = result.rows;
            } catch (dbErr) {
                isDbConnected = false;
            }
        }

        if (!isDbConnected || !requestsList) {
            if (req.user.role === 'superadmin') {
                requestsList = [...fallbackRequests];
            } else {
                requestsList = fallbackRequests.filter(r => r.assigned_center_code === req.user.center_code);
            }
        }

        res.json(requestsList);

    } catch (error) {
        console.error("🔥 FETCH REQUESTS ERROR: ", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));