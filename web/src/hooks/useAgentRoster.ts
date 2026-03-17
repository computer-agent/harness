import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AgentInfo } from "@/types";

export function useAgentRoster() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.get<AgentInfo[]>("/api/agents");
      setAgents(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch_();
  }, [fetch_]);

  return { agents, isLoading, error, refetch: fetch_ };
}
