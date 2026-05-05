
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../.env") });

async function listModels() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("No API key found in .env");
        return;
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    try {
        // There is no native listModels in the SDK for some versions, 
        // but we can try to hit the endpoint manually or use the SDK if available.
        // In @google/generative-ai ^0.24.1, you can't easily list models without a fetch.
        
        console.log("Attempting to call gemini-1.5-flash with a tiny prompt...");
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent("Hi");
        console.log("Success! Response:", result.response.text());
    } catch (err: any) {
        console.error("Failed with gemini-1.5-flash:", err.message);
        
        console.log("\nAttempting gemini-1.5-pro...");
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
            const result = await model.generateContent("Hi");
            console.log("Success with gemini-1.5-pro!");
        } catch (err2: any) {
            console.error("Failed with gemini-1.5-pro:", err2.message);
        }

        console.log("\nAttempting gemini-pro...");
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-pro" });
            const result = await model.generateContent("Hi");
            console.log("Success with gemini-pro!");
        } catch (err3: any) {
            console.error("Failed with gemini-pro:", err3.message);
        }
    }
}

listModels();
