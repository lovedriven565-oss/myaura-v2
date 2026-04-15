/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from "react-router-dom";
import Home from "./pages/Home";
import UploadFree from "./pages/UploadFree";
import UploadPremium from "./pages/UploadPremium";
import Processing from "./pages/Processing";
import Result from "./pages/Result";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";

function StateRecoveryWrapper({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const uid = (window as any).Telegram?.WebApp?.initDataUnsafe?.user?.id;
    const key = uid ? `myaura_active_gen_${uid}` : "myaura_active_gen";
    const activeId = localStorage.getItem(key);

    if (!activeId) {
      setChecking(false);
      return;
    }

    // Skip redirect if already on processing or result
    if (location.pathname.startsWith('/processing/') || location.pathname.startsWith('/result/')) {
      setChecking(false);
      return;
    }

    // Validate the active session against the backend
    const statusUrl = uid ? `/api/status/${activeId}?tgUserId=${uid}` : `/api/status/${activeId}`;
    fetch(statusUrl)
      .then(async r => {
        if (r.status === 403 || r.status === 404) {
          localStorage.removeItem(key);
          return null;
        }
        return r.json();
      })
      .then(d => {
        if (!d) {
          setChecking(false);
          return;
        }
        if (d.status === "processing" || d.status === "pending") {
          navigate(`/processing/${activeId}`, { replace: true });
        } else if (d.status === "completed" || d.status === "partial") {
          navigate(`/result/${activeId}`, { replace: true });
        } else {
          localStorage.removeItem(key);
          setChecking(false);
        }
      })
      .catch(() => {
        localStorage.removeItem(key);
        setChecking(false);
      });
  }, [navigate, location.pathname]);

  if (checking && !location.pathname.startsWith('/processing/') && !location.pathname.startsWith('/result/')) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#c084fc] border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  return <>{children}</>;
}

function AuthWrapper({ children }: { children: ReactNode }) {
  const [isReady, setIsReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const initAuth = async () => {
      try {
        const tg = (window as any).Telegram?.WebApp;
        if (tg) tg.ready();
        
        const user = tg?.initDataUnsafe?.user;
        if (!user || !user.id) {
          setAuthError("No Telegram user data found. Please open via Telegram Mini App.");
          return;
        }

        // Attempt to upsert the user
        const res = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            telegramId: user.id,
            username: user.username,
            firstName: user.first_name,
            lastName: user.last_name
          })
        });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(JSON.stringify(errData));
        }

        const data = await res.json();
        const genKey = user.id ? `myaura_active_gen_${user.id}` : "myaura_active_gen";
        
        if (data.activeGenerationId) {
          localStorage.setItem(genKey, data.activeGenerationId);
        } else {
          // Clean up old phantom states
          localStorage.removeItem(genKey);
        }

        setIsReady(true);
      } catch (err: any) {
        console.error("Failed to initialize user in DB", err);
        setAuthError(`Auth Error: ${err.message}`);
      }
    };

    initAuth();
  }, []);

  if (authError) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-6 text-center">
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-xl text-sm break-words max-w-md">
          {authError}
        </div>
      </div>
    );
  }

  if (!isReady) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#c084fc] border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <AuthWrapper>
      <BrowserRouter>
        <Routes>
          <Route element={<StateRecoveryWrapper><Home /></StateRecoveryWrapper>} path="/" />
          <Route element={<StateRecoveryWrapper><UploadFree /></StateRecoveryWrapper>} path="/upload" />
          <Route element={<StateRecoveryWrapper><UploadPremium /></StateRecoveryWrapper>} path="/premium" />
          <Route element={<Processing />} path="/processing/:id" />
          <Route element={<Result />} path="/result/:id" />
          <Route element={<Privacy />} path="/privacy" />
          <Route element={<Terms />} path="/terms" />
        </Routes>
      </BrowserRouter>
    </AuthWrapper>
  );
}
