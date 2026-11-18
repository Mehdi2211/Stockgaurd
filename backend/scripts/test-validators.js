// Tests unitaires des validateurs caisse (node scripts/test-validators.js)
const assert = require("assert");
const v = require("../src/validators/cashRegister");

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("  PASS", name); }
  catch (e) { failed++; console.log("  FAIL", name, "-", e.message); }
}

// --- validateAmount ---
t("amount: entier valide", () => assert.strictEqual(v.validateAmount(1000), 1000));
t("amount: zéro refusé par défaut", () => assert.strictEqual(v.validateAmount(0), null));
t("amount: zéro accepté avec allowZero", () => assert.strictEqual(v.validateAmount(0, { allowZero: true }), 0));
t("amount: min", () => {
  assert.strictEqual(v.validateAmount(0, { min: 1 }), null);
  assert.strictEqual(v.validateAmount(1, { min: 1 }), 1);
});
t("amount: flottant refusé", () => assert.strictEqual(v.validateAmount(1.5), null));
t("amount: NaN refusé", () => assert.strictEqual(v.validateAmount(NaN), null));
t("amount: chaîne refusée", () => assert.strictEqual(v.validateAmount("1000"), null));
t("amount: booléen refusé", () => assert.strictEqual(v.validateAmount(true), null));
t("amount: null refusé", () => assert.strictEqual(v.validateAmount(null), null));
t("amount: borne max", () => {
  assert.strictEqual(v.validateAmount(9999999999), 9999999999);
  assert.strictEqual(v.validateAmount(10000000000), null);
  assert.strictEqual(v.validateAmount(-10000000000), null);
});

// --- validateDescription ---
t("desc: valide", () => assert.strictEqual(v.validateDescription("Paiement fournisseur"), "Paiement fournisseur"));
t("desc: trim", () => assert.strictEqual(v.validateDescription("  ok motif  "), "ok motif"));
t("desc: trop court (< 3)", () => {
  assert.strictEqual(v.validateDescription("ab"), null);
  assert.strictEqual(v.validateDescription("   "), null);
});
t("desc: trop long (> 200)", () => {
  assert.strictEqual(v.validateDescription("a".repeat(201)), null);
  assert.strictEqual(v.validateDescription("a".repeat(200)), "a".repeat(200));
});
t("desc: caractères de contrôle rejetés", () => {
  assert.strictEqual(v.validateDescription("motif\navec retour"), null);
  assert.strictEqual(v.validateDescription("motif\tavec tab"), null);
  assert.strictEqual(v.validateDescription("motifcloche"), null);
});
t("desc: au moins une lettre ou un chiffre", () => {
  assert.strictEqual(v.validateDescription("!!! ???"), null);
  assert.strictEqual(v.validateDescription("---"), null);
  assert.strictEqual(v.validateDescription("123"), "123");
  assert.strictEqual(v.validateDescription("abc"), "abc");
});
t("desc: non-chaîne rejetée", () => {
  assert.strictEqual(v.validateDescription(123), null);
  assert.strictEqual(v.validateDescription(null), null);
  assert.strictEqual(v.validateDescription(undefined), null);
});

// --- parseInitializedAt / validateInitializedAt ---
t("date: ISO valide", () => {
  const d = v.parseInitializedAt(new Date().toISOString());
  assert.ok(d instanceof Date && !Number.isNaN(d.getTime()));
});
t("date: invalide -> null", () => {
  assert.strictEqual(v.parseInitializedAt("pas-une-date"), null);
  assert.strictEqual(v.parseInitializedAt(""), null);
  assert.strictEqual(v.parseInitializedAt(null), null);
});
t("date: future -> erreur", () => {
  const future = new Date(Date.now() + 10 * 60 * 1000);
  assert.ok(v.validateInitializedAt(future) !== null);
});
t("date: hier -> erreur (jour calendaire Tunis)", () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  assert.ok(v.validateInitializedAt(yesterday) !== null);
});
t("date: maintenant -> valide", () => {
  assert.strictEqual(v.validateInitializedAt(new Date()), null);
});

console.log(`\n=== ${passed} PASS, ${failed} FAIL ===`);
process.exit(failed ? 1 : 0);
