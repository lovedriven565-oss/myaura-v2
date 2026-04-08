/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import UploadFree from "./pages/UploadFree";
import UploadPremium from "./pages/UploadPremium";
import Processing from "./pages/Processing";
import Result from "./pages/Result";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";

function AuthWrapper({ children }: { children: React.ReactNode }) {
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
          <Route path="/" element={<Home />} />
          <Route path="/upload" element={<UploadFree />} />
          <Route path="/premium" element={<UploadPremium />} />
          <Route path="/processing/:id" element={<Processing />} />
          <Route path="/result/:id" element={<Result />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
        </Routes>
      </BrowserRouter>
    </AuthWrapper>
  );
}
