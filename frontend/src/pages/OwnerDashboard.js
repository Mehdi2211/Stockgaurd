import React, { useState, useEffect } from "react";
import AppShell from "../components/AppShell";
import { useToast } from "../context/KioskContext";


const dt = (m) => (m / 1000).toFixed(3) + " DT";

// Demo stats — replaced by real API later
const DEMO_STATS = {
  salesToday:       47300,
  countToday:       12,
  totalCredit:      68200,
  activeCustomers:  34,
  activeProducts:   58,
  pendingCustomers: 3,
};

export default function OwnerDashboard() {
  const toast = useToast();
  const [stats, setStats] = useState(DEMO_STATS);

  useEffect(() => {
    fetch("/api/owner/stats")
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then(setStats)
      .catch(() => {}); // keep demo stats if no backend
  }, [toast]);

  return (
    <AppShell>
      <div className="owner-page">
        <h1 className="page-title">Tableau de bord</h1>

        <div className="stats-grid">
          <div className="stat-card">
            <span className="stat-label">Ventes aujourd&apos;hui</span>
            <span className="stat-value">{dt(stats.salesToday)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Nombre de ventes</span>
            <span className="stat-value">{stats.countToday}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Crédit en cours</span>
            <span className="stat-value warn">{dt(stats.totalCredit)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Clients actifs</span>
            <span className="stat-value">{stats.activeCustomers}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Produits actifs</span>
            <span className="stat-value">{stats.activeProducts}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Clients en attente</span>
            <span className="stat-value warn">{stats.pendingCustomers}</span>
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
