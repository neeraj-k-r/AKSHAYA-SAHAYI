require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Validate environment variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ Error: Missing SUPABASE_URL or Supabase API Key in your .env file.");
    process.exit(1);
}

if (!process.env.GEMINI_API_KEY) {
    console.error("❌ Error: Missing GEMINI_API_KEY in your .env file.");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Google's embedding model
const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-2" });

// Global Akshaya Guidelines & Rules
const rulesToSeed = [
    {
        document_type: "Income Certificate",
        content: "Income Certificate requirements: Document must display the applicant's full name, village officer signature, official round seal/stamp, annual income amount, and must be issued within the last 1 year."
    },
    {
        document_type: "Ration Card",
        content: "Ration Card requirements: Must show the family head's name, page with applicant name listed as member, and official Civil Supplies seal. Old damaged or unreadable cards are rejected."
    },
    {
        document_type: "Aadhaar Card",
        content: "Aadhaar Card requirements: Clear, unblurred photo showing 12-digit identification number, name, DOB, address, and QR code. Masked version is allowed as long as the last 4 digits are visible."
    },
    {
        document_type: "Caste Certificate",
        content: "Caste Certificate requirements: Document must show applicant's name, certified caste category, issuing authority signature, and official government seal."
    }
];

async function seedRules() {
    console.log("🌱 Seeding Global Akshaya Rules into Supabase Vector DB...");

    for (const rule of rulesToSeed) {
        try {
            console.log(`⏳ Generating vector embedding for [${rule.document_type}]...`);

            // 1. Generate 768-dim vector embedding via Gemini
            const result = await embeddingModel.embedContent(rule.content);
            const embedding = result.embedding.values;

            // 2. Save into document_rules table globally (without center_id)
            const { error } = await supabase.from('document_rules').insert({
                document_type: rule.document_type,
                content: rule.content,
                embedding: embedding
            });

            if (error) {
                console.error(`❌ Error inserting ${rule.document_type}:`, error.message);
            } else {
                console.log(`✅ Successfully embedded and saved rule for: ${rule.document_type}`);
            }
        } catch (err) {
            console.error(`❌ Embedding failed for ${rule.document_type}:`, err.message || err);
        }
    }

    console.log("🎉 Seeding Complete!");
}

seedRules();