
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../.env") });

async function diagnose() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("\x1b[1;31m[ERROR] No GEMINI_API_KEY found in .env\x1b[0m");
        return;
    }

    console.log(`\x1b[1;34m[DIAGNOSTIC] Testing API Key starting with: ${apiKey.slice(0, 5)}...\x1b[0m`);
    
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // Testing common model names
    const modelsToTest = ["gemini-1.5-flash", "gemini-1.5-flash-latest", "gemini-1.5-pro", "gemini-pro"];
    
    for (const modelName of modelsToTest) {
        try {
            console.log(`\n\x1b[1;33m[TESTING] Model: ${modelName}...\x1b[0m`);
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent("echo 'OK'");
            const response = await result.response;
            console.log(`\x1b[1;32m[SUCCESS] ${modelName} is working! Response: ${response.text().trim()}\x1b[0m`);
            return; // Stop if we find one that works
        } catch (err: any) {
            console.error(`\x1b[31m[FAILED] ${modelName}: ${err.message}\x1b[0m`);
            if (err.message.includes("404")) {
                console.log(`\x1b[33m  Tip: 404 usually means the "Generative Language API" is not enabled for this key in Google Cloud Console, or the model name is restricted.\x1b[0m`);
            }
        }
    }

    console.log(`\n\x1b[1;31m[FINAL VERDICT] None of the standard models are working with your key.\x1b[0m`);
    console.log(`\x1b[1;31mPlease visit https://aistudio.google.com/apikey and create a NEW key.\x1b[0m`);
}

diagnose();
