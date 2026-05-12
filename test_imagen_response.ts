import { aiProvider } from './src/server/ai.ts';

async function run() {
    try {
        console.log("Testing PREMIUM Imagen 3");
        // Dummy valid base64 image (tiny PNG)
        const dummyBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        const refs = [{ base64: dummyBase64, mimeType: "image/png" }];
        
        const profile = {
            gender: "male",
            ageTier: "young",
            skinTone: "light",
            hairColor: "brown",
            hairLength: "short",
            eyeColor: "brown",
            facialHair: "none",
            distinguishingFeatures: "none"
        };

        const result = await aiProvider.generatePremiumTier(
            refs, 
            "A man in a business suit",
            profile,
            "business",
            0,
            "test_gen_id"
        );
        
        console.log("SUCCESS length:", result.length);
        if (result === dummyBase64) {
            console.log("ECHO DETECTED! Result is exactly dummyBase64");
        }
    } catch (e) {
        console.error("Error:", e);
    }
}
run();
