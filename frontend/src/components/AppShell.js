import React, { useState } from "react";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { useKiosk } from "../context/KioskContext";
import AdminPinModal from "./AdminPinModal";


export default function AppShell({ children }) {
  const { kiosk, role, downgrade, logout } = useKiosk();
  const navigate = useNavigate();
  const location = useLocation();
  const [showPinModal, setShowPinModal] = useState(false);

  const handleLogout = () => { logout(); navigate("/"); };

  const handleExitAdmin = () => { downgrade(); navigate("/caisse"); };

  // Bouton retour : historique navigateur si possible, sinon page
  // d'accueil du rôle courant.
  const handleBack = () => {
    if (location.key !== "default") navigate(-1);
    else navigate(role === "OWNER" ? "/owner" : "/caisse");
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <strong className="app-brand">{kiosk?.name || "StockGuard"}</strong>

        <nav aria-label="Navigation principale">
          {/* Cashier view — POS + remboursement crédit */}
          {role === "CASHIER" && (
            <>
              <NavLink to="/caisse" className={({ isActive }) => isActive ? "nav-btn active" : "nav-btn"}>
                Caisse
              </NavLink>
              <NavLink to="/credits/repayment" className={({ isActive }) => isActive ? "nav-btn active" : "nav-btn"}>
                Remboursement crédit
              </NavLink>
            </>
          )}

          {/* Owner view — full nav, no Caisse */}
          {role === "OWNER" && (
            <>
              <NavLink to="/owner/produits" className={({ isActive }) => isActive ? "nav-btn active" : "nav-btn"}>Produits</NavLink>
              <NavLink to="/owner/credits"  className={({ isActive }) => isActive ? "nav-btn active" : "nav-btn"}>Crédits</NavLink>
              <NavLink to="/owner/stock"    className={({ isActive }) => isActive ? "nav-btn active" : "nav-btn"}>Stock</NavLink>
              <NavLink to="/owner/ventes"   className={({ isActive }) => isActive ? "nav-btn active" : "nav-btn"}>Ventes</NavLink>
              <NavLink to="/owner/cash-register" className={({ isActive }) => isActive ? "nav-btn active" : "nav-btn"}>Caisse</NavLink>
              <NavLink to="/credits/repayment" className={({ isActive }) => isActive ? "nav-btn active" : "nav-btn"}>Remboursement crédit</NavLink>
              <NavLink to="/owner" end      className={({ isActive }) => isActive ? "nav-btn active" : "nav-btn"}>Tableau de bord</NavLink>
            </>
          )}
        </nav>

        <div className="header-actions">
          <button className="btn-ghost" onClick={handleBack} aria-label="Retour">
            ← Retour
          </button>
          {/* Cashier sees an "Administration" button to elevate */}
          {role === "CASHIER" && (
            <button className="btn-admin" onClick={() => setShowPinModal(true)}>
              🔐 Administration
            </button>
          )}

          {/* Owner sees an "Exit admin" button to go back to cashier */}
          {role === "OWNER" && (
            <button className="btn-exit-admin" onClick={handleExitAdmin}>
              ← Quitter l&apos;admin
            </button>
          )}

          <button className="btn-ghost" onClick={handleLogout}>Fermer la caisse</button>
        </div>
      </header>

      <div className="app-body">{children}</div>

      {/* PIN modal */}
      {showPinModal && <AdminPinModal onClose={() => setShowPinModal(false)} />}
    </div>
  );
}
