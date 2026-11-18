import React, { createContext, useContext, useState, useCallback } from "react";

const KioskContext = createContext(null);

// Le rôle est persisté en sessionStorage pour survivre à un refresh
// de la page (sinon le mode OWNER est perdu et les pages réservées
// affichent 403). sessionStorage = par onglet, effacé à la fermeture.
const ROLE_KEY = "sg_role";

export function KioskProvider({ children }) {
  const [kiosk, setKiosk] = useState(null);
  const [role,  setRole]  = useState(() => sessionStorage.getItem(ROLE_KEY)); // "CASHIER" | "OWNER" | null
  const [toast, setToast] = useState(null);

  const applyRole = useCallback((r) => {
    setRole(r);
    if (r) sessionStorage.setItem(ROLE_KEY, r);
    else sessionStorage.removeItem(ROLE_KEY);
  }, []);

  // Initial login — always as CASHIER
  const login = useCallback((kioskData) => {
    setKiosk(kioskData);
    applyRole("CASHIER");
  }, [applyRole]);

  // Elevate to OWNER after PIN check (called by AdminPinModal)
  const elevate = useCallback(() => {
    applyRole("OWNER");
  }, [applyRole]);

  // Drop back to CASHIER (exit admin mode without full logout)
  const downgrade = useCallback(() => {
    applyRole("CASHIER");
  }, [applyRole]);

  const logout = useCallback(() => {
    setKiosk(null);
    applyRole(null);
  }, [applyRole]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  }, []);

  return (
    <KioskContext.Provider value={{ kiosk, role, login, elevate, downgrade, logout, showToast }}>
      {children}
      {toast && <div className="toast">{toast}</div>}
    </KioskContext.Provider>
  );
}

export function useKiosk() { return useContext(KioskContext); }
export function useToast() { return useContext(KioskContext).showToast; }
