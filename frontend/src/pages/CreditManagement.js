import React, { useState, useEffect, useCallback } from "react";
import AppShell from "../components/AppShell";
import { useKiosk, useToast } from "../context/KioskContext";
import { apiFetch, getTokenRole } from "../api";
import { formatMillimes } from "../utils/money";
import { parseAmountDT } from "../utils/amount";

// =====================================================================
// Gestion des crédits — données réelles (API /api/credits).
// - OWNER : valide les clients, ajoute des dettes, rembourse.
// - CASHIER : consulte et enregistre des remboursements uniquement.
// =====================================================================

const STATUS_LABEL = { PENDING: "En attente", VALIDATED: "Validé" };
const STATUS_BADGE = { PENDING: "badge-warn", VALIDATED: "badge-success" };

function entryLabel(h) {
  if (h.reverses_id) return "Annulation";
  if (h.amount > 0) return h.sale_id ? "Vente à crédit" : "Dette";
  return "Remboursement";
}

function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("fr-TN", {
    timeZone: "Africa/Tunis",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export default function CreditManagement() {
  const { role } = useKiosk();
  const toast = useToast();
  const isOwner = role === "OWNER" || getTokenRole() === "OWNER";

  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState("");

  const [repayAmt, setRepayAmt] = useState("");
  const [addAmt, setAddAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [cinUrl, setCinUrl] = useState("");       // URL signée (OWNER, éphémère)
  const [cinBusy, setCinBusy] = useState(false);

  const loadCustomers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // limit=200 = maximum accepté par l'API (filtrage/tri côté client).
      const data = await apiFetch("/credits/customers?limit=200");
      setCustomers(data.customers || []);
    } catch (err) {
      setError(err.message || "Le service est indisponible, réessayez.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadCustomers(); }, [loadCustomers]);

  const loadDetail = useCallback(async (id) => {
    setDetailLoading(true);
    try {
      const data = await apiFetch(`/credits/customers/${id}`);
      setSelected(data.customer);
      setHistory(data.history || []);
    } catch (err) {
      toast(err.message || "Erreur de chargement.");
    } finally {
      setDetailLoading(false);
    }
  }, [toast]);

  const openCustomer = (c) => {
    setSelected(c);
    setHistory([]);
    setRepayAmt("");
    setAddAmt("");
    setCinUrl("");
    loadDetail(c.id);
  };

  // OWNER uniquement : URL SIGNÉE à courte durée (60 s) pour consulter la
  // photo de la CIN. Le caissier n'y a jamais accès (403 côté serveur).
  const viewCin = async () => {
    if (!selected) return;
    setCinBusy(true);
    try {
      const data = await apiFetch(`/credits/customers/${selected.id}/cin`);
      setCinUrl(data.url);
    } catch (err) {
      toast(err.message || "Impossible d'afficher la photo de la CIN.");
    } finally {
      setCinBusy(false);
    }
  };

  // OWNER uniquement : supprime définitivement la photo (bucket + chemin NULL).
  // À proposer en priorité quand le solde est à 0 (durée de conservation).
  const deleteCin = async () => {
    if (!selected) return;
    if (!window.confirm("Supprimer définitivement la photo de la CIN de ce créditeur ?")) return;
    setCinBusy(true);
    try {
      await apiFetch(`/credits/customers/${selected.id}/cin`, { method: "DELETE" });
      toast("Photo de la CIN supprimée ✓");
      setCinUrl("");
      refresh();
    } catch (err) {
      toast(err.message || "Erreur lors de la suppression de la CIN.");
    } finally {
      setCinBusy(false);
    }
  };

  const refresh = () => {
    loadCustomers();
    if (selected) loadDetail(selected.id);
  };

  const handleRepay = async (e) => {
    e.preventDefault();
    const p = parseAmountDT(repayAmt);
    if (p.error || !p.millimes || p.millimes <= 0) {
      toast(p.error || "Montant invalide.");
      return;
    }
    if (selected && p.millimes > selected.balance) {
      toast("Le remboursement dépasse le solde dû.");
      return;
    }
    setBusy(true);
    try {
      await apiFetch("/credits/repayments", {
        method: "POST",
        body: JSON.stringify({
          customerId: selected.id,
          amount: p.millimes,
          id: crypto.randomUUID(),
        }),
      });
      setRepayAmt("");
      toast(`Remboursement de ${formatMillimes(p.millimes)} enregistré ✓`);
      refresh();
    } catch (err) {
      toast(err.message || "Erreur lors du remboursement.");
    } finally {
      setBusy(false);
    }
  };

  const handleAddCredit = async (e) => {
    e.preventDefault();
    const p = parseAmountDT(addAmt);
    if (p.error || !p.millimes || p.millimes <= 0) {
      toast(p.error || "Montant invalide.");
      return;
    }
    setBusy(true);
    try {
      await apiFetch("/credits/debts", {
        method: "POST",
        body: JSON.stringify({
          customerId: selected.id,
          amount: p.millimes,
          id: crypto.randomUUID(),
        }),
      });
      setAddAmt("");
      toast(`Dette de ${formatMillimes(p.millimes)} ajoutée ✓`);
      refresh();
    } catch (err) {
      toast(err.message || "Erreur lors de l'ajout de la dette.");
    } finally {
      setBusy(false);
    }
  };

  const handleValidate = async () => {
    setBusy(true);
    try {
      await apiFetch(`/credits/customers/${selected.id}/validate`, { method: "POST" });
      toast("Client validé ✓");
      refresh();
    } catch (err) {
      toast(err.message || "Erreur lors de la validation.");
    } finally {
      setBusy(false);
    }
  };

  const filtered = customers.filter((c) =>
    `${c.firstName} ${c.familyName}`.toLowerCase().includes(search.toLowerCase()) ||
    (c.phone || "").includes(search) ||
    (c.cin || "").includes(search)
  );

  return (
    <AppShell>
      <div className="owner-page">
        <div className="page-header">
          <h1 className="page-title">Gestion des crédits</h1>
        </div>

        {error && <p className="error-msg" role="alert">{error}</p>}

        <div className="credits-layout">

          {/* ── Left: client list ── */}
          <div className="panel credits-list-panel">
            <input
              className="sg-input mb-2"
              type="search"
              placeholder="Rechercher un client…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />

            {loading ? (
              <p className="empty-state">Chargement…</p>
            ) : (
              <ul className="client-list">
                {filtered.length === 0 && (
                  <li className="empty-state">Aucun client trouvé.</li>
                )}
                {filtered.map((c) => (
                  <li
                    key={c.id}
                    className={`client-row ${selected?.id === c.id ? "active" : ""}`}
                    onClick={() => openCustomer(c)}
                  >
                    <div className="client-row-info">
                      <span className="client-name">{c.firstName} {c.familyName}</span>
                      <span className="client-meta">{c.phone} · {c.cin}</span>
                    </div>
                    <div className="client-row-right">
                      {c.balance > 0 && (
                        <span className="client-balance">{formatMillimes(c.balance)}</span>
                      )}
                      <span className={`badge ${STATUS_BADGE[c.status]}`}>
                        {STATUS_LABEL[c.status] || c.status}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ── Right: credit detail panel ── */}
          <div className="panel credits-detail-panel">
            {!selected ? (
              <div className="empty-state" style={{ paddingTop: 60 }}>
                Sélectionnez un client pour voir ses crédits.
              </div>
            ) : detailLoading && history.length === 0 ? (
              <p className="empty-state">Chargement…</p>
            ) : (
              <>
                {/* Client header */}
                <div className="detail-header">
                  <div>
                    <h2 className="detail-name">{selected.firstName} {selected.familyName}</h2>
                    <p className="text-muted">{selected.phone} · CIN {selected.cin}</p>
                  </div>
                  <span className={`badge ${STATUS_BADGE[selected.status]}`}>
                    {STATUS_LABEL[selected.status] || selected.status}
                  </span>
                </div>

                {/* Validate button if pending (OWNER uniquement) */}
                {selected.status === "PENDING" && isOwner && (
                  <div className="detail-section">
                    <p className="hint" style={{ marginBottom: 10 }}>
                      Ce client est en attente de validation. Validez-le pour lui accorder un crédit.
                    </p>
                    <button
                      className="btn-primary"
                      style={{ maxWidth: 200 }}
                      onClick={handleValidate}
                      disabled={busy}
                    >
                      Valider le client
                    </button>
                  </div>
                )}

                {/* Balance summary */}
                <div className="balance-box">
                  <span className="balance-label">Solde dû</span>
                  <span className={`balance-amount ${selected.balance > 0 ? "warn" : "ok"}`}>
                    {formatMillimes(selected.balance)}
                  </span>
                </div>

                {/* Photo de la CIN — OWNER uniquement (donnée personnelle sensible) */}
                {isOwner && (
                  <div className="detail-section">
                    <h3 className="section-title">Photo de la CIN</h3>
                    {selected.hasCin ? (
                      <>
                        <p className="hint" style={{ marginBottom: 10 }}>
                          Photo conservée de façon sécurisée. Consultation via un lien signé valable 60 secondes.
                          {selected.balance === 0 && " Le solde étant soldé, sa suppression est recommandée."}
                        </p>
                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                          <button className="btn-ghost" onClick={viewCin} disabled={cinBusy}>
                            Voir la CIN
                          </button>
                          <button
                            className="btn-ghost"
                            style={{ borderColor: "var(--warn)", color: "var(--warn)" }}
                            onClick={deleteCin}
                            disabled={cinBusy}
                          >
                            Supprimer la CIN
                          </button>
                        </div>
                      </>
                    ) : (
                      <p className="hint">
                        Aucune photo conservée. Pour accorder une nouvelle dette, le caissier doit
                        d&apos;abord reprendre la photo de la CIN.
                      </p>
                    )}
                  </div>
                )}

                {selected.status === "VALIDATED" && (
                  <>
                    {/* Add debt (OWNER uniquement) */}
                    {isOwner && (
                      <div className="detail-section">
                        <h3 className="section-title">Ajouter une dette</h3>
                        <form onSubmit={handleAddCredit} className="credit-form">
                          <div className="credit-input-row">
                            <input
                              className="sg-input"
                              type="text"
                              inputMode="decimal"
                              autoComplete="off"
                              placeholder="Montant en DT (ex: 5.500)"
                              value={addAmt}
                              onChange={(e) => setAddAmt(e.target.value)}
                              required
                            />
                            <button className="btn-pay" type="submit" disabled={busy}>Ajouter</button>
                          </div>
                        </form>
                      </div>
                    )}

                    {/* Repayment (OWNER + CASHIER) */}
                    {selected.balance > 0 && (
                      <div className="detail-section">
                        <h3 className="section-title">Enregistrer un remboursement</h3>
                        <form onSubmit={handleRepay} className="credit-form">
                          <div className="credit-input-row">
                            <input
                              className="sg-input"
                              type="text"
                              inputMode="decimal"
                              autoComplete="off"
                              placeholder={`Max ${formatMillimes(selected.balance)}`}
                              value={repayAmt}
                              onChange={(e) => setRepayAmt(e.target.value)}
                              required
                            />
                            <button className="btn-pay alt" type="submit" disabled={busy}>Rembourser</button>
                          </div>
                          <div className="repay-shortcuts">
                            <span className="hint">Remboursement rapide :</span>
                            <button type="button" className="btn-ghost repay-quick"
                              onClick={() => setRepayAmt((selected.balance / 1000).toFixed(3))}>
                              Tout ({formatMillimes(selected.balance)})
                            </button>
                          </div>
                        </form>
                      </div>
                    )}
                  </>
                )}

                {/* History */}
                <div className="detail-section">
                  <h3 className="section-title">Historique</h3>
                  {history.length === 0 ? (
                    <p className="hint">Aucune opération enregistrée.</p>
                  ) : (
                    <ul className="client-list">
                      {history.map((h) => (
                        <li key={h.id} className="client-row" style={{ cursor: "default" }}>
                          <div className="client-row-info">
                            <span className="client-name">{entryLabel(h)}</span>
                            <span className="client-meta">
                              {fmtDate(h.createdAt)}{h.recordedByName ? ` · ${h.recordedByName}` : ""}
                              {h.note ? ` · ${h.note}` : ""}
                            </span>
                          </div>
                          <div className="client-row-right">
                            <span className={`client-balance ${h.amount < 0 ? "" : "warn"}`}>
                              {h.amount > 0 ? "+" : "−"}{formatMillimes(Math.abs(h.amount))}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>

        </div>
      </div>

      {/* Consultation de la CIN (OWNER) via l'URL signée — jamais dans la liste */}
      {cinUrl && (
        <div className="modal-backdrop" onClick={() => setCinUrl("")}>
          <div className="modal-box modal-box-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Photo de la CIN</h2>
              <button className="modal-close" onClick={() => setCinUrl("")} aria-label="Fermer">✕</button>
            </div>
            <p className="modal-hint">Lien signé éphémère (60 s). Ne pas partager ni capturer.</p>
            <img className="cin-preview-img" src={cinUrl} alt="Photo de la CIN du créditeur" />
            <div className="modal-actions">
              <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setCinUrl("")}>Fermer</button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
