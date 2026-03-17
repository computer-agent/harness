import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { Toaster } from "sonner";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { AppShell } from "@/components/layout/AppShell";
import { Skeleton } from "@/components/ui/skeleton";

const AgentGrid = lazy(() => import("@/components/agents/AgentGrid").then((m) => ({ default: m.AgentGrid })));
const AgentView = lazy(() => import("@/components/layout/AgentView").then((m) => ({ default: m.AgentView })));

function PageFallback() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Skeleton className="h-8 w-48" />
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthGuard>
        <AppShell>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/" element={<AgentGrid />} />
              <Route path="/agent/:agentId" element={<AgentView />} />
              <Route path="/agent/:agentId/new" element={<AgentView isNew />} />
              <Route path="/agent/:agentId/session/:sessionId" element={<AgentView />} />
            </Routes>
          </Suspense>
        </AppShell>
      </AuthGuard>
      <Toaster position="top-center" richColors />
    </BrowserRouter>
  );
}
