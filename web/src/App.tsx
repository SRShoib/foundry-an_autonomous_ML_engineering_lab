import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { useState, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { ApiClientContext } from "./api/ApiClientContext";
import { api, type ApiClient } from "./api/client";
import { createQueryClient } from "./api/queryClient";
import { ThemeProvider } from "./app/ThemeProvider";
import { EvalRoute } from "./routes/EvalRoute";
import { LiveRunRoute } from "./routes/LiveRunRoute";
import { NotFoundRoute } from "./routes/NotFoundRoute";
import { ReplayRoute } from "./routes/ReplayRoute";
import { ReportRoute } from "./routes/ReportRoute";
import { RunsHomeRoute } from "./routes/RunsHomeRoute";
import { ROUTES } from "./routes/routes";

/** Everything a screen needs that is not routing. `reducedMotion="user"` makes every Motion
 * animation honour prefers-reduced-motion — the transform and layout ones become instant, which
 * is docs/design-plan.md §7's "no motion is removed silently; the information is still there". */
export function AppProviders({
  children,
  queryClient,
  apiClient = api,
}: {
  children: ReactNode;
  queryClient?: QueryClient;
  apiClient?: ApiClient;
}) {
  const [defaultClient] = useState(createQueryClient);
  return (
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <QueryClientProvider client={queryClient ?? defaultClient}>
          <ApiClientContext value={apiClient}>{children}</ApiClientContext>
        </QueryClientProvider>
      </ThemeProvider>
    </MotionConfig>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path={ROUTES.home} element={<Navigate to={ROUTES.runs} replace />} />
      <Route path={ROUTES.runs} element={<RunsHomeRoute />} />
      <Route path={ROUTES.run} element={<LiveRunRoute />} />
      <Route path={ROUTES.report} element={<ReportRoute />} />
      <Route path={ROUTES.replay} element={<ReplayRoute />} />
      <Route path={ROUTES.eval} element={<EvalRoute />} />
      <Route path="*" element={<NotFoundRoute />} />
    </Routes>
  );
}

export function App() {
  return (
    <AppProviders>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProviders>
  );
}
