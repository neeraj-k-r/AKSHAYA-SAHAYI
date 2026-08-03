require('dotenv').config();
const cloudinary = require('cloudinary').v2;

console.log("☁️ Attempting to upload test_image.jpg to Cloudinary using ROOT key...");

// Cloudinary automatically detects the CLOUDINARY_URL from your .env file!
cloudinary.uploader.upload("test_image.jpg", { folder: "akshaya_docs" })
    .then(result => console.log("✅ SUCCESS! Image URL:", result.secure_url))
    .catch(err => console.error("❌ CLOUDINARY ERROR:", err.message));