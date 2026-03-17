import { useEffect, useState } from "react";
import { SKIP_AUTH } from "@/lib/constants";
import { useAuthStore } from "@/stores/auth";

export function useAuth() {
  const { token, isValidated, isValidating, error, validate, setToken, clearToken } = useAuthStore();
  const [isReady, setIsReady] = useState(false);

  // On mount: validate existing token from sessionStorage
  useEffect(() => {
    if (SKIP_AUTH) {
      setIsReady(true);
      return;
    }
    if (token && !isValidated) {
      validate().then((valid) => {
        setIsReady(true);
        if (!valid) clearToken();
      });
    } else {
      setIsReady(true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    // Only authenticated after server confirms the token
    isAuthenticated: SKIP_AUTH || (!!token && isValidated),
    isReady,
    isValidating,
    error,
    setToken,
    clearToken,
    validate,
  };
}
