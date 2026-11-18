// =====================================================================
// Validateurs du module caisse — règles strictes, partagées par les routes.
// =====================================================================

// Montant maximal en millimes (10 000 000 DT) — aligné sur les CHECKs SQL.
const MAX_AMOUNT = 9999999999;

// Montant en millimes : entier strict (rejette NaN, flottants, chaînes,
// booléens, null). Bornes optionnelles min/max, allowZero.
function validateAmount(value, { min = null, max = null, allowZero = false } = {}) {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (min !== null && value < min) return null;
  if (max !== null && value > max) return null;
  if (!allowZero && value === 0 && min === null) return null;
  if (Math.abs(value) > MAX_AMOUNT) return null;
  return value;
}

// Description : 3 à 200 caractères après trim, au moins une lettre ou un
// chiffre, aucun caractère de contrôle. Retourne la chaîne trimée ou null.
function validateDescription(value) {
  if (typeof value !== "string") return null;
  const d = value.trim();
  if (d.length < 3 || d.length > 200) return null;
  // Caractères de contrôle (C0, DEL, C1) rejetés.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F-\x9F]/.test(d)) return null;
  // Au moins une lettre ou un chiffre.
  if (!/[\p{L}\p{N}]/u.test(d)) return null;
  return d;
}

// Motif d'ajustement : OPTIONNEL.
// - undefined / null / "" / espaces seuls -> undefined (le routeur pose
//   le défaut "Ajustement sans motif").
// - chaîne fournie : trim, 3-200 caractères, au moins une lettre ou un
//   chiffre (rejette "!!!", "..."), aucun caractère de contrôle.
// Retourne la chaîne trimée, undefined (absent) ou null (invalide).
function validateReason(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const r = value.trim();
  if (r === "") return undefined;
  if (r.length < 3 || r.length > 200) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F-\x9F]/.test(r)) return null;
  if (!/[\p{L}\p{N}]/u.test(r)) return null;
  return r;
}

// Date d'initialisation : ISO string ou timestamp (ms) -> Date ou null.
function parseInitializedAt(value) {
  if (value === undefined || value === null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// Jour calendaire "YYYY-MM-DD" à Tunis pour une Date donnée.
function tunisDayStr(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Tunis",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Valide la date d'initialisation : pas dans le futur (tolérance 1 minute),
// même jour calendaire qu'aujourd'hui à Tunis. Retourne un message d'erreur
// ou null si valide.
function validateInitializedAt(date) {
  const now = Date.now();
  if (date.getTime() > now + 60 * 1000) {
    return "La date d'initialisation ne peut pas être dans le futur.";
  }
  if (tunisDayStr(date) !== tunisDayStr(new Date(now))) {
    return "La date d'initialisation doit être aujourd'hui (jour calendaire, heure de Tunis).";
  }
  return null;
}

module.exports = {
  validateAmount,
  validateDescription,
  validateReason,
  parseInitializedAt,
  validateInitializedAt,
  MAX_AMOUNT,
};
