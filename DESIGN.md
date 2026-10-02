---
name: Airlink Installer
description: Flight-deck terminal UI for installing and uninstalling the Airlink panel and daemon
colors:
  bg: "#1a1b26"
  panel: "#20222e"
  panel-alt: "#252733"
  border: "#ffffff"
  fg: "#c0caf5"
  dim: "#565f89"
  accent: "#7aa2f7"
  green: "#9ece6a"
  red: "#f7768e"
  yellow: "#e0af68"
typography:
  body:
    fontFamily: "monospace (terminal cell grid)"
    lineHeight: 1
  pane-title:
    fontFamily: "monospace (terminal cell grid)"
    fontWeight: 400
    lineHeight: 1
spacing:
  cell: "1 cell"
  inset: "2 cells"
components:
  menu-item:
    textColor: "{colors.fg}"
    typography: "{typography.body}"
  menu-item-selected:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.bg}"
    typography: "{typography.body}"
  pane:
    backgroundColor: "{colors.panel}"
    padding: "1 cell 1 cell"
  pane-title:
    textColor: "{colors.accent}"
    typography: "{typography.pane-title}"
  step-done:
    textColor: "{colors.green}"
    typography: "{typography.body}"
  step-running:
    textColor: "{colors.accent}"
    typography: "{typography.body}"
  step-failed:
    textColor: "{colors.red}"
    typography: "{typography.body}"
  step-pending:
    textColor: "{colors.dim}"
    typography: "{typography.body}"
---

# Design System: Airlink Installer

## Overview

**Creative North Star: "The Flight Deck"**

The installer is a flight deck, not a wizard: one menu, then a split view where every action the system takes is visible as it happens. It refuses the category-default pattern of silent spinner + "Installation complete!" that hides which command failed. The operator always sees three things — what is running right now (steps pane), what the running command actually printed (logs pane), and what remains to be done by hand (summary). The visual world is inherited wholesale from the pinned reference installer (Miserable_Xfce): a Tokyo-night palette on a near-black ground, boxed panes with 1-cell borders and lowercase mono titles, an ASCII banner wordmark, and state carried by glyphs first.

Density is deliberately high and layout is ruthlessly height-tiered: the design must fit an 80×24 terminal — the minimum viewport — without scrolling, on any tier, at any moment of the flow. Airlink's own identity enters as the byte-exact banner supplied by the user plus one accent title line naming the product; everything else — system language, icons, spinner, palette — stays identical to the inherited world.

**Key Characteristics:**

- State is never color-only: the icon (`○ ▸ ✓ ✗ ⊘`) carries it, color reinforces it — never emoji.
- One screen at a time; destructive and even constructive actions stop at a Cancel-first confirm box that states exactly what will be written or removed.
- The finish is the summary: steps collapse, logs take the full width, and every manual follow-up is readable at 80×24.
- Flat by design: depth comes from tonal layering (ground → panel → panel-alt) and 1-cell borders, never shadows or radius.
- Non-interactive terminals degrade to plain logs instead of failing — the same product, stripped of pixels.

## Colors

A nine-token Tokyo-night palette: near-black ground, three-layer slate surfaces, and five signal hues — every color has a job, and the signal hues appear only when they mean something.

### Primary

- **Flight Blue** (`accent`): the system's pulse — running step icon and spinner, pane titles, the product title line, menu selection highlight, `step-running` rows. Used on roughly one element per screen at a time; its rarity is what makes a running step findable.
- **Signal Green** (`green`): completion only — `✓` step icons, `step-done` rows, the finished header line.
- **Alarm Rose** (`red`): failure and destruction only — `✗` step icons, `step-failed` rows, the confirm box border title, a failed-run header.
- **Caution Amber** (`yellow`): skipped steps (`⊘`) and attention-without-failure.

### Neutral

- **Near-Black Ground** (`bg`): the terminal backdrop and menu selection text color (knockout against Flight Blue).
- **Deck Slate** (`panel`): every boxed pane's fill.
- **Deck Slate Alt** (`panel-alt`): alternating list tint inside panes.
- **Soft Lavender White** (`fg`): all primary text — step labels, log lines, summaries, and **all actionable instructions** (the welcome hint line included).
- **Muted Slate Blue** (`dim`): decoration only — the system line, unfocused menu option descriptions (2-row tier), footer chrome, pending step icons.

### Named Rules

**The Icon Rule.** State is never color-only. The glyph carries it (`○` pending, `▸` running, `✓` done, `✗` failed, `⊗` skipped), color reinforces it. Never emoji.

**The Dim Rule.** `dim` is decorative. It may carry the system line, option descriptions, and footer chrome — it never carries an instruction, an action, or a warning. Anything the operator must act on renders in `fg` or brighter (measured: `dim` on ground ≈2.7:1, `fg` ≈11:1, `accent` ≈7:1).

## Typography

**Body Font:** monospace terminal cell grid (single font, single size — the grid is the type system)

**Character:** One monospace face at one size; hierarchy is made of color, casing, and separators — not point sizes. The banner is not type at all, it is byte-exact ASCII art from a user-supplied file.

### Hierarchy

- **Product title** (accent, 1 row): `airlink installer · one command for panel + daemon` — the only place the abstract banner is translated into words; sits between banner and system line.
- **Pane title** (accent, inside the border): lowercase mono, left-inset — `steps`, `logs`, `confirm`.
- **Screen header** (green/red, 3-row bar): `install both · step 14/22 · 7.9s`, `install both complete`, `install all finished with errors · 2 step(s) failed`.
- **Body** (fg, 1 row per step or log line; wraps to pane width in the logs pane): step labels, command output, the summary block.
- **Metadata** (dim): system line, unfocused menu descriptions, footer hints — `distro · arch · debian pkgs · sudo`, `enter/q quit`.

### Named Rules

**The Lowercase Title Rule.** Pane titles are always lowercase mono inside the border; metadata separators are always the mid-dot (`·`) with surrounding spaces. Caps are reserved for the banner, the product title line, and real command output.

## Layout

The spatial model is a screen stack — `welcome → service → confirm → progress` — one visible screen at a time, all sized from `termCols()`/`termRows()` (the resize event re-applies them).

- **Welcome:** banner (51×28 file, byte-exact) → accent title line → dim system line → select menu (width 46, 2-row options: name + dim description) → hint row. Height tiers: ≥45 rows shows the full 28-line file; ≥30 rows shows the edge-trimmed 13-row art with the 2-row menu; below 30 the menu collapses to single-row `name — description` options (width 60) so 80×24 fits in 23 rows with everything visible.
- **Progress:** 3-row header, body row, 1-row footer. Body = left `steps` pane, width `min(52, max(32, cols × 0.4))`, plus gap (1 cell) plus right `logs` pane at an explicit width (`cols - steps - 3` — `flexGrow` does not reserve the gap and ran the border past the viewport). `paddingX: 1` on the body, `paddingY: 1` + border in each pane. The steps pane shows a sliding window (≥6 rows, active step pinned last) because 22 steps cannot fit a 24-row terminal.
- **Finish:** the steps pane collapses and the logs pane takes the full width (`cols - 2`), so the whole summary (release tag, dirs, .env state, manual steps) is the landing view at 80×24.
- **Confirm / service boxes:** fixed 66 × 20, `paddingX/Y: 1`, gap 1, cancel-first select of 4 rows at the bottom — sized for the tallest body (9 content rows).
- **Spacing rhythm:** everything is whole cells — gap 1, pane padding 1, header inset 2. There are no fractional values or sub-cell offsets.

### Named Rules

**The Tier Rule.** Every height tier is a hard budget: the stack for a tier must fit that tier's row count exactly (80×24 → 23 rows). Adding a row to any screen means recomputing all three thresholds before it ships.

## Elevation & Depth

This system has no shadows and does not want them — a terminal has one plane. Depth is conveyed entirely by tonal layering: the near-black ground, the Deck Slate panes floating on it, and Deck Slate Alt for alternating tint inside lists, all separated by 1-cell white borders (`border` — the inherited reference-world hairline, drawn by the pane itself, never a separate stroke). The only "float" cues are the pane border and its inset lowercase title.

### Named Rules

**The Flat Rule.** Surfaces are flat at rest. No glow, no halo, no pseudo-shadow is ever drawn — a border or a tone step does that job.

## Shapes

Square corners everywhere: boxes are drawn with 1-cell borders (`┌ ─ ┐ │ └ ┘`) with titles cut into the top border, and `overflow: "hidden"` is enforced on every scrollable pane so content clips instead of bleeding over a border — the border is the shape, and it must never break. The silhouette vocabulary beyond boxes: the byte-exact ASCII banner (trimmed per tier, never re-drawn), the braille spinner (10 frames), state glyphs, and the mid-dot metadata separator. Selection highlight is a full-row knockout block (`▶` marker plus accent fill), not an underline or a pill.

## Components

### Select menu (welcome, service)

The primary navigation. Tall terminals get 2-row options — name over a one-line `dim` description (width 46); below 30 rows it collapses to single-row `name — description` rows (width 60), same order and labels. The select component renders unfocused rows with its own near-black fill and default-light names (opentui defaults — `textColor`/`backgroundColor` do not restyle select items in this version, verified by probe); project styling owns what matters: descriptions in `dim`, and the selected row as an `accent` fill with `ground` text and the `▶` marker. Preselects the safest/top choice. Keyboard-only — up/down move, enter selects, escape backs out.

### Boxed pane

Every content region is a `panel`-filled box, 1-cell border, lowercase accent title inset in the border (`steps`, `logs`, `confirm`), padding 1 cell. Danger confirm boxes swap the title color to `red` — the box color change is the only screen-level alarm the system ever raises.

### Step row

One row per plan step: icon + `app · action` label + trailing note. State mapping — `○` dim pending, `▸` accent running (with the braille spinner), `✓` green done, `✗` red failed, `⊘` yellow skipped. Rows never wrap and never shrink; the pane windows them instead.

### Logs pane

Word-wrapped tail of an 800-line ring buffer, budgeted by wrapped rows so the newest content is never clipped; commands and the summary read in full. Plain mode prints the identical stream to stdout — the pipe contract.

### Confirm select

Cancel-first, Cancel preselected. Install boxes title themselves `installs with <mgr>:` and list service lines + unit path + files per app; uninstall boxes title `this removes services and files:` and state the *detected* manager per app (systemd unit, pm2 process, or `(no service - files still removed)`), with the action description matching that reality (`no service - removes leftover files only` when nothing has a service).

### Header / footer bar

3-row header: action title (result-colored) + `step N/M · elapsed`; 1-row footer: mode hint while running, `enter/q quit` after finish. Fixed heights so content can never push chrome off-screen.

### State icon set

`○ ▸ ✓ ✗ ⊘` — non-emoji, width-stable, present on every state-bearing row; the paired color lives in `COLORS[StepState]`.

## Do's and Don'ts

### Do:

- **Do** carry state with icon + color together (`✓` green, `✗` red) so a monochrome or colorblind read still works.
- **Do** keep actionable text in `fg` or brighter — the hint line, confirm options, and summary commands are instructions, never `dim`.
- **Do** size panes from `termCols()`/`termRows()` formulas and recompute the three welcome tiers whenever a row is added.
- **Do** clip pane content (`overflow: "hidden"`) and window it (steps) or budget it by wrapped rows (logs) — borders render complete at every width.
- **Do** stop every action — install included — at a Cancel-first confirm whose body states the real, detected system state.
- **Do** degrade to plain logs on a missing TTY (with a one-line notice) and keep `action + --yes` fully non-interactive.

### Don't:

- **Don't** use emoji or any double-width glyph for state or icons — the grid is single-width.
- **Don't** communicate a result through color alone, or put an instruction in `dim`.
- **Don't** draw shadows, glows, rounded corners, or underlines; borders and tone steps are the whole vocabulary.
- **Don't** let a screen silently exceed its viewport — a row added without re-tiering is a regression.
- **Don't** promise behavior the box doesn't deliver (no "nothing to remove" next to a "remove" button; no "changes only after you confirm" without a confirm screen).
- **Don't** hide what the system is doing: no silent spinner, no complete-message without the command logs that produced it.
