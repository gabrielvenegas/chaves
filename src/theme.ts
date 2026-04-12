export type ThemeName = "warm" | "slate" | "forest";

export interface ThemeDefinition {
  name: ThemeName;
  label: string;
  background: string;
  panel: string;
  panelAlt: string;
  border: string;
  muted: string;
  text: string;
  user: string;
  assistant: string;
  system: string;
  progress: string;
  status: string;
  track: string;
  cursor: string;
}

export const THEMES: Record<ThemeName, ThemeDefinition> = {
  warm: {
    name: "warm",
    label: "Warm",
    background: "#1f1d1c",
    panel: "#262220",
    panelAlt: "#2d2724",
    border: "#5a4a3d",
    muted: "#8f7d6d",
    text: "#f1ddbf",
    user: "#c5aa92",
    assistant: "#f4bc69",
    system: "#c8d35a",
    progress: "#eab676",
    status: "#ff9b3d",
    track: "#312a26",
    cursor: "#fff3d6",
  },
  slate: {
    name: "slate",
    label: "Slate",
    background: "#171c22",
    panel: "#1e252d",
    panelAlt: "#242d37",
    border: "#4b5c6f",
    muted: "#93a1b1",
    text: "#dce7f2",
    user: "#a4bad2",
    assistant: "#8ec5ff",
    system: "#9fd6ad",
    progress: "#79c1d9",
    status: "#8ec5ff",
    track: "#29333d",
    cursor: "#eef6ff",
  },
  forest: {
    name: "forest",
    label: "Forest",
    background: "#171d1b",
    panel: "#202824",
    panelAlt: "#28312c",
    border: "#4d6358",
    muted: "#92a69a",
    text: "#dbe9de",
    user: "#b6cfa8",
    assistant: "#8fd3b0",
    system: "#d3d28f",
    progress: "#9fd8c3",
    status: "#8fd3b0",
    track: "#2b3530",
    cursor: "#edfff3",
  },
};

export const THEME_OPTIONS = Object.values(THEMES).map((theme) => ({
  id: theme.name,
  label: theme.label,
}));

export function isThemeName(value: string): value is ThemeName {
  return value === "warm" || value === "slate" || value === "forest";
}

