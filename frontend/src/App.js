import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { KioskProvider } from './context/KioskContext';
import KioskLogin        from './pages/KioskLogin';
import CashierPOS        from './pages/CashierPOS';
import OwnerDashboard    from './pages/OwnerDashboard';
import ProductManagement from './pages/ProductManagement';
import CreditManagement  from './pages/CreditManagement';
import SalesHistory      from './pages/SalesHistory';
import StockManagement   from './pages/StockManagement';
import CashRegister      from './pages/CashRegister';
import CreditRepayment   from './pages/CreditRepayment';
import NotFound          from './pages/NotFound';

function App() {
  return (
    <KioskProvider>
      <Router>
        <Routes>
          <Route path='/'               element={<KioskLogin />} />
          <Route path='/caisse'         element={<CashierPOS />} />
          <Route path='/owner'          element={<OwnerDashboard />} />
          <Route path='/owner/produits' element={<ProductManagement />} />
          <Route path='/owner/credits'  element={<CreditManagement />} />
          <Route path='/owner/ventes'   element={<SalesHistory />} />
          <Route path='/owner/cash-register' element={<CashRegister />} />
          <Route path='/credits/repayment' element={<CreditRepayment />} />
          <Route path='/owner/stock'    element={<StockManagement />} />
          <Route path='/404'            element={<NotFound />} />
          <Route path='*'               element={<Navigate to='/404' replace />} />
        </Routes>
      </Router>
    </KioskProvider>
  );
}

export default App;