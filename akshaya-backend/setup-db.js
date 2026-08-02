require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function setupDatabase() {
    try {
        console.log("Creating tables...");
        
        await db.query(`
            CREATE TABLE IF NOT EXISTS akshaya_centers (
                id SERIAL PRIMARY KEY,
                center_code VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                center_name VARCHAR(255) NOT NULL,
                district VARCHAR(100) NOT NULL,
                role VARCHAR(20) DEFAULT 'center',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS service_requests (
                id SERIAL PRIMARY KEY,
                token_number VARCHAR(50) UNIQUE NOT NULL,
                category VARCHAR(100) NOT NULL,
                citizen_phone VARCHAR(20) NOT NULL,
                document_urls TEXT[] NOT NULL,
                assigned_center_code VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log("Tables created successfully.");

        // Check if admin user exists
        const adminCheck = await db.query("SELECT * FROM akshaya_centers WHERE email = 'admin@akshaya.com'");
        if (adminCheck.rows.length === 0) {
            const defaultPassword = 'admin123';
            const hashedPassword = await bcrypt.hash(defaultPassword, 10);
            await db.query(`
                INSERT INTO akshaya_centers (center_code, email, password_hash, center_name, district, role)
                VALUES ('HQ-001', 'admin@akshaya.com', $1, 'Akshaya HQ', 'Trivandrum', 'superadmin');
            `, [hashedPassword]);
            console.log("Created default Super Admin user:");
            console.log("Email: admin@akshaya.com");
            console.log("Password: admin123");
        } else {
            console.log("Super Admin user already exists.");
        }

        process.exit(0);
    } catch (err) {
        console.error("Setup Error:", err);
        process.exit(1);
    }
}

setupDatabase();
