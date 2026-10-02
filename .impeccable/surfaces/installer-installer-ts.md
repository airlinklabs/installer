---
version: 1
slug: "installer-installer-ts"
primary_target: "installer/installer.ts"
related_targets: []
---

# Surface brief — installer/installer.ts (Airlink installer TUI)

## Scope & visitor mode

Mode: **Operate**. One surface: the OpenTUI installer that runs after `curl | bash`. The operator has sudo on a Linux box and one job — install/update/uninstall the Airlink panel and daemon from release zips — and must always see what is happening (steps + live logs) and what remains to be done by hand. The bash bootstrap `installer.sh` is the antechamber, not a second surface: same tokens, plain stdout only.

## Audience, job, action, proof, constraints

- Audience: self-hosters/ssh admins; keyboard-only; 80x24 minimum; may be non-TTY (`--no-color`).
- Job: choose an action (install both/panel/daemon, uninstall, exit), optionally pick systemd vs pm2, confirm, watch progress, read the follow-up summary.
- Proof: real release tags resolved live (`Beta-2` etc.), real command output streaming into the log pane.
- Constraints: never block on hidden state; destructive actions confirm first; `.env` preserved on reinstall; no admin-account creation; sudo only ever `sudo -n` (keepalive taken by the bootstrap).

## Direction contract

<!-- impeccable:direction-contract 1 -->

THESIS: The installer is a flight-deck, not a wizard — one menu, then a split view where every action the system takes is visible as it happens. It refuses the category-default pattern of silent spinner + "Installation complete!" that hides which command failed.

OWN-WORLD: Inherited from the reference (Miserable_Xfce installer, pinned by the brief as the architectural model): Tokyo-night palette on a near-black ground — bg #1a1b26, panel #20222e, alt #252733, fg #c0caf5, dim #565f89, accent #7aa2f7, green #9ece6a, red #f7768e, yellow #e0af68 — boxed panes with 1px borders and lowercase mono titles (`steps`, `logs`), ASCII banner wordmark, braille spinner, state icons (○ pending, ▸ running, ✓ done, ✗ failed, ⊘ skipped). Airlink re-derives the banner and adds its own title line; the system language stays identical.

STORY: The operator sees the Airlink banner and system line (distro · arch · pkgs · sudo), picks an action from a select menu, chooses the service manager, reviews the confirm screen (exactly what will be written or removed, Cancel first), watches steps flip ○ → ▸ → ✓ with their live command logs beside them, and lands on a summary that names the release tag, the service manager, the URLs/ports, and every remaining manual step (edit daemon .env, register node, first-user signup).

FIRST VIEWPORT: Welcome screen — ASCII AIRLINK banner (accent) top-left, title line `airlink installer  ·  one command for panel + daemon` (accent) under it — the banner is abstract art, the title is what names the product — then the dim system line, select menu (width ~46) with seven options (Install both / Install panel / Install daemon / Uninstall panel / Uninstall daemon / Uninstall everything / Exit, each with a dim one-line description), hint line at the bottom ("up/down move · enter select · install makes changes only after you confirm"). Progress screen replaces it: 3-row header bar (action · step N/M · elapsed), left `steps` pane (~40% width, min 32), right `logs` pane (explicit width, word-wrapped row-budgeted tail of the ring buffer so summary commands never clip), 1-row footer with the exit hint; colors carry state but icons always carry it too. On finish the `steps` pane collapses and `logs` takes the full width — the entire summary (release tag, dirs, .env state, manual steps) is the landing view even at 80×24.

FORM: Chosen form — menu → split panes (steps | logs) → summary, inherited directly from the reference installer's established world; it is the top and only entry on the ordered list for this surface. No seed roll: the world and form were pinned by the brief ("same technology / how the installer is done with opentui and ts files" pointing at the reference), so this is a specified extension of an existing world, not a new-world roll.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
