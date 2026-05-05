
import * as dotenv from "dotenv";
import * as path from "path";
import * as https from "https";

dotenv.config({ path: path.join(__dirname, "../.env") });

async function debugKey() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("No API key found in .env");
        return;
    }

    console.log(`Testing API Key: ${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`);
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

    https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
            const result = JSON.parse(data);
            if (res.statusCode === 200) {
                console.log("\x1b[1;32m[SUCCESS] API Key is VALID!\x1b[0m");
                console.log("Available Models:");
                result.models.forEach((m: any) => {
                    console.log(` - ${m.name.split('/').pop()}`);
                });
            } else {
                console.error("\x1b[1;31m[FAILED] API Key Check Failed!\x1b[0m");
                console.error(`Status: ${res.statusCode} ${res.statusMessage}`);
                console.error("Error Data:", JSON.stringify(result, null, 2));
            }
        });
    }).on('error', (err) => {
        console.error("Connection error:", err.message);
    });
}

debugKey();
