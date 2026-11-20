// =====================================================================
// Stockage des photos de CIN — bucket Supabase Storage PRIVÉ.
//
// Données personnelles très sensibles (loi tunisienne / INPDP) :
//   - bucket privé uniquement (jamais d'URL publique) ;
//   - nom de fichier aléatoire (uuid), chemin `shop_id/uuid.ext` ;
//   - on ne stocke en base QUE le chemin ;
//   - l'accès (OWNER) passe par une URL signée à durée courte.
//
// Non configuré (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absents) :
// toute opération lève une erreur claire, jamais de fuite de secret.
// =====================================================================

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

let client = null;

function isConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function bucketName() {
  return process.env.SUPABASE_CIN_BUCKET || "cin-photos";
}

function getClient() {
  if (!isConfigured()) {
    throw new Error(
      "Supabase Storage non configuré (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)."
    );
  }
  if (!client) {
    client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  }
  return client;
}

// Détecte le type RÉEL de l'image via les magic bytes (pas l'extension).
// Retourne { ext, mime } ou null si non supporté.
function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  // JPEG : FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  // PNG : 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e &&
    buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a &&
    buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return { ext: "png", mime: "image/png" };
  }
  // WEBP : "RIFF" .... "WEBP"
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}

// Téléverse l'image et retourne le chemin (jamais d'URL).
async function uploadCin(shopId, buffer, mime) {
  const path = `${shopId}/${crypto.randomUUID()}.${mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg"}`;
  const { error } = await getClient()
    .storage.from(bucketName())
    .upload(path, buffer, { contentType: mime, upsert: false });
  if (error) throw error;
  return path;
}

// URL signée à durée courte (défaut 60 s).
async function createSignedCinUrl(path, expiresIn = 60) {
  const { data, error } = await getClient()
    .storage.from(bucketName())
    .createSignedUrl(path, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

async function removeCin(path) {
  const { error } = await getClient().storage.from(bucketName()).remove([path]);
  if (error) throw error;
}

module.exports = {
  isConfigured,
  bucketName,
  detectImageType,
  uploadCin,
  createSignedCinUrl,
  removeCin,
};
