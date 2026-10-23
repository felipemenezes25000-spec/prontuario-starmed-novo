import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { RxVerifyPage } from './pages/RxVerify';
import './styles.css';
// Rota PÚBLICA de verificação de receita (030): não passa pelo login do App.
const rxVerify=/^\/verificar\/([A-Za-z0-9_-]{22,64})\/?$/.exec(window.location.pathname);
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{rxVerify?<RxVerifyPage token={rxVerify[1]}/>:<App/>}</React.StrictMode>);
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(()=>{});
}
