// =====================================================================
// Conversion DT <-> millimes SANS flottant.
//
// Règle : les montants sont des entiers en millimes (1 DT = 1000).
// Le parsing se fait sur la CHAÎNE (regex + BigInt), jamais via
// parseFloat/Number sur une valeur décimale : pas d'erreur d'arrondi.
// =====================================================================

// "123", "123.4", "123.45", "123.456", "-5" (si allowNegative),
// virgule acceptée comme séparateur décimal. Maximum 3 décimales.
const DT_RE = /^(-?)(\d+)(?:[.,](\d{1,3}))?$/;

// Convertit une saisie utilisateur (DT) en millimes (entier).
// Retourne null si la saisie est invalide.
//   dtToMillimes("200")      -> 200000
//   dtToMillimes("0.001")    -> 1
//   dtToMillimes("12,5")     -> 12500
//   dtToMillimes("-5", { allowNegative: true }) -> -5000
export function dtToMillimes(value, { allowNegative = false } = {}) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const s = String(value).trim();
  if (s === "") return null;
  const m = DT_RE.exec(s);
  if (!m) return null;

  const negative = m[1] === "-";
  const intPart = m[2];
  const frac = (m[3] || "").padEnd(3, "0"); // "5" -> "500", "05" -> "050"

  const intNum = Number(intPart);
  const fracNum = Number(frac);
  if (!Number.isSafeInteger(intNum) || !Number.isSafeInteger(fracNum)) return null;

  let millimes = intNum * 1000 + fracNum;
  if (!Number.isSafeInteger(millimes)) return null;
  if (negative) millimes = -millimes;
  if (!allowNegative && millimes < 0) return null;
  return millimes;
}

// Formate des millimes (entier) en "123,456 DT" (fr-TN, 3 décimales).
// Formatage manuel (division entière) : jamais de flottant.
export function formatMillimes(m) {
  const n = Number(m);
  if (!Number.isSafeInteger(n)) return "—";
  const neg = n < 0;
  const abs = Math.abs(n);
  const intPart = Math.floor(abs / 1000);
  const frac = String(abs % 1000).padStart(3, "0");
  return `${neg ? "-" : ""}${intPart.toLocaleString("fr-TN")},${frac} DT`;
}
