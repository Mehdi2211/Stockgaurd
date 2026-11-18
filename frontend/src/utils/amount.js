// =====================================================================
// Parsing des montants DT -> millimes, SANS flottant.
// Règles : texte libre, un seul séparateur "." ou ",", chiffres ASCII,
// max 3 décimales, max 9 999 999,999 DT (7 chiffres avant la virgule).
// 0 est autorisé (les appelants qui exigent > 0 le vérifient eux-mêmes).
// Retourne { millimes } ou { error } (message français).
// =====================================================================

const AMOUNT_RE = /^\d{1,7}(?:[.,]\d{1,3})?$/;
export const MAX_MILLIMES = 9999999999; // 9 999 999,999 DT

export function parseAmountDT(raw) {
  const s = (raw || "").trim();
  if (s === "") return { error: "Montant requis." };
  if (!AMOUNT_RE.test(s)) {
    const dec = s.split(/[.,]/)[1];
    if (dec && dec.length > 3) return { error: "3 décimales maximum." };
    const intPart = s.split(/[.,]/)[0];
    if (/^\d+$/.test(intPart) && intPart.length > 7) return { error: "Montant trop élevé." };
    return { error: "Montant invalide (chiffres uniquement, un séparateur . ou ,)." };
  }
  // Conversion entière : pas de parseFloat.
  const [intPart, fracPart = ""] = s.replace(",", ".").split(".");
  const frac = fracPart.padEnd(3, "0");
  const millimes = Number(intPart) * 1000 + Number(frac);
  if (!Number.isSafeInteger(millimes) || millimes > MAX_MILLIMES) {
    return { error: "Montant trop élevé." };
  }
  return { millimes };
}
