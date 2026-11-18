// Tests statiques du frontend caisse (node scripts/test-frontend-cash.js)
// État B : UN bouton primaire + deux secondaires, carte avec ventilation,
// panneaux Ajuster / Réinitialiser. Vérifie aussi l'absence des anciens
// écrans et la présence des nouveaux éléments.
const fs = require("fs");
const path = require("path");

const pagePath = path.join(__dirname, "..", "..", "frontend", "src", "pages", "CashRegister.js");
const apiPath = path.join(__dirname, "..", "..", "frontend", "src", "api.js");
const amountPath = path.join(__dirname, "..", "..", "frontend", "src", "utils", "amount.js");
const page = fs.readFileSync(pagePath, "utf8");
const api = fs.readFileSync(apiPath, "utf8");
const amount = fs.existsSync(amountPath) ? fs.readFileSync(amountPath, "utf8") : "";

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log("  PASS", name); }
  else { failed++; console.log("  FAIL", name, detail); }
}

// --- Commun ---
check("titre 'Suivi de la caisse'", page.includes("Suivi de la caisse"));
check("aucun input datetime-local", !page.includes("datetime-local"));
check("aucun parseFloat", !page.includes("parseFloat("));
check("parseAmountDT importé depuis utils/amount", page.includes('from "../utils/amount"'));
check("utils/amount.js existe et exporte parseAmountDT", amount.includes("export function parseAmountDT"));

// --- État A : initialisation (inchangé) ---
check("phrase d'accueil état A", page.includes("Saisissez l&apos;argent présent dans la caisse en ce moment."));
check("label 'Montant dans la caisse (DT)'", page.includes("Montant dans la caisse (DT)"));
check("champ date readOnly + disabled + aria-readonly",
  page.includes("readOnly") && page.includes("disabled") && page.includes('aria-readonly="true"'));
check("bouton 'Initialiser la caisse'", page.includes("Initialiser la caisse"));
check("dialogue 'seront enregistrées automatiquement'", page.includes("seront enregistrées automatiquement"));
check("initialisation n'envoie QUE { amount }", page.includes("body: JSON.stringify({ amount: p.millimes })"));

// --- État B : structure ---
check("ligne 'Caisse initialisée le'", page.includes("Caisse initialisée le"));
check("UN bouton primaire 'Montant attendu'", page.includes(">Montant attendu<") || page.includes('"Montant attendu"'));
check("'Calcul en cours...'", page.includes("Calcul en cours..."));
check("deux boutons secondaires", page.includes("Ajuster la caisse") && page.includes("Réinitialiser la caisse"));
check("carte 'Montant attendu en caisse'", page.includes("Montant attendu en caisse"));
check("'Calculé le' (computedAt serveur)", page.includes("Calculé le"));
check("ventilation avec compteurs", page.includes("Ventes en espèces (") && page.includes("Remboursements de crédit ("));
check("lignes 'Argent ajouté' / 'Argent retiré' conditionnelles",
  page.includes("Argent ajouté") && page.includes("Argent retiré") && page.includes("moneyAdded !== 0") && page.includes("moneyRemoved !== 0"));
check("note ventes à crédit", page.includes("Les ventes à crédit ne sont pas comptées"));
check("pas de tableau", !page.includes("<table"));
check("pas de bouton 'Actualiser'", !page.includes(">Actualiser<"));

// --- Panneau Ajuster ---
check("toggle Ajouter/Retirer", page.includes("Ajouter de l'argent") && page.includes("Retirer de l'argent"));
check("direction ADD/REMOVE envoyée", page.includes('direction: adjDirection'));
check("endpoint /adjustments", page.includes("/cash-register/adjustments"));
check("confirmation ajout/retrait", page.includes("la caisse ?"));
check("motif facultatif + compteur", page.includes("Motif (facultatif)") && page.includes("/200"));
check("recalcul auto après ajustement si carte affichée", page.includes("if (result) handleCalculate()"));

// --- Panneau Réinitialiser ---
check("endpoint /reinitialize", page.includes("/cash-register/reinitialize"));
check("phrase 'Comptez l'argent'", page.includes("Comptez l&apos;argent dans la caisse"));
check("'Montant attendu actuellement'", page.includes("Montant attendu actuellement"));
check("écart en direct", page.includes("Écart :") && page.includes("ecartLabel"));
check("confirmation réinit avec écart", page.includes("L'écart sera enregistré"));
check("succès depuis valeurs serveur", page.includes("v.difference"));
check("note 'Un écart n'est pas une preuve'", page.includes("Un écart n&apos;est pas une preuve"));
check("fermeture panneau sans sauvegarde", page.includes("const closePanel = () => { setPanel(null); }"));

// --- SUPPRESSIONS (anciens écrans) ---
check("plus de formulaire retrait/dépôt", !page.includes("Enregistrer le retrait") && !page.includes("Enregistrer le dépôt"));
check("plus de flux vérification", !page.includes("Vérifier la caisse") && !page.includes("Montant compté"));
check("plus d'appel /withdrawals /deposits /verifications", !page.includes("/cash-register/withdrawals") && !page.includes("/cash-register/deposits") && !page.includes("/cash-register/verifications"));

// --- États loading / erreur ---
check("formulaire UNIQUEMENT si initialized:false", page.includes("notInitialized ? ("));
check("état d'erreur avec Réessayer", page.includes("Réessayer"));
check("erreur => expected null", page.includes("setExpected(null)"));

// --- api.js ---
check("api.js : message service indisponible", api.includes("Le service est indisponible, réessayez."));
check("api.js : plus de 'Erreur ${res.status}' brut", !api.includes("Erreur ${res.status}"));

console.log(`\n=== ${passed} PASS, ${failed} FAIL ===`);
process.exit(failed ? 1 : 0);
