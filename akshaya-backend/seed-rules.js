require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Google's 768-dimension embedding model
const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-2" });

// Sample Akshaya Guidelines & Rules
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
        content: "Aadhaar Card requirements: Clear, unblurred photo showing 12-digit Aadhaar number, name, DOB, address, and QR code. Masked Aadhaar is allowed as long as the last 4 digits are visible."
    }
];

async function seedRules() {
    console.log("🌱 Seeding Akshaya Rules into Supabase Vector DB...");

    for (const rule of rulesToSeed) {
        try {
            // 1. Generate 768-dim vector embedding
            const result = await embeddingModel.embedContent(rule.content);
            const embedding = result.embedding.values;

            // 2. Save into document_rules table
            const { error } = await supabase.from('document_rules').insert({
                document_type: rule.document_type,
                content: rule.content,
                embedding: embedding
            });

            if (error) {
                console.error(`❌ Error inserting ${rule.document_type}:`, error.message);
            } else {
                console.log(`✅ Successfully embedded rule for: ${rule.document_type}`);
            }
        } catch (err) {
            console.error(`❌ Embedding failed for ${rule.document_type}:`, err);
        }
    }

    console.log("🎉 Seeding Complete!");
}

seedRules();