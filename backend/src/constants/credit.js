// =====================================================================
// Constantes métier du crédit (millimes, 1 DT = 1000 millimes).
//
// CREDIT_LIMIT : plafond de crédit en DT (défaut 100). Le solde dû d'un
// créditeur ne peut JAMAIS le dépasser. La vérification est faite côté
// serveur (transaction + verrou), jamais uniquement côté frontend.
//
// CIN_AUTO_DELETE_ON_ZERO_BALANCE : si true, la photo de CIN est
// supprimée automatiquement quand le solde d'un créditeur retombe à 0.
// =====================================================================

function creditLimitMillimes() {
  const dt = Number(process.env.CREDIT_LIMIT);
  const value = Number.isFinite(dt) && dt > 0 ? dt : 100;
  return Math.round(value * 1000);
}

function cinAutoDeleteOnZeroBalance() {
  return String(process.env.CIN_AUTO_DELETE_ON_ZERO_BALANCE || "false").toLowerCase() === "true";
}

module.exports = { creditLimitMillimes, cinAutoDeleteOnZeroBalance };
