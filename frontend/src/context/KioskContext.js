import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import { apiFetch, setToken, getToken, getTokenRole } from "../api";

const KioskContext = createContext(null);

// Le rôle est persisté en sessionStorage pour survivre à un refresh
// de la page. sessionStorage = par onglet, effacé à la fermeture.
const ROLE_KEY = "sg_role";
// Boutique ouverte (affichée dans l'en-tête), restaurée au refresh.
const SHOP_KEY = "sg_shop";
// Jeton du caissier, conservé pour revenir au mode caisse après une
// session propriétaire (« Quitter l'admin »).
const CASHIER_TOKEN_KEY = "sg_cashier_token";

export function KioskProvider({ children }) {
  const [kiosk, setKiosk] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(SHOP_KEY)); } catch { return null; }
  });
  const [role,  setRole]  = useState(() => getTokenRole()); // "CASHIER" | "OWNER" | null
  const [toast, setToast] = useState(null);

  const applyRole = useCallback((r) => {
    setRole(r);
    if (r) sessionStorage.setItem(ROLE_KEY, r);
    else sessionStorage.removeItem(ROLE_KEY);
  }, []);

  const storeShop = useCallback((shop) => {
    setKiosk(shop);
    if (shop) sessionStorage.setItem(SHOP_KEY, JSON.stringify(shop));
    else sessionStorage.removeItem(SHOP_KEY);
  }, []);

  // Session déjà ouverte (refresh) : le jeton est dans localStorage,
  // on recharge la boutique depuis l'API (jamais de code en dur).
  useEffect(() => {
    if (!getToken()) return;
    apiFetch("/shop/me")
      .then(({ shop }) => {
        storeShop({ id: shop.id, code: shop.code, name: shop.name });
        applyRole(getTokenRole());
      })
      .catch(() => { /* jeton invalide : apiFetch gère la redirection 401 */ });
  }, [storeShop, applyRole]);

  // Connexion (page de login), caissier OU propriétaire.
  //   { token, user: { id, name, role }, shop: { id, code, name } }
  const login = useCallback(({ token, user, shop }) => {
    if (user.role === "CASHIER") sessionStorage.setItem(CASHIER_TOKEN_KEY, token);
    setToken(token);
    storeShop({ id: shop.id, code: shop.code, name: shop.name, user });
    applyRole(user.role);
  }, [storeShop, applyRole]);

  // Élévation vers le mode propriétaire depuis la session caissier
  // (« Administration ») : remplace le jeton actif par le jeton OWNER.
  const elevate = useCallback(({ token }) => {
    setToken(token);
    applyRole("OWNER");
  }, [applyRole]);

  // Retour au mode caisse : restaure le jeton du caissier.
  const downgrade = useCallback(() => {
    const cashierToken = sessionStorage.getItem(CASHIER_TOKEN_KEY);
    if (cashierToken) setToken(cashierToken);
    applyRole("CASHIER");
  }, [applyRole]);

  const logout = useCallback(() => {
    setToken(null);
    sessionStorage.removeItem(CASHIER_TOKEN_KEY);
    storeShop(null);
    applyRole(null);
  }, [storeShop, applyRole]);

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
