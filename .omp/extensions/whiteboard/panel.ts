// whiteboard panel - the floating board view.
//
// ONE view: a floating overlay (ctx.ui.custom({ overlay: true })) that grabs
// focus, scrolls, and closes on Esc/q, leaving the chat byte-for-byte untouched.
// It is pure TUI = ZERO context tokens; boards reach the model only via the
// whiteboard_* tools. Renders live from disk each paint, and while open it
// watches the selected scoped file so an editor `:w` or tool edit refreshes.
//
// No value-import of "@oh-my-pi/pi-coding-agent" (a user-dir extension cannot
// resolve it at runtime); the overlay is a duck-typed { render, handleInput,
// dispose } object, exactly as omp's autoresearch overlay is.
// @ts-nocheck
import { watch } from "node:fs";
import { read as readBoard } from "./board.ts";

const boardLines = (filePath: string) => {
  const b = readBoard(filePath).trim();
  return b ? b.split("\n") : ["# Whiteboard", "(empty - /wb add <text>, or /wb -e to edit)"];
};

// Open the floating board. Focus-grabbing, scrollable, Esc/q closes. Live-reloads
// while open via a file watch that re-renders on change.
export async function showBoard(ctx, filePath: string, label = "whiteboard") {
  if (!ctx?.hasUI) return;
  return await ctx.ui.custom(
    (tui, theme, _kb, done) => {
      let scroll = 0;
      const dim = (s) => (theme?.fg ? theme.fg("dim", s) : s);
      const accent = (s) => (theme?.fg ? theme.fg("accent", s) : s);
      const viewport = () => Math.max(4, (process.stdout.rows ?? 40) - 4);

      let reloadTimer;
      let watcher;
      try {
        watcher = watch(filePath, () => {
          clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => tui?.requestRender?.(), 100);
        });
      } catch { /* file may not exist yet; render still works */ }

      return {
        render(_width) {
          const lines = boardLines(filePath);
          const vp = viewport();
          const maxScroll = Math.max(0, lines.length - vp);
          if (scroll > maxScroll) scroll = maxScroll;
          const title = accent(`  whiteboard:${label} `) + dim("- j/k ↑/↓ scroll · g/G top/bottom · e edit · Esc/q close");
          const shown = lines.slice(scroll, scroll + vp).map(l => "  " + l);
          const pos = maxScroll > 0 ? [dim(`  [${scroll + 1}-${Math.min(scroll + vp, lines.length)} of ${lines.length}]`)] : [];
          return [title, "", ...shown, ...pos];
        },
        handleInput(data) {
          const lines = boardLines(filePath);
          const vp = viewport();
          const maxScroll = Math.max(0, lines.length - vp);
          if (data === "\x1b" || data === "\x1b[27u" || data === "q") { done("close"); return; }
          if (data === "e") { done("edit"); return; }
          if (data === "\x1b[A" || data === "k") scroll = Math.max(0, scroll - 1);
          else if (data === "\x1b[B" || data === "j") scroll = Math.min(maxScroll, scroll + 1);
          else if (data === "\x1b[5~") scroll = Math.max(0, scroll - vp);
          else if (data === "\x1b[6~") scroll = Math.min(maxScroll, scroll + vp);
          else if (data === "g") scroll = 0;
          else if (data === "G") scroll = maxScroll;
          tui?.requestRender?.();
        },
        invalidate() {},
        dispose() { try { watcher?.close(); } catch {} },
      };
    },
    { overlay: true },
  );
}
