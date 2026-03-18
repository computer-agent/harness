import { describe, expect, it } from "vitest";
import { API_URL, SKIP_AUTH, THEME_KEY, TOKEN_KEY, WS_URL } from "./constants";

describe("constants", () => {
  describe("API_URL", () => {
    it("falls back to empty string when VITE_API_URL is not set", () => {
      // In the test environment, VITE_API_URL is not set, so API_URL should be ""
      expect(API_URL).toBe("");
    });
  });

  describe("WS_URL", () => {
    it("derives a websocket URL when VITE_WS_URL is not set", () => {
      // jsdom defaults to http: protocol and localhost, so we expect ws://
      expect(WS_URL).toMatch(/^wss?:\/\//);
      expect(WS_URL).toContain("/ws");
    });
  });

  describe("SKIP_AUTH", () => {
    it("defaults to false when VITE_SKIP_AUTH is not set", () => {
      expect(SKIP_AUTH).toBe(false);
    });
  });

  describe("static keys", () => {
    it("TOKEN_KEY is a stable string", () => {
      expect(TOKEN_KEY).toBe("mastersof-ai-token");
    });

    it("THEME_KEY is a stable string", () => {
      expect(THEME_KEY).toBe("mastersof-ai-theme");
    });
  });
});
