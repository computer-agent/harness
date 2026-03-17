import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useAuthStore } from "@/stores/auth";
import { TokenEntry } from "./TokenEntry";

export function AuthGuard({ children }: { children: ReactNode }) {
  const { isAuthenticated, isReady, isValidating, error } = useAuth();
  const { setToken, validate, clearToken } = useAuthStore();

  if (!isReady) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <TokenEntry
        onSubmit={async (token) => {
          setToken(token);
          const valid = await validate();
          if (!valid) clearToken();
        }}
        isValidating={isValidating}
        error={error}
      />
    );
  }

  return <>{children}</>;
}
