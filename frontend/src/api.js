// Helper d'appel API : joint le jeton JWT stocké par le flux de
// connexion (login hors périmètre — le login doit enregistrer le jeton
// sous la clé "sg_token" dans localStorage).

export function getToken() {
  return localStorage.getItem("sg_token");
}

export function setToken(token) {
  if (token) localStorage.setItem("sg_token", token);
  else localStorage.removeItem("sg_token");
}

// Rôle contenu dans le JWT ("OWNER" | "CASHIER" | null).
// Utilisé par les gardes de pages pour survivre à un refresh.
export function getTokenRole() {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.role || null;
  } catch {
    return null;
  }
}

// Message utilisateur lisible : le message français du serveur s'il
// existe, sinon un message générique. Les détails techniques restent
// dans la console (jamais affichés tels quels à l'utilisateur).
function userMessage(data, status) {
  const serverMsg = data?.error || data?.message;
  if (typeof serverMsg === "string" && serverMsg.trim() !== "") return serverMsg;
  if (status === 401) return "Authentification requise. Veuillez vous reconnecter.";
  if (status === 403) return "Accès refusé : droits insuffisants.";
  if (status === 404) return "Ressource introuvable.";
  if (status === 409) return "Opération impossible dans l'état actuel.";
  if (status >= 500) return "Le service est indisponible, réessayez.";
  return "Une erreur est survenue, réessayez.";
}

export async function apiFetch(path, options = {}) {
  // `authRedirect` (défaut true) : sur 401, purge le jeton et renvoie
  // vers l'écran de connexion. Les appels de login s'en passent (false)
  // pour afficher l'erreur sans recharger la page.
  const { authRedirect = true, ...fetchOptions } = options;
  const headers = { "Content-Type": "application/json", ...(fetchOptions.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`/api${path}`, { ...fetchOptions, headers });
  } catch (networkErr) {
    // Erreur réseau / service injoignable : message lisible, détail en console.
    console.error(`[api] réseau ${path}:`, networkErr);
    const err = new Error("Le service est indisponible, réessayez.");
    err.status = 0;
    throw err;
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* réponse sans corps JSON (ex. index.html du serveur de dev) */
    console.error(`[api] réponse non-JSON ${res.status} pour ${path}`);
  }

  if (!res.ok) {
    // Session expirée / jeton invalide : retour à l'écran de connexion.
    if (res.status === 401 && authRedirect) {
      setToken(null);
      if (window.location.pathname !== "/") window.location.assign("/");
    }
    const err = new Error(userMessage(data, res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  // Garde-fou : une réponse 200 non-JSON (proxy absent) ne doit pas
  // être interprétée comme une donnée métier.
  if (data === null) {
    console.error(`[api] corps vide pour ${path}`);
    const err = new Error("Le service est indisponible, réessayez.");
    err.status = res.status;
    throw err;
  }
  return data;
}

// Montants : millimes (bigint) <-> DT. Jamais de flottant pour le stockage.
// Implémentation dans utils/money.js (parsing par chaîne + BigInt),
// ré-exportée ici pour compatibilité avec les pages existantes.
export { dtToMillimes, formatMillimes } from "./utils/money";
