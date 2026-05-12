/**
 * Frontend image compression for Telegram Mini App.
 *
 * Targets:
 *   1. Max side length: 4096px (keeps identity/detail for AI)
 *   2. Target file size: < 10MB before compression (safely under R2/Cloud Run 20-32MB limits)
 *   3. Format: image/jpeg
 */

export async function compressImage(file: File): Promise<File> {
  // If file is already small (< 10MB), skip compression to preserve facial detail
  if (file.size < 10 * 1024 * 1024) {
    return file;
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const MAX_WIDTH = 4096;
        const MAX_HEIGHT = 4096;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Failed to get canvas context"));
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);

        // Quality 0.95 preserves facial micro-detail for AI identity preservation
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error("Canvas toBlob failed"));
              return;
            }
            const compressedFile = new File([blob], file.name, {
              type: "image/jpeg",
              lastModified: Date.now(),
            });
            console.log(`[Compression] ${file.name}: ${file.size} -> ${compressedFile.size}`);
            resolve(compressedFile);
          },
          "image/jpeg",
          0.95
        );
      };
      img.onerror = (err) => reject(err);
    };
    reader.onerror = (err) => reject(err);
  });
}
