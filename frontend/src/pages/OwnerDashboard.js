import React, { useState, useEffect } from "react";
import AppShell from "../components/AppShell";
import { apiFetch } from "../api";


const dt = (m) => (m / 1000).toFixed(3) + " DT";

const EMPTY_STATS = {
  salesToday:       0,
  countToday:       0,
  totalCredit:      0,
  activeCustomers:  0,
  activeProducts:   0,
  pendingCustomers: 0,
};

export default function OwnerDashboard() {
  const [stats,   setStats]   = useState(EMPTY_STATS);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch("/owner/stats")
      .then((d) => { if (!cancelled) { setStats(d); setError(""); } })
      .catch((err) => { if (!cancelled) setError(err.message || "Chargement impossible."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <AppShell>
      <div className="owner-page">
        <h1 className="page-title">Tableau de bord</h1>

        {error && <p className="error-msg" role="alert">{error}</p>}

        <div className="stats-grid">
          <div className="stat-card">
            <span className="stat-label">Ventes aujourd&apos;hui</span>
            <span className="stat-value">{loading ? "…" : dt(stats.salesToday)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Nombre de ventes</span>
            <span className="stat-value">{loading ? "…" : stats.countToday}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Crédit en cours</span>
            <span className="stat-value warn">{loading ? "…" : dt(stats.totalCredit)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Clients actifs</span>
            <span className="stat-value">{loading ? "…" : stats.activeCustomers}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Produits actifs</span>
            <span className="stat-value">{loading ? "…" : stats.activeProducts}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Clients en attente</span>
            <span className="stat-value warn">{loading ? "…" : stats.pendingCustomers}</span>
          </div>
        </div>

        <div className="panel mt-3">
          <h2 className="section-title">Accès rapide</h2>
          <div className="quick-links">
            <a href="/owner/produits" className="quick-link">📦 Gérer les produits</a>
            <a href="/owner/credits"  className="quick-link">💳 Gérer les crédits</a>
            <a href="/owner/stock"    className="quick-link">📊 Mouvements de stock</a>
            <a href="/owner/ventes"   className="quick-link">🧾 Historique des ventes</a>
            <a href="/owner/cash-register" className="quick-link">💰 Suivi de la caisse</a>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
