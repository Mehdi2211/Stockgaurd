// =====================================================================
// Traitement des images côté client (photo de CIN).
//
// - validateImageFile : contrôle AVANT envoi (type + taille) pour un
//   retour immédiat à l'utilisateur.
// - compressImage : redimensionne (max ~1600 px de large) et recompresse
//   en JPEG qualité 0.8 pour limiter le poids de l'envoi. En cas d'échec
//   (navigateur ancien, format exotique), on renvoie le fichier d'origine :
//   la validation définitive reste côté serveur (magic bytes).
// =====================================================================

export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 Mo

export function validateImageFile(file) {
  if (!file) return "Photo requise.";
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    return "Format non supporté (JPEG, PNG ou WEBP).";
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return "Photo trop volumineuse (5 Mo maximum).";
  }
  return null;
}

export function compressImage(file, { maxWidth = 1600, quality = 0.8 } = {}) {
  return new Promise((resolve) => {
    if (!file || !file.type || !file.type.startsWith("image/")) {
      resolve(file);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxWidth / img.width);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(url);
            if (!blob) {
              resolve(file);
              return;
            }
            resolve(new File([blob], file.name || "cin.jpg", {
              type: "image/jpeg",
              lastModified: Date.now(),
            }));
          },
          "image/jpeg",
          quality
        );
      } catch {
        URL.revokeObjectURL(url);
        resolve(file);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file);
    };
    img.src = url;
  });
}
