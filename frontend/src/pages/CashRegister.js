import React, { useState, useEffect, useCallback } from "react";
import AppShell from "../components/AppShell";
import { useKiosk } from "../context/KioskContext";
import { apiFetch, getTokenRole } from "../api";
import { formatMillimes } from "../utils/money";
import { parseAmountDT } from "../utils/amount";

// =====================================================================
// Suivi de caisse — UNE seule chose : le montant attendu en caisse.
// État A : initialisation. État B : un bouton "Montant attendu" + deux
// actions secondaires (ajuster / réinitialiser). Rien d'autre.
// =====================================================================

// Heure actuelle à Tunis, "JJ/MM/AAAA HH:MM:SS" (horloge indicative).
function tunisNowString() {
  return new Date().toLocaleString("fr-TN", {
    timeZone: "Africa/Tunis",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
}

// Date serveur -> "JJ/MM/AAAA à HH:MM" (Africa/Tunis).
function tunisDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-TN", {
    timeZone: "Africa/Tunis",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
  }).replace(", ", " à ");
}

// ---------------------------------------------------------------------
// Validation du montant : parseAmountDT (utils/amount.js) — SANS
// flottant, regex ^\d{1,7}([.,]\d{1,3})?$, max 3 décimales, max
// 9 999 999,999 DT. 0 autorisé (rejeté par les appelants qui exigent > 0).
// ---------------------------------------------------------------------

// Motif d'ajustement : facultatif ; si fourni, 3-200 caractères avec au
// moins une lettre ou un chiffre (miroir du backend, qui fait foi).
function validReason(s) {
  const t = (s || "").trim();
  if (t === "") return true; // facultatif
  return t.length >= 3 && t.length <= 200 && /[\p{L}\p{N}]/u.test(t);
}

// Écart en millimes -> libellé français.
function ecartLabel(diff) {
  if (diff === 0) return "aucun écart";
  const abs = formatMillimes(Math.abs(diff));
  return diff < 0 ? `manque de ${abs} DT` : `excédent de ${abs} DT`;
}

export default function CashRegister() {
  const { role } = useKiosk();

  // États explicites : loading | error | ready.
  const [expected, setExpected]   = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error,   setError]       = useState("");
  const [formError, setFormError] = useState("");
  const [pending, setPending]     = useState(false);

  const [nowStr, setNowStr] = useState(tunisNowString);

  // État A : montant initial
  const [initAmount, setInitAmount] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);

  // État B : résultat du calcul (un clic = un calcul)
  const [result, setResult] = useState(null);
  const [repayDetails, setRepayDetails] = useState([]);
  const [calcError, setCalcError] = useState("");
  const [calculating, setCalculating] = useState(false);

  // Panneaux secondaires : un seul à la fois, rien de sauvegardé à la fermeture.
  const [panel, setPanel] = useState(null); // null | "adjust" | "reinit"

  // Panneau "Ajuster la caisse"
  const [adjDirection, setAdjDirection] = useState("ADD"); // "ADD" | "REMOVE"
  const [adjAmount, setAdjAmount] = useState("");
  const [adjReason, setAdjReason] = useState("");
  const [adjTouched, setAdjTouched] = useState(false);
  const [adjError, setAdjError] = useState("");
  const [adjPending, setAdjPending] = useState(false);
  const [adjSuccess, setAdjSuccess] = useState("");

  // Panneau "Réinitialiser la caisse"
  const [reAmount, setReAmount] = useState("");
  const [reTouched, setReTouched] = useState(false);
  const [reError, setReError] = useState("");
  const [rePending, setRePending] = useState(false);
  const [reSuccess, setReSuccess] = useState("");
  const [reExpected, setReExpected] = useState(null); // /expected chargé à l'ouverture
  const [reLoading, setReLoading] = useState(false);

  // Statut initial : GET /expected (détermine l'état A ou B).
  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/cash-register/expected");
      setExpected(data);
    } catch (err) {
      setExpected(null);
      if (err.status === 401) setError("Authentification requise. Veuillez vous reconnecter.");
      else if (err.status === 403) setError("Accès réservé au propriétaire.");
      else setError(err.message || "Le service est indisponible, réessayez.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  useEffect(() => {
    const id = setInterval(() => setNowStr(tunisNowString()), 1000);
    return () => clearInterval(id);
  }, []);

  // --- État A : validation montant initial ---
  const parsed = parseAmountDT(initAmount);
  const amountValid = parsed.millimes !== undefined;
  const showAmountError = amountTouched && initAmount.trim() !== "" && !amountValid
    ? (parsed.error || "Montant invalide.")
    : "";

  const handleAmountBlur = () => {
    setAmountTouched(true);
  };

  const handleAmountChange = (e) => {
    setInitAmount(e.target.value);
    setFormError("");
  };

  const handleInitialize = async (e) => {
    e.preventDefault();
    setFormError("");
    setAmountTouched(true);
    const p = parseAmountDT(initAmount);
    if (p.error) {
      return;
    }
    const ok = window.confirm(
      `Initialiser la caisse à ${formatMillimes(p.millimes)} DT ? ` +
      `La date et l'heure seront enregistrées automatiquement. ` +
      `Cette action est définitive.`
    );
    if (!ok) return;

    setPending(true);
    try {
      await apiFetch("/cash-register/initialize", {
        method: "POST",
        body: JSON.stringify({ amount: p.millimes }),
      });
      await loadStatus();
    } catch (err) {
      setFormError(err.message || "Le service est indisponible, réessayez.");
    } finally {
      setPending(false);
    }
  };

  // --- État B : calcul du montant attendu (un clic = un calcul) ---
  const handleCalculate = async () => {
    setCalcError("");
    setCalculating(true);
    try {
      const data = await apiFetch("/cash-register/expected");
      if (!data.initialized) {
        setExpected(data);
        setResult(null);
        setRepayDetails([]);
        return;
      }
      setExpected(data);
      setResult(data);
      // Détail des remboursements par créditeur (rapport).
      // Même période que le total : depuis la date d'initialisation.
      if (data.repaymentsCount > 0) {
        try {
          const rep = await apiFetch(
            `/cash-register/repayments?from=${encodeURIComponent(data.initializedAt)}`
          );
          setRepayDetails(rep.repayments || []);
        } catch {
          setRepayDetails([]);
        }
      } else {
        setRepayDetails([]);
      }
    } catch (err) {
      setCalcError(err.message || "Le service est indisponible, réessayez.");
    } finally {
      setCalculating(false);
    }
  };

  // --- Panneau "Ajuster la caisse" ---
  const openAdjust = () => {
    setPanel("adjust");
    setAdjError("");
    setAdjSuccess("");
    setAdjTouched(false);
  };

  const adjParsed = parseAmountDT(adjAmount);
  const adjAmountValid = adjParsed.millimes !== undefined && adjParsed.millimes > 0;
  const adjReasonValid = validReason(adjReason);
  const adjValid = adjAmountValid && adjReasonValid;
  const adjShowError = adjTouched && adjAmount.trim() !== "" && !adjAmountValid
    ? (adjParsed.error || "Le montant doit être supérieur à 0.")
    : "";

  const handleAdjust = async (e) => {
    e.preventDefault();
    setAdjError("");
    setAdjTouched(true);
    const p = parseAmountDT(adjAmount);
    if (p.error || p.millimes === 0) {
      setAdjError(p.error || "Le montant doit être supérieur à 0.");
      return;
    }
    if (!validReason(adjReason)) {
      setAdjError("Motif invalide (3-200 caractères, au moins une lettre ou un chiffre).");
      return;
    }
    const verb = adjDirection === "ADD" ? "Ajouter" : "Retirer";
    const ok = window.confirm(
      `${verb} ${formatMillimes(p.millimes)} DT ${adjDirection === "ADD" ? "à" : "de"} la caisse ?`
    );
    if (!ok) return;

    setAdjPending(true);
    try {
      await apiFetch("/cash-register/adjustments", {
        method: "POST",
        body: JSON.stringify({
          amount: p.millimes,
          direction: adjDirection,
          reason: adjReason.trim() || undefined,
        }),
      });
      setAdjSuccess(
        `${verb} ${formatMillimes(p.millimes)} DT ${adjDirection === "ADD" ? "ajouté à" : "retiré de"} la caisse.`
      );
      setAdjAmount("");
      setAdjReason("");
      setAdjTouched(false);
      // Recalculer la carte résultat si elle est affichée.
      if (result) handleCalculate();
    } catch (err) {
      setAdjError(err.message || "Le service est indisponible, réessayez.");
    } finally {
      setAdjPending(false);
    }
  };

  // --- Panneau "Réinitialiser la caisse" ---
  const openReinit = async () => {
    setPanel("reinit");
    setReError("");
    setReSuccess("");
    setReTouched(false);
    setReAmount("");
    setReExpected(null);
    setReLoading(true);
    try {
      const data = await apiFetch("/cash-register/expected");
      setReExpected(data.initialized ? data : null);
    } catch (err) {
      setReError(err.message || "Le service est indisponible, réessayez.");
    } finally {
      setReLoading(false);
    }
  };

  const reParsed = parseAmountDT(reAmount);
  const reAmountValid = reParsed.millimes !== undefined; // 0 autorisé
  const reDiff = reAmountValid && reExpected ? reParsed.millimes - reExpected.expectedAmount : null;

  const handleReinitialize = async (e) => {
    e.preventDefault();
    setReError("");
    setReTouched(true);
    const p = parseAmountDT(reAmount);
    if (p.error) {
      setReError(p.error);
      return;
    }
    const theoretical = reExpected?.expectedAmount ?? 0;
    const diff = p.millimes - theoretical;
    const ok = window.confirm(
      `Réinitialiser la caisse à ${formatMillimes(p.millimes)} DT ? ` +
      `Montant attendu : ${formatMillimes(theoretical)} DT. ` +
      `Écart : ${ecartLabel(diff)}. ` +
      `L'écart sera enregistré. Cette action est définitive.`
    );
    if (!ok) return;

    setRePending(true);
    try {
      const data = await apiFetch("/cash-register/reinitialize", {
        method: "POST",
        body: JSON.stringify({ amount: p.millimes }),
      });
      // Message depuis les valeurs RENVOYÉES par le serveur.
      const v = data.verification;
      setReSuccess(
        `Caisse réinitialisée. Écart enregistré : ${ecartLabel(v.difference)}.`
      );
      setReAmount("");
      setReTouched(false);
      setResult(null); // effacer la carte résultat
      setRepayDetails([]);
      await loadStatus(); // mettre à jour la ligne 1 (nouvelle init)
    } catch (err) {
      setReError(err.message || "Le service est indisponible, réessayez.");
    } finally {
      setRePending(false);
    }
  };

  const closePanel = () => { setPanel(null); };

  // --- Garde OWNER ---
  const isOwner = role === "OWNER" || getTokenRole() === "OWNER";
  if (!isOwner) {
    return (
      <AppShell>
        <div className="owner-page">
          <h1 className="page-title">Suivi de la caisse</h1>
          <div className="panel">
            <p className="error-msg" role="alert">
              Accès refusé (403) — ce module est réservé au propriétaire.
            </p>
            <p className="hint">
              Depuis la caisse, ouvrez « 🔐 Administration » et saisissez le
              PIN propriétaire pour accéder à ce module.
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  const initialized = expected?.initialized === true;
  const notInitialized = expected?.initialized === false;

  return (
    <AppShell>
      <div className="owner-page">
        <div className="page-header">
          <h1 className="page-title">Suivi de la caisse</h1>
        </div>

        {formError && <p className="error-msg" role="alert">{formError}</p>}

        {loading && !expected ? (
          <div className="panel"><p className="empty-state">Chargement…</p></div>
        ) : error ? (
          <div className="panel">
            <p className="error-msg" role="alert">{error}</p>
            <button className="btn-primary" onClick={loadStatus} style={{ maxWidth: 200 }}>
              Réessayer
            </button>
          </div>
        ) : notInitialized ? (
          /* ===== État A : caisse non initialisée ===== */
          <div className="panel">
            <p style={{ marginTop: 0 }}>
              Saisissez l&apos;argent présent dans la caisse en ce moment.
            </p>
            <form onSubmit={handleInitialize} noValidate>
              <div className="field" style={{ maxWidth: 320 }}>
                <label className="sg-label" htmlFor="initAmount">Montant dans la caisse (DT)</label>
                <input
                  id="initAmount"
                  className="sg-input"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="Ex. 200"
                  value={initAmount}
                  onChange={handleAmountChange}
                  onBlur={handleAmountBlur}
                  aria-invalid={showAmountError ? "true" : "false"}
                  aria-describedby="initAmount-error initAmount-hint"
                  required
                />
                {showAmountError && (
                  <p className="error-msg" id="initAmount-error" role="alert" style={{ marginTop: 4 }}>
                    {showAmountError}
                  </p>
                )}
                <p className="hint" id="initAmount-hint">
                  0 à 9 999 999,999 DT, 3 décimales maximum.
                </p>
              </div>

              <div className="field" style={{ maxWidth: 320 }}>
                <span className="sg-label">Date et heure : automatique</span>
                <input
                  className="sg-input"
                  type="text"
                  value={nowStr}
                  readOnly
                  disabled
                  aria-readonly="true"
                  aria-label="Date et heure (automatique)"
                  style={{ background: "var(--soft, #f1f5f4)", color: "#64748b", cursor: "not-allowed" }}
                />
              </div>

              <button
                className="btn-primary"
                type="submit"
                disabled={!amountValid || pending}
                style={{ maxWidth: 260 }}
              >
                {pending ? "Initialisation…" : "Initialiser la caisse"}
              </button>
            </form>
          </div>
        ) : initialized ? (
          /* ===== État B : caisse initialisée ===== */
          <>
            {/* 1. Ligne d'initialisation (lecture seule) */}
            <div className="panel mb-2">
              <p className="hint" style={{ margin: 0 }}>
                Caisse initialisée le {tunisDateTime(expected.initializedAt)}{" "}
                avec {formatMillimes(expected.initialAmount)}.
              </p>
            </div>

            {/* 2. UN grand bouton primaire */}
            <div className="panel mb-2" style={{ textAlign: "center" }}>
              <button
                className="btn-primary"
                onClick={handleCalculate}
                disabled={calculating}
                style={{ fontSize: "1.1rem", padding: "14px 32px", maxWidth: 320 }}
              >
                {calculating ? "Calcul en cours..." : "Montant attendu"}
              </button>

              {/* 3. Deux boutons secondaires */}
              <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 12, flexWrap: "wrap" }}>
                <button className="btn-ghost" onClick={openAdjust} disabled={!!panel}>
                  Ajuster la caisse
                </button>
                <button className="btn-ghost" onClick={openReinit} disabled={!!panel || reLoading}>
                  Réinitialiser la caisse
                </button>
              </div>

              {calcError && (
                <div style={{ marginTop: 12 }}>
                  <p className="error-msg" role="alert">{calcError}</p>
                  <button className="btn-ghost" onClick={handleCalculate}>
                    Réessayer
                  </button>
                </div>
              )}

              {/* Carte résultat : ventilation qui somme au total */}
              {result && !calcError && (
                <div className="panel mt-2" style={{ textAlign: "left", background: "var(--soft)" }}>
                  <p style={{ fontSize: "1.6rem", fontWeight: 800, margin: "0 0 4px" }}>
                    Montant attendu en caisse : {formatMillimes(result.expectedAmount)}
                  </p>
                  <p className="hint" style={{ margin: "0 0 12px" }}>
                    Calculé le {tunisDateTime(result.computedAt)}
                  </p>
                  <div style={{ fontSize: "1.02rem", marginBottom: 12 }}>
                    {[
                      ["Montant initial", result.initialAmount, ""],
                      [`+ Ventes en espèces (${result.salesCount ?? 0})`, result.cashSales, "+"],
                      [`+ Remboursements de crédit (${result.repaymentsCount ?? 0})`, result.cashRepayments, "+"],
                      ...(result.moneyAdded !== 0 ? [["+ Argent ajouté", result.moneyAdded, "+"]] : []),
                      ...(result.moneyRemoved !== 0 ? [["- Argent retiré", result.moneyRemoved, "-"]] : []),
                    ].map(([label, val, sign]) => (
                      <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                        <span>{label}</span>
                        <span style={{ fontVariantNumeric: "tabular-nums" }}>
                          {sign}{formatMillimes(val)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="hint" style={{ margin: 0 }}>
                    Les ventes à crédit ne sont pas comptées : aucun argent n&apos;entre en caisse.
                  </p>

                  {/* Détail des remboursements par créditeur */}
                  {repayDetails.length > 0 && (
                    <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                      <p className="hint" style={{ margin: "0 0 6px", fontWeight: 700 }}>
                        Remboursements de crédit :
                      </p>
                      {repayDetails.map((r) => (
                        <div key={r.id} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", fontSize: ".92rem" }}>
                          <span>
                            {r.customerName}
                            <span className="hint"> · {tunisDateTime(r.createdAt)}{r.recordedByName ? ` · ${r.recordedByName}` : ""}</span>
                          </span>
                          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
                            +{formatMillimes(Math.abs(r.amount))}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ===== Panneau : Ajuster la caisse ===== */}
            {panel === "adjust" && (
              <div className="panel mb-2">
                <h2 className="section-title" style={{ marginTop: 0 }}>Ajuster la caisse</h2>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  {[["ADD", "Ajouter de l'argent"], ["REMOVE", "Retirer de l'argent"]].map(([dir, lbl]) => (
                    <button
                      key={dir}
                      type="button"
                      className={adjDirection === dir ? "btn-primary" : "btn-ghost"}
                      onClick={() => setAdjDirection(dir)}
                      style={{ flex: 1 }}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
                <form onSubmit={handleAdjust} noValidate>
                  <div className="field" style={{ maxWidth: 320 }}>
                    <label className="sg-label" htmlFor="adjAmount">Montant (DT)</label>
                    <input
                      id="adjAmount"
                      className="sg-input"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={adjAmount}
                      onChange={(e) => { setAdjAmount(e.target.value); setAdjError(""); if (adjTouched) setAdjError(""); }}
                      onBlur={() => setAdjTouched(true)}
                      aria-invalid={adjShowError ? "true" : "false"}
                      aria-describedby="adjAmount-error"
                      required
                    />
                    {adjShowError && (
                      <p className="error-msg" id="adjAmount-error" role="alert" style={{ marginTop: 4 }}>
                        {adjShowError}
                      </p>
                    )}
                  </div>
                  <div className="field" style={{ maxWidth: 320 }}>
                    <label className="sg-label" htmlFor="adjReason">
                      Motif (facultatif) <span className="hint">— {adjReason.trim().length}/200</span>
                    </label>
                    <input
                      id="adjReason"
                      className="sg-input"
                      type="text"
                      autoComplete="off"
                      maxLength={200}
                      value={adjReason}
                      onChange={(e) => setAdjReason(e.target.value)}
                      aria-describedby="adjReason-hint"
                    />
                    <p className="hint" id="adjReason-hint">3-200 caractères si renseigné.</p>
                  </div>
                  {adjError && <p className="error-msg" role="alert">{adjError}</p>}
                  {adjSuccess && <p className="success-msg" role="status">{adjSuccess}</p>}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn-primary" type="submit" disabled={!adjValid || adjPending} style={{ maxWidth: 160 }}>
                      {adjPending ? "Enregistrement…" : "Enregistrer"}
                    </button>
                    <button className="btn-ghost" type="button" onClick={closePanel}>Fermer</button>
                  </div>
                </form>
              </div>
            )}

            {/* ===== Panneau : Réinitialiser la caisse ===== */}
            {panel === "reinit" && (
              <div className="panel mb-2">
                <h2 className="section-title" style={{ marginTop: 0 }}>Réinitialiser la caisse</h2>
                <p style={{ marginTop: 0 }}>
                  Comptez l&apos;argent dans la caisse et saisissez le montant.
                </p>
                {reLoading ? (
                  <p className="empty-state">Chargement du montant attendu…</p>
                ) : reExpected ? (
                  <p className="hint" style={{ marginTop: 0 }}>
                    Montant attendu actuellement : {formatMillimes(reExpected.expectedAmount)} DT
                  </p>
                ) : (
                  <p className="error-msg" role="alert">{reError || "Montant attendu indisponible."}</p>
                )}
                <form onSubmit={handleReinitialize} noValidate>
                  <div className="field" style={{ maxWidth: 320 }}>
                    <label className="sg-label" htmlFor="reAmount">Montant réellement dans la caisse (DT)</label>
                    <input
                      id="reAmount"
                      className="sg-input"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={reAmount}
                      onChange={(e) => { setReAmount(e.target.value); setReError(""); }}
                      onBlur={() => setReTouched(true)}
                      aria-invalid={reTouched && reAmount.trim() !== "" && !reAmountValid ? "true" : "false"}
                      aria-describedby="reAmount-error reAmount-live"
                      required
                    />
                    {reTouched && reAmount.trim() !== "" && !reAmountValid && (
                      <p className="error-msg" id="reAmount-error" role="alert" style={{ marginTop: 4 }}>
                        {reParsed.error || "Montant invalide."}
                      </p>
                    )}
                    {/* Écart en direct dès que le montant est valide */}
                    {reDiff !== null && (
                      <p className="hint" id="reAmount-live" style={{ marginTop: 4 }}>
                        Écart : {ecartLabel(reDiff)}
                      </p>
                    )}
                  </div>
                  {reError && <p className="error-msg" role="alert">{reError}</p>}
                  {reSuccess && <p className="success-msg" role="status">{reSuccess}</p>}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      className="btn-primary"
                      type="submit"
                      disabled={!reAmountValid || rePending || !reExpected}
                      style={{ maxWidth: 160 }}
                    >
                      {rePending ? "Réinitialisation…" : "Réinitialiser"}
                    </button>
                    <button className="btn-ghost" type="button" onClick={closePanel}>Fermer</button>
                  </div>
                  <p className="hint" style={{ marginTop: 12 }}>
                    Un écart n&apos;est pas une preuve : vérifiez les ventes et les mouvements.
                  </p>
                </form>
              </div>
            )}
          </>
        ) : (
          <div className="panel">
            <p className="error-msg" role="alert">État de la caisse illisible. Réessayez.</p>
            <button className="btn-primary" onClick={loadStatus} style={{ maxWidth: 200 }}>
              Réessayer
            </button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
