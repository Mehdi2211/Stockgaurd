import { useCallback, useState } from "react";
import { apiFetch } from "../api";

// Nombre de scans conservés pour l'affichage.
const MAX_RECENT = 8;

// Hook de scan : enregistre chaque code-barres via POST /api/scans et
// conserve les derniers scans pour l'affichage.
//
// `onBarcodeDetected(barcode)` est le point d'entrée UNIQUE : le lecteur
// USB (qui se comporte comme un clavier) l'appelle aujourd'hui, le futur
// module caméra l'appellera sans refonte.
export function useScan() {
  const [recent, setRecent] = useState([]);
  const [error,  setError]  = useState("");

  const onBarcodeDetected = useCallback(async (barcode) => {
    const code = typeof barcode === "string" ? barcode.trim() : "";
    if (code === "") return null;

    setError("");
    try {
      const data = await apiFetch("/scans", {
        method: "POST",
        body: JSON.stringify({ barcode: code }),
      });
      const entry = {
        key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        barcode: code,
        status: data.status,
        quantity: data.scan?.quantity ?? 1,
        product: data.product || null,
        at: new Date().toISOString(),
      };
      setRecent((prev) => [entry, ...prev].slice(0, MAX_RECENT));
      return data;
    } catch (err) {
      setError(err.message || "Scan impossible.");
      return null;
    }
  }, []);

  return { recent, error, onBarcodeDetected };
}
