import React, { useState, useEffect } from "react";
import AppShell from "../components/AppShell";
import { useToast } from "../context/KioskContext";
import { apiFetch } from "../api";


const dt  = (m) => (m / 1000).toFixed(3) + " DT";
const fmt = (d) => new Date(d).toLocaleString("fr-TN");

export default function SalesHistory() {
  const toast = useToast();
  const [sales,    setSales]    = useState([]);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    apiFetch("/sales")
      .then((d) => setSales(d.sales || []))
      .catch(() => toast("Erreur de chargement."));
  }, [toast]);

  const toggle = (id) => setExpanded((v) => (v === id ? null : id));

  return (
    <AppShell>
      <div className="owner-page">
        <h1 className="page-title">Historique des ventes</h1>
        <div className="panel">
          <table className="sg-table">
            <thead>
              <tr>
                <th>N°</th>
                <th>Date</th>
                <th>Total</th>
                <th>Type</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sales.length === 0 ? (
                <tr><td colSpan={5} className="empty-state">Aucune vente enregistrée.</td></tr>
              ) : sales.map((s) => (
                <React.Fragment key={s.id}>
                  <tr>
                    <td><strong>{s.saleNumber}</strong></td>
                    <td>{fmt(s.createdAt)}</td>
                    <td>{dt(s.total)}</td>
                    <td>
                      <span className={`badge ${s.paymentMethod === "CREDIT" ? "badge-warn" : "badge-success"}`}>
                        {s.paymentMethod === "CREDIT" ? "Crédit" : "Espèces"}
                      </span>
                      {s.cashierName && (
                        <span className="hint" style={{ display: "block", margin: 0 }}>
                          {s.cashierName}
                        </span>
                      )}
                    </td>
                    <td>
                      <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: ".85rem" }}
                        onClick={() => toggle(s.id)}>
                        {expanded === s.id ? "Masquer" : "Détails"}
                      </button>
                    </td>
                  </tr>
                  {expanded === s.id && s.lines && (
                    <tr>
                      <td colSpan={5} style={{ background: "var(--soft)", padding: "10px 14px" }}>
                        <table className="sg-table" style={{ fontSize: ".88rem" }}>
                          <thead>
                            <tr><th>Produit</th><th>Qté</th><th>Prix unit.</th><th>Sous-total</th></tr>
                          </thead>
                          <tbody>
                            {s.lines.map((l) => (
                              <tr key={l.id}>
                                <td>{l.productName || l.productId}</td>
                                <td>{l.quantity}</td>
                                <td>{dt(l.unitPrice)}</td>
                                <td>{dt(l.lineTotal ?? l.quantity * l.unitPrice)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
