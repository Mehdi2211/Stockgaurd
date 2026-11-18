import React, { useState } from "react";
import AppShell from "../components/AppShell";
import { useToast } from "../context/KioskContext";



const dt = (m) => (m / 1000).toFixed(3) + " DT";

// Demo data — replaced by real API later
const DEMO_CUSTOMERS = [
  { id: "1", firstName: "Mohamed",  familyName: "Ben Ali",    phone: "22334455", cin: "12345678", status: "VALIDATED", balance: 18500 },
  { id: "2", firstName: "Fatma",    familyName: "Trabelsi",   phone: "55667788", cin: "87654321", status: "VALIDATED", balance: 7200  },
  { id: "3", firstName: "Khaled",   familyName: "Mansouri",   phone: "99887766", cin: "11223344", status: "PENDING",   balance: 0     },
  { id: "4", firstName: "Sonia",    familyName: "Bouazizi",   phone: "33445566", cin: "44332211", status: "VALIDATED", balance: 0     },
  { id: "5", firstName: "Ridha",    familyName: "Chaabane",   phone: "77889900", cin: "55443322", status: "VALIDATED", balance: 42000 },
];

const STATUS_LABEL = { PENDING: "En attente", VALIDATED: "Validé" };
const STATUS_BADGE = { PENDING: "badge-warn",  VALIDATED: "badge-success" };

export default function CreditManagement() {
  const toast = useToast();
  const [customers, setCustomers] = useState(DEMO_CUSTOMERS);
  const [selected,  setSelected]  = useState(null); // customer being viewed
  const [repayAmt,  setRepayAmt]  = useState("");   // repayment amount in DT
  const [addAmt,    setAddAmt]    = useState("");   // new credit amount in DT
  const [search,    setSearch]    = useState("");

  const filtered = customers.filter((c) =>
    `${c.firstName} ${c.familyName}`.toLowerCase().includes(search.toLowerCase()) ||
    c.phone.includes(search) ||
    c.cin.includes(search)
  );

  const openCustomer = (c) => {
    setSelected(c);
    setRepayAmt("");
    setAddAmt("");
  };

  const handleRepay = (e) => {
    e.preventDefault();
    const amt = Math.round(parseFloat(repayAmt) * 1000);
    if (!amt || amt <= 0) { toast("Montant invalide."); return; }
    if (amt > selected.balance) { toast("Le remboursement dépasse le solde dû."); return; }

    setCustomers((prev) =>
      prev.map((c) => c.id === selected.id ? { ...c, balance: c.balance - amt } : c)
    );
    setSelected((prev) => ({ ...prev, balance: prev.balance - amt }));
    setRepayAmt("");
    toast(`Remboursement de ${dt(amt)} enregistré ✓`);
  };

  const handleAddCredit = (e) => {
    e.preventDefault();
    const amt = Math.round(parseFloat(addAmt) * 1000);
    if (!amt || amt <= 0) { toast("Montant invalide."); return; }

    setCustomers((prev) =>
      prev.map((c) => c.id === selected.id ? { ...c, balance: c.balance + amt } : c)
    );
    setSelected((prev) => ({ ...prev, balance: prev.balance + amt }));
    setAddAmt("");
    toast(`Crédit de ${dt(amt)} ajouté ✓`);
  };

  const handleValidate = (id) => {
    setCustomers((prev) =>
      prev.map((c) => c.id === id ? { ...c, status: "VALIDATED" } : c)
    );
    if (selected?.id === id) setSelected((prev) => ({ ...prev, status: "VALIDATED" }));
    toast("Client validé ✓");
  };

  return (
    <AppShell>
      <div className="owner-page">
        <div className="page-header">
          <h1 className="page-title">Gestion des crédits</h1>
        </div>

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
                      <span className="client-balance">{dt(c.balance)}</span>
                    )}
                    <span className={`badge ${STATUS_BADGE[c.status]}`}>
                      {STATUS_LABEL[c.status]}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* ── Right: credit detail panel ── */}
          <div className="panel credits-detail-panel">
            {!selected ? (
              <div className="empty-state" style={{ paddingTop: 60 }}>
                Sélectionnez un client pour voir ses crédits.
              </div>
            ) : (
              <>
                {/* Client header */}
                <div className="detail-header">
                  <div>
                    <h2 className="detail-name">{selected.firstName} {selected.familyName}</h2>
                    <p className="text-muted">{selected.phone} · CIN {selected.cin}</p>
                  </div>
                  <span className={`badge ${STATUS_BADGE[selected.status]}`}>
                    {STATUS_LABEL[selected.status]}
                  </span>
                </div>

                {/* Validate button if pending */}
                {selected.status === "PENDING" && (
                  <div className="detail-section">
                    <p className="hint" style={{ marginBottom: 10 }}>
                      Ce client est en attente de validation. Validez-le pour lui accorder un crédit.
                    </p>
                    <button
                      className="btn-primary"
                      style={{ maxWidth: 200 }}
                      onClick={() => handleValidate(selected.id)}
                    >
                      Valider le client
                    </button>
                  </div>
                )}

                {/* Balance summary */}
                <div className="balance-box">
                  <span className="balance-label">Solde dû</span>
                  <span className={`balance-amount ${selected.balance > 0 ? "warn" : "ok"}`}>
                    {dt(selected.balance)}
                  </span>
                </div>

                {selected.status === "VALIDATED" && (
                  <>
                    {/* Add credit */}
                    <div className="detail-section">
                      <h3 className="section-title">Ajouter un crédit</h3>
                      <form onSubmit={handleAddCredit} className="credit-form">
                        <div className="credit-input-row">
                          <input
                            className="sg-input"
                            type="number"
                            step="0.001"
                            min="0.001"
                            placeholder="Montant en DT (ex: 5.500)"
                            value={addAmt}
                            onChange={(e) => setAddAmt(e.target.value)}
                            required
                          />
                          <button className="btn-pay" type="submit">Ajouter</button>
                        </div>
                      </form>
                    </div>

                    {/* Repayment */}
                    {selected.balance > 0 && (
                      <div className="detail-section">
                        <h3 className="section-title">Enregistrer un remboursement</h3>
                        <form onSubmit={handleRepay} className="credit-form">
                          <div className="credit-input-row">
                            <input
                              className="sg-input"
                              type="number"
                              step="0.001"
                              min="0.001"
                              max={selected.balance / 1000}
                              placeholder={`Max ${dt(selected.balance)}`}
                              value={repayAmt}
                              onChange={(e) => setRepayAmt(e.target.value)}
                              required
                            />
                            <button className="btn-pay alt" type="submit">Rembourser</button>
                          </div>
                          <div className="repay-shortcuts">
                            <span className="hint">Remboursement rapide :</span>
                            <button type="button" className="btn-ghost repay-quick"
                              onClick={() => setRepayAmt((selected.balance / 1000).toFixed(3))}>
                              Tout ({dt(selected.balance)})
                            </button>
                          </div>
                        </form>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>

        </div>
      </div>
    </AppShell>
  );
}
