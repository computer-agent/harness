import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { SessionInfo } from "@/types";

export function useSessions(agentId: string | undefined) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    if (!agentId) return;
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.get<SessionInfo[]>(`/api/sessions?agent=${agentId}`);
      setSessions(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    fetch_();
  }, [fetch_]);

  const createSession = useCallback(
    async (agentIdOverride?: string) => {
      const id = agentIdOverride ?? agentId;
      if (!id) throw new Error("No agent ID");
      const session = await api.post<SessionInfo>("/api/sessions", { agent: id });
      setSessions((prev) => [session, ...prev]);
      return session;
    },
    [agentId],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      if (!agentId) return;
      await api.delete(`/api/sessions/${sessionId}?agent=${agentId}`);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    },
    [agentId],
  );

  return { sessions, isLoading, error, refetch: fetch_, createSession, deleteSession };
}
