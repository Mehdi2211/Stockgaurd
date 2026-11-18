import React, { useState, useEffect, useRef, useCallback } from "react";
import AppShell from "../components/AppShell";
import { useKiosk } from "../context/KioskContext";
import { apiFetch, getTokenRole } from "../api";
import { formatMillimes } from "../utils/money";
import { parseAmountDT } from "../utils/amount";

// =====================================================================
// Remboursement de crédit client — OWNER et CASHIER.
// Un seul écran : recherche client -> montant -> confirmation -> succès.
// Le remboursement entre en caisse : il augmente le montant attendu.
// =====================================================================

export default function CreditRepayment() {
  const { role } = useKiosk();

  // Recherche
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const debounceRef = useRef(null);

  // Client sélectionné + remboursement
  const [customer, setCustomer] = useState(null); // {id, firstName, familyName, balance, maskedCin}
  const [repaymentId, setRepaymentId] = useState(null); // UUID, réutilisé au retry
  const [amount, setAmount] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState("");
  const [success, setSuccess] = useState("");

  const isStaff = role === "OWNER" || role === "CASHIER" || getTokenRole() === "OWNER" || getTokenRole() === "CASHIER";

  // --- Recherche avec debounce 300 ms (min 3 caractères) ---
  const doSearch = useCallback(async (q) => {
    setSearching(true);
    setSearchError("");
    try {
      const data = await apiFetch(`/customers/search?q=${encodeURIComponent(q)}`);
      setResults(data.customers || []);
    } catch (err) {
      setResults([]);
      setSearchError(err.message || "Le service est indisponible, réessayez.");
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 3) {
      setResults([]);
      setSearchError("");
      return;
    }
    debounceRef.current = setTimeout(() => doSearch(q), 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, doSearch]);

  // --- Sélection client : nouveau repaymentId (crypto.randomUUID) ---
  const selectCustomer = (c) => {
    setCustomer(c);
    setRepaymentId(crypto.randomUUID());
    setAmount("");
    setAmountTouched(false);
    setFormError("");
    setSuccess("");
    setResults([]);
    setQuery("");
  };

  const resetScreen = () => {
    setCustomer(null);
    setRepaymentId(null);
    setAmount("");
    setAmountTouched(false);
    setFormError("");
    setSuccess("");
    setQuery("");
    setResults([]);
  };

  // --- Validation montant : > 0 et <= dette, sans flottant ---
  const parsed = parseAmountDT(amount);
  const amountValid =
    parsed.millimes !== undefined &&
    parsed.millimes > 0 &&
    customer && parsed.millimes <= customer.balance;
  const showAmountError =
    amountTouched && amount.trim() !== "" && !amountValid
      ? parsed.error ||
        (parsed.millimes !== undefined && parsed.millimes === 0
          ? "Le montant doit être supérieur à 0."
          : customer && parsed.millimes > customer.balance
          ? `Le montant dépasse la dette (${formatMillimes(customer.balance)} DT).`
          : "Montant invalide.")
      : "";

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError("");
    setAmountTouched(true);
    const p = parseAmountDT(amount);
    if (p.error || p.millimes === undefined || p.millimes <= 0) {
      return; // erreur affichée via showAmountError
    }
    if (p.millimes > customer.balance) {
      return;
    }
    const ok = window.confirm(
      `Enregistrer le remboursement de ${formatMillimes(p.millimes)} DT pour ` +
      `${customer.firstName} ${customer.familyName} ? Il ne pourra pas être modifié.`
    );
    if (!ok) return;

    setPending(true);
    try {
      const data = await apiFetch("/credits/repayments", {
        method: "POST",
        body: JSON.stringify({
          repaymentId,
          customerId: customer.id,
          amount: p.millimes,
        }),
      });
      setSuccess(
        `Remboursement de ${formatMillimes(p.millimes)} DT enregistré. ` +
        `Dette restante : ${formatMillimes(data.newBalance)} DT.`
      );
      // Nouveau repaymentId après succès (le prochain client en aura un
      // autre via selectCustomer ; on réinitialise l'écran).
      setTimeout(resetScreen, 1500);
    } catch (err) {
      // Erreur : le formulaire n'est PAS effacé, repaymentId conservé
      // (un retry réutilise le même id -> idempotent côté serveur).
      setFormError(err.message || "Le service est indisponible, réessayez.");
    } finally {
      setPending(false);
    }
  };

  if (!isStaff) {
    return (
      <AppShell>
        <div className="owner-page">
          <h1 className="page-title">Remboursement crédit</h1>
          <div className="panel">
            <p className="error-msg" role="alert">Accès refusé. Connectez-vous à la caisse.</p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="owner-page" style={{ maxWidth: 560 }}>
        <div className="page-header">
          <h1 className="page-title">Remboursement crédit</h1>
        </div>

        {!customer ? (
          /* ===== Étape 1 : recherche client ===== */
          <div className="panel">
            <div className="field">
              <label className="sg-label" htmlFor="custSearch">
                Rechercher un client (nom, téléphone ou CIN)
              </label>
              <input
                id="custSearch"
                className="sg-input"
                type="text"
                autoComplete="off"
                placeholder="Minimum 3 caractères"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            {searching && <p className="hint">Recherche…</p>}
            {searchError && <p className="error-msg" role="alert">{searchError}</p>}

            {results.length > 0 && (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {results.map((c) => {
                  const noDebt = c.balance <= 0;
                  return (
                    <li key={c.id} style={{ marginBottom: 8 }}>
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={noDebt}
                        onClick={() => selectCustomer(c)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          opacity: noDebt ? 0.55 : 1,
                          cursor: noDebt ? "not-allowed" : "pointer",
                        }}
                      >
                        {c.firstName} {c.familyName} —{" "}
                        {noDebt ? "Aucune dette" : `dette : ${formatMillimes(c.balance)} DT`} —{" "}
                        CIN {c.maskedCin}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {!searching && query.trim().length >= 3 && results.length === 0 && !searchError && (
              <p className="hint">Aucun client trouvé.</p>
            )}
          </div>
        ) : (
          /* ===== Étape 2 : montant + confirmation ===== */
          <div className="panel">
            <p style={{ marginTop: 0 }}>
              <strong>{customer.firstName} {customer.familyName}</strong>
              <br />
              <span className="hint">Dette actuelle : {formatMillimes(customer.balance)} DT</span>
            </p>

            <form onSubmit={handleSubmit} noValidate>
              <div className="field" style={{ maxWidth: 320 }}>
                <label className="sg-label" htmlFor="repayAmount">Montant remboursé (DT)</label>
                <input
                  id="repayAmount"
                  className="sg-input"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="Ex. 20"
                  value={amount}
                  onChange={(e) => { setAmount(e.target.value); setFormError(""); }}
                  onBlur={() => setAmountTouched(true)}
                  aria-invalid={showAmountError ? "true" : "false"}
                  aria-describedby="repayAmount-error repayAmount-hint"
                  required
                />
                {showAmountError && (
                  <p className="error-msg" id="repayAmount-error" role="alert" style={{ marginTop: 4 }}>
                    {showAmountError}
                  </p>
                )}
                <p className="hint" id="repayAmount-hint">
                  Maximum {formatMillimes(customer.balance)} DT, 3 décimales maximum.
                </p>
              </div>

              {formError && <p className="error-msg" role="alert">{formError}</p>}
              {success && <p className="success-msg" role="status">{success}</p>}

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn-primary"
                  type="submit"
                  disabled={!amountValid || pending}
                  style={{ maxWidth: 260 }}
                >
                  {pending ? "Enregistrement…" : "Enregistrer le remboursement"}
                </button>
                <button className="btn-ghost" type="button" onClick={resetScreen} disabled={pending}>
                  Annuler
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </AppShell>
  );
}
