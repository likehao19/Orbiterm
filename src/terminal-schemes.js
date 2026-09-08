const XTERM_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

export const DEFAULT_TERMINAL_SCHEME_ID = "orbiterm-dark";

const TERMINAL_SCHEMES = [
  {
    id: "orbiterm-dark",
    name: "Dark Terminal",
    nameZh: "深色终端",
    software: true,
    tone: "dark",
    foreground: "#c3cede",
    background: "#07080a",
    cursor: "#22d3ee",
    cursorAccent: "#07080a",
    selection: "rgba(56, 189, 248, 0.26)",
    colors: [
      "#07080a", "#f87171", "#34d399", "#fbbf24",
      "#60a5fa", "#a78bfa", "#22d3ee", "#c3cede",
      "#5d6b80", "#f87171", "#34d399", "#fbbf24",
      "#60a5fa", "#a78bfa", "#22d3ee", "#e8eef7",
    ],
  },
  {
    id: "orbiterm-light",
    name: "Light Terminal",
    nameZh: "浅色终端",
    software: true,
    tone: "light",
    foreground: "#15202b",
    background: "#fafbfd",
    cursor: "#0891b2",
    cursorAccent: "#fafbfd",
    selection: "rgba(2, 132, 199, 0.22)",
    colors: [
      "#0b1220", "#b91c1c", "#166534", "#b45309",
      "#1d4ed8", "#6d28d9", "#0e7490", "#15202b",
      "#5b6573", "#dc2626", "#15803d", "#c2410c",
      "#1d4ed8", "#6d28d9", "#0e7490", "#0b1220",
    ],
  },
  {
    id: "dracula",
    name: "Dracula",
    tone: "dark",
    foreground: "#f8f8f2",
    background: "#282a36",
    cursor: "#f8f8f2",
    cursorAccent: "#282a36",
    selection: "rgba(68, 71, 90, 0.72)",
    colors: [
      "#21222c", "#ff5555", "#50fa7b", "#f1fa8c",
      "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
      "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5",
      "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
    ],
  },
  {
    id: "nord",
    name: "Nord",
    tone: "dark",
    foreground: "#d8dee9",
    background: "#2e3440",
    cursor: "#d8dee9",
    cursorAccent: "#2e3440",
    selection: "rgba(67, 76, 94, 0.72)",
    colors: [
      "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b",
      "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
      "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b",
      "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4",
    ],
  },
  {
    id: "one-dark",
    name: "One Dark",
    tone: "dark",
    foreground: "#abb2bf",
    background: "#282c34",
    cursor: "#528bff",
    cursorAccent: "#282c34",
    selection: "rgba(62, 68, 81, 0.78)",
    colors: [
      "#282c34", "#e06c75", "#98c379", "#e5c07b",
      "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
      "#5c6370", "#e06c75", "#98c379", "#e5c07b",
      "#61afef", "#c678dd", "#56b6c2", "#ffffff",
    ],
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    tone: "dark",
    foreground: "#839496",
    background: "#002b36",
    cursor: "#93a1a1",
    cursorAccent: "#002b36",
    selection: "rgba(7, 54, 66, 0.85)",
    colors: [
      "#073642", "#dc322f", "#859900", "#b58900",
      "#268bd2", "#d33682", "#2aa198", "#eee8d5",
      "#586e75", "#cb4b16", "#586e75", "#657b83",
      "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
    ],
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    tone: "light",
    foreground: "#657b83",
    background: "#fdf6e3",
    cursor: "#586e75",
    cursorAccent: "#fdf6e3",
    selection: "rgba(238, 232, 213, 0.9)",
    colors: [
      "#073642", "#dc322f", "#859900", "#b58900",
      "#268bd2", "#d33682", "#2aa198", "#eee8d5",
      "#002b36", "#cb4b16", "#586e75", "#657b83",
      "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
    ],
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    tone: "dark",
    foreground: "#ebdbb2",
    background: "#282828",
    cursor: "#ebdbb2",
    cursorAccent: "#282828",
    selection: "rgba(80, 73, 69, 0.78)",
    colors: [
      "#282828", "#cc241d", "#98971a", "#d79921",
      "#458588", "#b16286", "#689d6a", "#a89984",
      "#928374", "#fb4934", "#b8bb26", "#fabd2f",
      "#83a598", "#d3869b", "#8ec07c", "#ebdbb2",
    ],
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    tone: "dark",
    foreground: "#cdd6f4",
    background: "#1e1e2e",
    cursor: "#f5e0dc",
    cursorAccent: "#1e1e2e",
    selection: "rgba(69, 71, 90, 0.78)",
    colors: [
      "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af",
      "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
      "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af",
      "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
    ],
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    tone: "light",
    foreground: "#4c4f69",
    background: "#eff1f5",
    cursor: "#dc8a78",
    cursorAccent: "#eff1f5",
    selection: "rgba(172, 176, 190, 0.45)",
    colors: [
      "#5c5f77", "#d20f39", "#40a02b", "#df8e1d",
      "#1e66f5", "#ea76cb", "#179299", "#acb0be",
      "#6c6f85", "#d20f39", "#40a02b", "#df8e1d",
      "#1e66f5", "#ea76cb", "#179299", "#bcc0cc",
    ],
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    tone: "dark",
    foreground: "#c0caf5",
    background: "#1a1b26",
    cursor: "#c0caf5",
    cursorAccent: "#1a1b26",
    selection: "rgba(51, 52, 76, 0.82)",
    colors: [
      "#15161e", "#f7768e", "#9ece6a", "#e0af68",
      "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
      "#414868", "#f7768e", "#9ece6a", "#e0af68",
      "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
    ],
  },
  {
    id: "monokai",
    name: "Monokai",
    tone: "dark",
    foreground: "#f8f8f2",
    background: "#272822",
    cursor: "#f8f8f0",
    cursorAccent: "#272822",
    selection: "rgba(73, 72, 62, 0.82)",
    colors: [
      "#272822", "#f92672", "#a6e22e", "#f4bf75",
      "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2",
      "#75715e", "#f92672", "#a6e22e", "#f4bf75",
      "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5",
    ],
  },
];

const SCHEME_BY_ID = new Map(TERMINAL_SCHEMES.map((scheme) => [scheme.id, scheme]));

export function listTerminalSchemes() {
  return TERMINAL_SCHEMES;
}

export function isTerminalSchemeId(id) {
  return SCHEME_BY_ID.has(id);
}

export function isSoftwareTerminalScheme(id) {
  return id === "orbiterm-light" || id === "orbiterm-dark";
}

export function softwareTerminalSchemeId(appTone) {
  return appTone === "light" ? "orbiterm-light" : "orbiterm-dark";
}

function appToneFromPreferences(preferences = {}) {
  if (preferences.appTheme === "light" || preferences.appTheme === "dark") return preferences.appTheme;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTerminalSchemeId(preferences = {}) {
  if (isTerminalSchemeId(preferences.terminalScheme)) return preferences.terminalScheme;
  return softwareTerminalSchemeId(appToneFromPreferences(preferences));
}

export function getTerminalScheme(id) {
  return SCHEME_BY_ID.get(id) || SCHEME_BY_ID.get(DEFAULT_TERMINAL_SCHEME_ID);
}

export function schemeDisplayName(scheme, language = "zh-CN") {
  return language === "en-US" ? scheme.name : (scheme.nameZh || scheme.name);
}

export function schemeToXtermTheme(scheme) {
  const theme = {
    background: scheme.background,
    foreground: scheme.foreground,
    cursor: scheme.cursor,
    cursorAccent: scheme.cursorAccent || scheme.background,
    selectionBackground: scheme.selection,
    selectionInactiveBackground: scheme.selection,
    selectionForeground: scheme.foreground,
  };
  XTERM_KEYS.forEach((key, index) => {
    theme[key] = scheme.colors[index];
  });
  return theme;
}

export function schemeAnsiColors() {
  return {
    dim: "\x1b[90m",
    green: "\x1b[32m",
    cyan: "\x1b[36m",
    blue: "\x1b[34m",
    amber: "\x1b[33m",
    red: "\x1b[31m",
    violet: "\x1b[35m",
    bold: "\x1b[1m",
    reset: "\x1b[0m",
  };
}

export function schemePreviewColors(scheme) {
  return [scheme.background, scheme.colors[1], scheme.colors[2], scheme.colors[3], scheme.colors[4], scheme.colors[5], scheme.colors[6], scheme.foreground];
}

export function schemeSample(scheme) {
  return {
    background: scheme.background,
    foreground: scheme.foreground,
    user: scheme.colors[2],
    host: scheme.colors[6],
    path: scheme.colors[4],
    dim: scheme.colors[8],
  };
}
