import { Globe, Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "@/hooks/useTheme";

const themeIcons = {
  dark: Moon,
  light: Sun,
  system: Monitor,
};

export function AppShell({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { theme, cycleTheme } = useTheme();
  const ThemeIcon = themeIcons[theme];

  const toggleLang = () => {
    const next = i18n.language === "pt-BR" ? "en" : "pt-BR";
    i18n.changeLanguage(next);
    localStorage.setItem("mastersof-ai-lang", next);
    document.documentElement.lang = next;
  };

  return (
    <div className="flex h-dvh flex-col">
      {/* Top bar */}
      <header className="safe-area-top flex items-center justify-between border-b border-border px-4 py-2">
        <h1 className="text-sm font-semibold">{t("app.title")}</h1>
        <div className="flex items-center gap-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={toggleLang} aria-label="Language">
                  <Globe className="h-4 w-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{i18n.language === "pt-BR" ? "English" : "Portugu\u00eas"}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={cycleTheme} aria-label={t(`theme.${theme}`)}>
                  <ThemeIcon className="h-4 w-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t(`theme.${theme}`)}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </header>

      {/* Content */}
      <main className="flex flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
