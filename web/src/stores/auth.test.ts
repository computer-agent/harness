import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "./auth";

function resetStore() {
  useAuthStore.setState({
    token: null,
    isValidated: false,
    isValidating: false,
    error: null,
  });
}

describe("useAuthStore", () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("initial state", () => {
    it("starts with no token and not validated", () => {
      const { token, isValidated, isValidating, error } = useAuthStore.getState();
      expect(token).toBeNull();
      expect(isValidated).toBe(false);
      expect(isValidating).toBe(false);
      expect(error).toBeNull();
    });
  });

  describe("setToken", () => {
    it("stores the token in state and sessionStorage", () => {
      useAuthStore.getState().setToken("my-secret-token");
      expect(useAuthStore.getState().token).toBe("my-secret-token");
      expect(sessionStorage.getItem("mastersof-ai-token")).toBe("my-secret-token");
    });

    it("clears any existing error", () => {
      useAuthStore.setState({ error: "invalidToken" });
      useAuthStore.getState().setToken("new-token");
      expect(useAuthStore.getState().error).toBeNull();
    });

    it("resets isValidated so the token must be re-validated", () => {
      useAuthStore.setState({ isValidated: true });
      useAuthStore.getState().setToken("new-token");
      expect(useAuthStore.getState().isValidated).toBe(false);
    });
  });

  describe("clearToken", () => {
    it("removes the token from state and sessionStorage", () => {
      useAuthStore.getState().setToken("to-clear");
      useAuthStore.getState().clearToken();
      expect(useAuthStore.getState().token).toBeNull();
      expect(sessionStorage.getItem("mastersof-ai-token")).toBeNull();
    });

    it("resets validated state and error", () => {
      useAuthStore.setState({ isValidated: true, error: "invalidToken" });
      useAuthStore.getState().clearToken();
      expect(useAuthStore.getState().isValidated).toBe(false);
      expect(useAuthStore.getState().error).toBeNull();
    });
  });

  describe("validate", () => {
    it("returns false when no token is set", async () => {
      const result = await useAuthStore.getState().validate();
      expect(result).toBe(false);
    });

    it("validates successfully when API returns ok", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "researcher" }]), { status: 200 }),
      );

      useAuthStore.getState().setToken("valid-token");
      const result = await useAuthStore.getState().validate();

      expect(result).toBe(true);
      expect(useAuthStore.getState().isValidated).toBe(true);
      expect(useAuthStore.getState().isValidating).toBe(false);
      expect(useAuthStore.getState().error).toBeNull();
    });

    it("sets error when API returns failure", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));

      useAuthStore.getState().setToken("bad-token");
      const result = await useAuthStore.getState().validate();

      expect(result).toBe(false);
      expect(useAuthStore.getState().isValidated).toBe(false);
      expect(useAuthStore.getState().isValidating).toBe(false);
      expect(useAuthStore.getState().error).toBe("invalidToken");
    });

    it("sets isValidating during the request", async () => {
      let resolveRequest: ((value: Response) => void) | undefined;
      const pending = new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      });
      vi.spyOn(globalThis, "fetch").mockReturnValueOnce(pending);

      useAuthStore.getState().setToken("token");
      const validatePromise = useAuthStore.getState().validate();

      expect(useAuthStore.getState().isValidating).toBe(true);

      resolveRequest?.(new Response(JSON.stringify([]), { status: 200 }));
      await validatePromise;

      expect(useAuthStore.getState().isValidating).toBe(false);
    });
  });
});
