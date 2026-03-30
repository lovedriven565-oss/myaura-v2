/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import UploadFree from "./pages/UploadFree";
import UploadPremium from "./pages/UploadPremium";
import Processing from "./pages/Processing";
import Result from "./pages/Result";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";

export default function App() {
  return (
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
  );
}
