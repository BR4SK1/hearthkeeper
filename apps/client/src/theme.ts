import { createTheme } from "@mui/material/styles";

/**
 * The hearthkeeper campfire-dark theme: deep ember browns on near-black, with
 * a campfire-orange highlight. Type scales for the TV first (the display is
 * a large screen across the room), with clamps that bring it back down on
 * phones acting as controllers.
 */
export const hearthkeeperTheme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#ff8c1a", contrastText: "#1a120b" },
    secondary: { main: "#ffb347", contrastText: "#2a1c0e" },
    background: { default: "#141110", paper: "#1e1813" },
    text: { primary: "#f3e9dc", secondary: "#c9b8a6" },
    divider: "#3a2f24",
  },
  typography: {
    fontFamily:
      'ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    h1: { fontSize: "clamp(2.5rem, 6vw, 4.5rem)" },
    body1: { fontSize: "1.05rem" },
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: { textTransform: "none", borderRadius: 10 },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: "none" },
      },
    },
  },
});
