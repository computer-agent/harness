import { useUiStore } from "@/stores/ui";

export function useTheme() {
  const { theme, cycleTheme, setTheme } = useUiStore();
  return { theme, cycleTheme, setTheme };
}
