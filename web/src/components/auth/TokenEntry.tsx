import { Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { VALID_AUTH_ERROR_KEYS } from "@/stores/auth";

interface TokenEntryProps {
  onSubmit: (token: string) => void;
  isValidating: boolean;
  error: string | null;
}

export function TokenEntry({ onSubmit, isValidating, error }: TokenEntryProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim() && !isValidating) {
      onSubmit(value.trim());
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="mb-2 text-4xl">&#x1f916;</div>
          <h1 className="text-xl font-semibold">{t("app.title")}</h1>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" aria-label={t("app.title")}>
            <label htmlFor="token-input" className="sr-only">
              {t("auth.tokenPlaceholder")}
            </label>
            <Input
              id="token-input"
              ref={inputRef}
              type="password"
              placeholder={t("auth.tokenPlaceholder")}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={isValidating}
              autoComplete="off"
              aria-describedby={error ? "token-error" : undefined}
            />
            <Button type="submit" className="w-full" disabled={!value.trim() || isValidating}>
              {isValidating ? (
                <>
                  <Loader2 className="animate-spin" />
                  {t("auth.validating")}
                </>
              ) : (
                t("auth.continue")
              )}
            </Button>
            {error && (
              <Alert variant="destructive" role="alert" id="token-error">
                <AlertDescription>
                  {t(`auth.${(VALID_AUTH_ERROR_KEYS as readonly string[]).includes(error) ? error : "invalidToken"}`)}
                </AlertDescription>
              </Alert>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
