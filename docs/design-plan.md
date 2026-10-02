# foundry operator console — design plan (M9a)

Status: approved design, no code. This is the contract for M9b–M9f. CLAUDE.md requires the
frontend to follow it exactly; a change to anything here means re-entering Plan Mode, not
improvising in code.

**Revised twice since.** M9g added one accent, a shadow ladder and interaction motion. **M9h
(§12) is the "Aurora" overhaul and supersedes the palette, typeface, shape, shadow and
restraint rules below wherever they disagree.** Passages it changes are marked "(revised M9h)";
§12 lists every rule it overrides and every rule that stays.

The plan is built against the API as it exists in `app/`, not an imagined one. Where the API
falls short of what SPEC's screens need, that is stated in [Backend additions](#backend-additions-m9b-lands-first)
rather than designed around.

---

## 1. The API this UI is designed around

| Route | Shape |
|---|---|
| `POST /runs` | `{task, goal?, budget_usd}` → `{thread_id, status}`, 202 |
| `GET /runs` | `list[RunStatus]` |
| `GET /runs/{id}` | `RunStatus` |
| `GET /runs/{id}/events` | SSE, `data: <ActivityEvent JSON>` |
| `GET /approvals` | `list[PendingApproval]` |
| `POST /runs/{id}/resume` | `{approved, note}` → 202 |

`RunStatus`: `thread_id, status, stop_reason, spent_usd, budget_usd, leaderboard[],
pending_approval, report_md, error`. `status` is `running | awaiting_approval | completed | failed`.

`ActivityEvent`: `thread_id, seq, kind, node, summary, spent_usd`. `kind` is
`node | interrupt | done | error`. `node` is one of the graph's node names: `principal,
data_team, modeling_team, experiment_runner, red_team, reporter, final_gate, lesson_writer`.

`PendingApproval`: `gate` (`budget | final`), `reason`, `spent_usd`, `budget_usd`,
`projected_usd`, `best_experiment_id`, `best_metric_name`, `best_metric_value`, `n_invalidated`.

### Gaps that shape the design

1. **The experiment drawer has no data source.** `ExperimentResult` carries `metrics, cost_usd,
   duration_s, attempts, error, mlflow_run_id`. It does not carry the agent-written code, and
   `SandboxResult.stdout/stderr` never enter graph state at all. This is a state change, not a
   missing route.
2. **Red-team findings are not exposed.** `invalidations: list[RedTeamFinding]` lives in
   `FoundryState` but is absent from `RunStatus`. Only the `n_invalidated` count reaches a client.
3. **`model_card_md`** is in state and absent from `RunStatus`.
4. **`GET /runs` is in-memory only** (`RunManager._handles`), so runs home is empty after an API
   restart.
5. **No eval route.** `artifacts/eval/results.json` exists and is unserved.
6. **No replay recording.** SPEC requires JSONL capture; nothing writes it.
7. **SSE has no `event:` or `id:` field.** The client keys off `seq` and reconnects by
   re-opening. The stream is finite by design and terminates at each pause.

---

## 2. Design thesis

A console with a **fixed instrument frame and one scrolling channel.** Everything that is a
*state* — phase, budget, leaderboard, team roster, audit status — is docked at a stable screen
position and never moves. Only the event log scrolls. That single rule is what separates this from
a SaaS dashboard, where everything scrolls together and nothing has a home.

Boldness is spent once, on the red-team invalidation (§8). Everything else is quiet
instrumentation.

*(revised M9h)* The frame rule stands: states live at fixed positions and only the event log
scrolls. The "quiet instrumentation" half does not. M9a–M9g built it, and checked against real
screenshots it read as unfinished, not disciplined. Instruments are now luminous: layered glass
material, vivid team and status colour, real iconography and live-state glow. The red-team
invalidation is still the single loudest moment in the product, the only one with a screen-edge
vignette and a 1400ms sequence; it is no longer the only moment that is allowed to look
designed.

---

## 3. Color tokens

Two complete themes, not an inversion. Dark is primary. All values are CSS custom properties on
`:root` and `:root[data-theme="light"]`. Components reference tokens only, never raw hex.

Contrast figures below are the **worst case across all five surfaces** of that theme (see §11 for
method and the full check).

### 3.1 Dark — "ink" (revised M9h; was "instrument slate")

Five ground layers, hue ~235 (indigo-ink, up from slate's ~215, with visibly more chroma).
Elevation comes from a surface-hue shift, a gradient hairline and a tinted layered shadow (§3.3).
The page carries an ambient aurora (§12.3); the five opaque grounds below remain what every text
token is measured against.

| Token | Hex | Use |
|---|---|---|
| `--surface-abyss` | `#0A0C1C` | page behind the frame; the aurora's ground |
| `--surface-deck` | `#0F1228` | main column ground (70% over the aurora on the live view) |
| `--surface-panel` | `#151A33` | docked panels |
| `--surface-raised` | `#1D2340` | drawers, dialogs, hover, the red-team alert |
| `--surface-inset` | `#0B0E20` | wells: code, stdout, meter track |
| `--line-hairline` | `#232A4A` | dividers inside a panel (decorative) |
| `--line-strong` | `#323A63` | panel edges (decorative) |
| `--line-control` | `#6D79AD` | input and button boundaries, 3.65:1 |
| `--line-focus` | `#8AA4FF` | focus ring, 2px at 2px offset, 6.46:1 |
| `--text-primary` | `#EEF1FF` | 13.65:1 (16.41:1 on deck) |
| `--text-secondary` | `#AAB4DC` | 7.52:1 (9.03:1 on deck) |
| `--text-muted` | `#8D98C4` | 5.43:1 (6.52:1 on deck) — the text floor |

**Team hues** *(revised M9h)*. Each agent team owns one vivid hue. This is functional encoding — it
answers "who acted" at a glance in a dense feed. It appears as an icon chip (15% tint), a feed and
roster row wash (`--wash-row`: 8% in dark, 5% in light), and the team label. Never in the leaderboard
or any table. Every wash alpha is composited against text on the grounds a row sits on and tested (§11).

| Token | Hex | Team | Min contrast |
|---|---|---|---|
| `--team-principal` | `#F5C76E` | principal | 9.71:1 |
| `--team-data` | `#4DC4F0` | data_team | 7.66:1 |
| `--team-modeling` | `#9AA6FF` | modeling_team | 6.78:1 |
| `--team-runner` | `#4FDBA5` | experiment_runner | 8.79:1 |
| `--team-redteam` | `#FF6F86` | red_team | 5.76:1 |
| `--team-reporter` | `#D98CFF` | reporter | 6.69:1 |

Every team row also carries a text label and a distinct icon, so hue is redundant encoding (WCAG
1.4.1). This matters most for `--team-runner` against `--team-redteam`, the green/red pair: a flask
and a shield-alert cannot be mistaken for each other in greyscale.

**Status ramp**, deliberately separate from team hues because "who" and "what state" are different
questions:

| Token | Hex | Min contrast |
|---|---|---|
| `--status-ok` | `#3DDC97` | 8.69:1 |
| `--status-warn` | `#FFB84D` | 8.94:1 |
| `--status-danger` | `#FF6F86` | 5.76:1 |
| `--status-info` | `#62ADFF` | 6.54:1 |
| `--status-idle` | `#6F7AA6` | 3.67:1, graphic use only |

`--status-danger` is intentionally the same value as `--team-redteam`: invalidation *is* the
danger state. `--status-idle` is for dots and glyphs and always paired with a text label in
`--text-muted`; it is not a text color.

**Brand and accent** *(revised M9h; M9g's single accent is now the deep end of a gradient)*. The
identity is one three-stop gradient, violet → blue → cyan, used for the logo, progress and emphasis
fills, borders, glows, and large display numerals. The solid `--accent` / `--accent-to` pair is the
**deep** gradient primary buttons use, because it is the only part dark enough to carry white text
at 4.5:1. The bright cyan end is never behind body text, and gradient text is large text only.

| Token | Hex | Use | Min contrast |
|---|---|---|---|
| `--brand-1` | `#8B6DFF` | gradient start (violet) | 4.19:1 (graphic) |
| `--brand-2` | `#5B8CFF` | gradient middle (blue) | 4.86:1 (graphic) |
| `--brand-3` | `#22D3EE` | gradient end (cyan) | 8.50:1 (graphic) |
| `--accent` | `#6C5CFF` | deep-gradient start, active tab rail, range thumb | 3.37:1 (graphic floor) |
| `--accent-to` | `#3A64F5` | deep-gradient end | 3.16:1 (graphic); 4.86:1 for white on it |
| `--accent-hover` | `#8274FF` | hover/press border and glow state | 4.31:1 (graphic) |
| `--accent-soft` | `rgb(108 92 255 / 0.16)` | translucent wash behind an active/selected row | exempt, decorative |
| `--accent-contrast` | `#FFFFFF` | label/icon sitting on a filled `--accent` surface | 4.55:1 against `--accent` |

`--accent` is the window between two floors: light enough to hold 3:1 against the darkest-contrast
ground (`--surface-raised`) and dark enough to hold 4.5:1 under white text. That window is narrow
(luminance 0.155 to 0.183), which is why a primary button never *lightens* its fill on hover — it
gains a glow and a sheen instead. `--accent-to` and `--accent-contrast` are verified against each
other, not the five grounds (§11).

**Budget meter.** A continuous quantity gets its own ramp. *(revised M9h)* Each tone is now a
gradient from its status colour to a hotter end colour, so the bar reads as filling with energy:

| Token | Value | Threshold |
|---|---|---|
| `--meter-track` | `#232A4A` | — |
| `--meter-safe` | `#3DDC97` → `--brand-3` | under 70% of cap |
| `--meter-pressure` | `#FFB84D` → `--meter-pressure-end` `#FF8A4C` | 70–90% |
| `--meter-critical` | `#FF6F86` → `--meter-critical-end` `#FF3D6E` | over 90% |
| `--meter-projected` | `#FFB84D` at 35% | 45° hatch, the `projected_usd` beyond spend |

The meter is never the only carrier of its value: a numeric readout always sits beside it.

### 3.2 Light — "porcelain" (revised M9h; was "datasheet")

Cool lavender-tinted paper with a pastel aurora. Not an inversion of dark, and explicitly not cream.

| Token | Hex |
|---|---|
| `--surface-abyss` | `#ECEFFB` |
| `--surface-deck` | `#F5F6FD` |
| `--surface-panel` | `#FFFFFF` |
| `--surface-raised` | `#FFFFFF` (bordered with `--line-strong`) |
| `--surface-inset` | `#E8EBF8` |
| `--line-hairline` | `#DFE3F3` |
| `--line-strong` | `#C6CCE6` |
| `--line-control` | `#6A76AD` |
| `--line-focus` | `#3F5BD6` |
| `--text-primary` | `#12142B` |
| `--text-secondary` | `#444B78` |
| `--text-muted` | `#575F8C` |

Team hues, same hue angle, lower lightness to hold contrast on paper: principal `#7D5A0D`, data
`#0A6A8F`, modeling `#4652C4`, runner `#0B6A4D`, red team `#B4253F`, reporter `#8339BD`. Principal,
runner and red team are a shade darker than their first draft: a feed label sits on an 8% wash of
its own hue, which costs about 0.5:1, and the first values fell to 4.50 / 4.38 / 4.29 there (§11).

Status: ok `#0B6D49`, warn `#8A5805`, danger `#B4253F`, info `#2358D4`, idle `#6A7399`. Status ok
joins the darkened set for the same reason: the feed's "done" row labels itself in this green on an 8%
wash of the same green, and the first value (`#0E7550`) fell to 4.46:1 on the page ground.

Brand: `--brand-1` `#6F4DF0`, `--brand-2` `#3B6BE8`, `--brand-3` `#0A8FB0`; accent `#5440E6`,
`--accent-to` `#2F56E0`, `--accent-hover` `#4A38D4`, `--accent-contrast` `#FFFFFF`. Meter ends:
pressure `#B3470B`, critical `#DC2450` (critical itself is `#B4253F`).

### 3.3 Shape and elevation (revised M9h)

Radius encodes **role** (it used to encode permanence at 3/4/10px, which read as wireframe boxes).

| Token | Value | Applies to |
|---|---|---|
| `--radius-panel` | `14px` | docked panels, KPI tiles, code wells |
| `--radius-control` | `10px` | buttons, inputs, selects |
| `--radius-chip` | `8px` | icon chips, rank chips, kbd hints |
| `--radius-float` | `20px` | drawers, gate dialogs, the red-team alert |
| `--radius-pill` | `999px` | replay speed selector, status chips, live dots |

**Shadow** *(revised M9h; M9g's "no resting shadow on a docked panel" is withdrawn)*. A docked
panel now carries a tinted, layered `--shadow-panel` at rest. What keeps this from becoming "the
same soft grey shadow everywhere" is that it is not uniform: the rail is unboxed, the feed is a
timeline rather than cards, tables are unboxed rows, panels are tinted indigo not grey, floats are
a different tier, and *glow* is reserved for semantic state. Components reference tokens
exclusively (`design-invariants.test.ts`'s `shadows-are-tokenized` rule fails any literal
`box-shadow` that isn't `var(--shadow-*)`).

| Token | Role |
|---|---|
| `--shadow-highlight` | a barely-there inset top edge: material, not elevation |
| `--shadow-panel` | resting docked panel: top sheen plus a soft indigo-tinted cast |
| `--shadow-hover` | what a row/panel gains on hover: deeper cast plus a 1px brand ring |
| `--shadow-raised` | the primary button at rest, pressed or persistently-elevated controls |
| `--shadow-float` | drawers, gate dialogs, the red-team alert: contact shadow, long cast, brand ring |
| `--shadow-glow-{brand,ok,warn,danger}` | **semantic glow**: primary-button hover, live, running, critical meter, red-team. Always beside a text label |
| `--shadow-vignette-danger` | the screen-edge vignette of the red-team moment (§8). The only one in the app |

Light theme redefines all of them as low-alpha indigo (a dark cast on paper reads as dirt).

**Glass, for the float layer and the top bar.** `--surface-glass` / `--surface-glass-border` give
drawers, gate dialogs and the top bar translucency plus a `backdrop-blur`. Alpha stays at 0.84+ so
text inside still reads at the contrast verified for `--surface-raised`. Docked panels are *not*
glass: they are opaque `--surface-panel` with a gradient hairline, so a panel stays legible with
nothing rendered behind it. At most two `backdrop-filter` layers are live at once.

Spacing is a 4px grid: `4 8 12 16 24 32 48 64`.

---

## 4. Typefaces

| Role | Family | Weights | Why |
|---|---|---|---|
| Interface | **Geist** (variable) | 400, 500, 600 | *(revised M9h; was IBM Plex Sans)* crisp at 12–13px, tabular figures, designed as a pair with its mono |
| Measured values | **Geist Mono** (variable) | 400, 500 | *(revised M9h; was IBM Plex Mono)* every number: cost, metric, duration, `seq`, timestamp, `experiment_id` |
| Produced document | **Newsreader** | 400, 500 | report view and model card only |

Headings and hero numerals use `--tracking-tight` (`-0.02em`). The no-positive-tracking rule is
unchanged: only tightening is allowed.

**All numerics use `font-variant-numeric: tabular-nums`.** Non-negotiable: animated counters in
proportional figures jitter horizontally as digits change.

The serif is confined to exactly two screens. The rationale is a role distinction, not variety:
the report is the one artifact the system produces, and it is read rather than scanned, so it
should not look like instrument chrome. Weights stop at 600; there is no 700 anywhere.

### Type scale

UI, root 16px, tokens in rem:

| Token | Size / line-height | Use |
|---|---|---|
| `--text-2xs` | 11 / 16 | rail labels, `seq` — mono only |
| `--text-xs` | 12 / 18 | feed timestamps, micro-labels |
| `--text-sm` | 13 / 20 | dense table cells, feed body |
| `--text-base` | 14 / 22 | default UI text |
| `--text-md` | 16 / 24 | panel titles, drawer headings |
| `--text-lg` | 20 / 28 | screen titles |
| `--text-xl` | 26 / 32 | budget readout, best metric |
| `--text-2xl` | 34 / 40 | the hero numeric on gate dialogs |
| `--text-display` | 44 / 48 | **reserved**: red-team category, final report metric |

Report prose (Newsreader): body 17 / 28, caption 15 / 24, headings 28 / 22 / 18.

The system defines **no letter-spacing token above `0.01em`**, so tracked-out caps cannot be
reintroduced casually.

---

## 5. Live run view

Desktop at 1280 and up. Left rail 216px fixed, center fluid (min 480px), right 340px fixed, top bar
56px. Only the center column scrolls.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│  foundry        churn      run 5c25…37          ● running          ⏴⏵ 1×  4×  16×        ☾    │
├──────────────────┬───────────────────────────────────────────────┬─────────────────────────────┤
│                  │                                               │                             │
│  goal            │   activity                        312 events  │   budget                    │
│  predict churn   │  ┌─────────────────────────────────────────┐  │  ┌───────────────────────┐  │
│                  │  │▌principal      routing to data_team     │  │  │ spent                 │  │
│  phase           │  │ 14:02:11                        $0.0412 │  │  │ $12.84       of $20   │  │
│  ├─ data      ✓  │  ├─────────────────────────────────────────┤  │  │ ███████████░░▒▒▒▒░░░░ │  │
│  ├─ modeling  ✓  │  │▌data team      profiled + cleaned       │  │  │        ▲ projected    │  │
│  ├─ running   ◐  │  │ 14:02:48                        $0.1130 │  │  │          $17.40       │  │
│  ├─ audit     ·  │  ├─────────────────────────────────────────┤  │  └───────────────────────┘  │
│  └─ report    ·  │  │▌modeling team  planned 4 experiments    │  │                             │
│                  │  │ 14:03:02                        $0.2890 │  │   leaderboard               │
│  teams           │  ├─────────────────────────────────────────┤  │  ┌───────────────────────┐  │
│  ● principal  ◐  │  │▌runner         exp-003  success         │  │  │ 1  exp-003    0.8814  │  │
│  ● data       ✓  │  │ 14:05:19   roc_auc 0.8814       $0.9120 │  │  │ 2  exp-001    0.8642  │  │
│  ● modeling   ✓  │  ├─────────────────────────────────────────┤  │  │ 3  exp-004    0.8391  │  │
│  ● runner    3◐  │  │▌runner         exp-004  success         │  │  │ ⊘  exp-002    ——      │  │
│  ● red team   ◐  │  │ 14:05:44   roc_auc 0.8391       $0.8850 │  │  └───────────────────────┘  │
│  ● reporter   ·  │  ├─────────────────────────────────────────┤  │                             │
│                  │  │▐red team       2 audited, 1 invalidated │  │   audit                     │
│  cost by team    │  │ 14:06:02                        $0.3400 │  │  ┌───────────────────────┐  │
│  principal $1.22 │  ├─────────────────────────────────────────┤  │  │ ⊘ exp-002             │  │
│  workers   $9.87 │  │                                         │  │  │   leakage             │  │
│  red team  $0.98 │  │              ▼ live                     │  │  │   invalidated         │  │
│  sandbox   $0.77 │  └─────────────────────────────────────────┘  │  └───────────────────────┘  │
└──────────────────┴───────────────────────────────────────────────┴─────────────────────────────┘
```

`▌` is the 3px team-hue rail; `▐` is the heavier 5px rail carried only by red-team rows. `◐`
running, `✓` complete, `·` not yet reached, `⊘` invalidated. The `▼ live` control re-engages
follow-mode after the user has scrolled up.

Feed rows are a **two-line grid**, not a joined meta string. Line 1 is team label plus summary;
line 2 is timestamp (left) and metric plus cost (right-aligned, mono). Columns align down the
whole feed so the eye can scan one column at a time.

### Mobile, 390 down to 375

The three-column frame is the whole concept and cannot survive 375px. Rather than reflowing the
columns into a scroll stack, which would destroy "values live at a stable position", mobile keeps a
**44px sticky instrument bar** carrying the three values that must never be lost, and moves
everything else into tabs.

```
┌──────────────────────────────┐
│ ◐ running   $12.84/$20  live │   sticky: phase, spend, stream health
├──────────────────────────────┤
│ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ │   2px budget line, full bleed
├──────────────────────────────┤
│  activity   board   audit    │   tabs
├──────────────────────────────┤
│ ▌principal                   │
│  routing to data_team        │
│  14:02:11           $0.0412  │
├──────────────────────────────┤
│ ▌data team                   │
│  profiled + cleaned          │
│  14:02:48           $0.1130  │
└──────────────────────────────┘
```

Gate dialogs become full-screen sheets.

---

## 6. Other screens

**Runs home.** A dense table, one row per run, deliberately **not** a card grid. Columns: status
dot, dataset, goal, spend vs cap (inline 40px meter), best metric, invalidated count, stop reason,
age. "Start a run" is a docked panel above the table with three fields (dataset select from the
registry, goal, budget), not a modal.

```
┌────────────────────────────────────────────────────────────────────────┐
│  start a run                                                           │
│  dataset [churn      ▾]   goal [predict churn        ]  budget [ 20 ]  │
│                                                          ( Start run ) │
├────────────────────────────────────────────────────────────────────────┤
│       dataset    goal              spend        best    ⊘   stopped    │
│  ●    churn      predict churn     ███░░ 12.84  0.8814  1   target_met │
│  ✓    credit     predict default   █████ 19.02  0.7741  0   diminishing│
│  ⊘    titanic    predict survived  ██░░░  8.10  ——      2   human_dec… │
└────────────────────────────────────────────────────────────────────────┘
```

**Experiment drawer.** A right sheet, 560px, `--radius-float`, over a dimmed deck. Four tabs:
`spec` (model family, hyperparams, rationale, estimated vs actual cost), `code` (agent-written
training code, mono on `--surface-inset`), `output` (sandbox stdout and stderr, monospace,
wrapped), `attempts` (the self-debug sequence: attempt 1 failed, 2 failed, 3 succeeded, each with
its error and what changed). The header carries the metric, duration, and the MLflow link.

**Approval gates.** Not a modal over a still-live feed. The deck **de-energizes**: the feed stops
following, instrument values dim to `--text-secondary`, and a centered console panel takes focus.
It shows exactly what is being approved. For the budget gate: spent, cap, projected, and the
pending specs that produced the projection. For the final gate: the winning experiment, its
metric, and the invalidated count. The Approve control has a **400ms arm** (it fills in before
becoming pressable) and **Enter does not submit**; you must Tab to it. Reject requires a note.

```
┌───────────────────────────────────────────────────────┐
│  budget gate                                          │
│                                                       │
│  projected spend                                      │
│  $17.40                                               │
│  against a $20.00 cap, with $12.84 already spent      │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │ spent      ███████████░░░░░░░░░   $12.84        │  │
│  │ projected  ███████████▒▒▒▒▒▒░░░   $17.40        │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  pending        exp-005  lightgbm        $2.10        │
│                 exp-006  xgboost         $2.46        │
│                                                       │
│  note [                                           ]   │
│                                                       │
│              ( Reject )        ( Approve )            │
└───────────────────────────────────────────────────────┘
```

**Red-team finding.** See §8.

**Report view.** A single centered column in Newsreader, 680px measure, sticky mini-TOC on the left
at 1100px and up. Plots themed from tokens. The final metric renders at `--text-display`, one of
only two places that size is permitted.

**Eval results.** The M8 ablation table as the hero, dense and numeric. Charts are **small
multiples**, one compact chart per ablation, rather than one large combined chart: the ablations
are independent comparisons and overlaying them would imply a relationship that isn't there.

---

## 7. Motion

| Token | Value |
|---|---|
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` |
| `--ease-instrument` | `cubic-bezier(0.34, 0.8, 0.28, 1)` |
| `--dur-instant` / `--dur-quick` / `--dur-base` | 90 / 160 / 240ms |
| `--dur-slow` / `--dur-deliberate` / `--dur-moment` | 420 / 700 / 1400ms |

| Moment | Spec |
|---|---|
| Feed arrival | 140ms, opacity plus `translateY(4px→0)`, `--ease-out`. Events flush on a 100ms rAF tick. More than 6 in one tick means **no per-row stagger** (stagger at rate reads as chaos). Above about 20 per second, opacity-only at 90ms. List is virtualized. |
| Leaderboard reorder | 380ms layout animation, `--ease-in-out`. Only moved rows animate. A row that gained rank gets a 600ms decaying tint on its left edge. |
| Budget meter | Fill 500ms `--ease-instrument`; counter tweens in tabular mono. Crossing 70% or 90% transitions the fill color over 300ms and leaves a permanent 2px threshold tick. No pulse, no glow. |
| Metric values | 400ms count-up on change, `--ease-instrument`. |
| Phase advance | Marker slides 240ms; `◐`→`✓` crossfades 160ms. |
| Gate entry | 700ms total: deck desaturates to 40% over 400ms, feed stops following, panel scales `0.97→1` and fades over 320ms after a 120ms delay. Focus moves to the panel heading. |
| Gate confirm | The approved figure **flies from the panel into the budget meter's position** over 420ms, then the deck re-energizes over 300ms. Confirming shows what changed. |
| Red-team invalidation | §8. The only 1400ms sequence in the app. |
| Drawer | 280ms `translateX`, `--ease-out`; scrim 200ms. |
| Stream disconnect | Status pill crossfades to "reconnecting"; a 2px indeterminate line runs under the top bar. On reconnect the line **completes** left to right in 300ms rather than vanishing. |

`prefers-reduced-motion: reduce`: every entry becomes opacity-only at 90ms, counters snap,
layout reorder is instant, and the red-team sequence becomes a single state change with the
connector drawn statically. No motion is removed silently; the information each moment carries is
always still present.

### Interaction motion (M9g)

The table above is entirely data-driven — it fires on events arriving, never on the pointer. Before
M9g the app had three CSS transitions total and no hover state on any clickable row. This closes
that gap with the same discipline: every rule below reuses an existing `--dur-*`/`--ease-*` token,
none introduces a new duration, and reduced-motion collapses each to an instant state change exactly
as the data-driven table does.

| Moment | Spec |
|---|---|
| Row hover (leaderboard, audit, activity feed, runs table, eval table) | Background to `--surface-raised` and rail/border brighten, `--dur-quick`/`--ease-out`. |
| Panel hover (interactive panels only) | `--shadow-highlight` is always present; `--shadow-hover` fades in, `--dur-quick`. |
| Button press | `scale(0.98)`, `--dur-instant`; primary variant additionally crossfades to `--accent-hover`. |
| Focus-visible | Unchanged: the 2px `--line-focus` ring, never suppressed (§10). A filled primary control's ring sits on `--accent-contrast` for visibility against `--accent`. |
| Tab indicator (mobile tabs, drawer tabs) | The selected-tab underline is a `layoutId`-shared element that slides between tabs, `--dur-base`/`--ease-in-out` — the same shared-layout technique §7's gate-confirm "fly" already uses, not new machinery. |
| Replay speed pill | Selected-state pill slides via the same shared-layout technique, `--dur-quick`. |
| Skeleton | Reverses §9's "shimmer-free": a slow sweep, `--dur-moment`, opacity-modulated only (no shimmer-as-decoration on a dozen static blocks at once — see §9). |
| "Live" stream-health dot | *(revised M9h)* A glow plus a slow ping ring, reserved for states that mean "this is happening right now": live, running. Always beside a text label. Idle, ended and failed dots stay flat. |

### Material and ambient motion (M9h)

M9g's table is still data-driven or pointer-driven. M9h adds the motion that makes the surface feel
alive without being tied to either. Every row reuses an existing `--dur-*` / `--ease-*` token or one
of the three added in §12.2, and every continuous loop is switched off under
`prefers-reduced-motion` with an explicit `animation: none` (not merely a zero duration).

| Moment | Spec |
|---|---|
| Aurora drift | The ambient layer translates and scales a few percent over `--dur-ambient` (40s), alternating. `transform` only, one compositor layer, no blur filter. |
| Panel spotlight | A radial highlight follows the pointer inside a docked panel or table row, `--dur-quick` fade in/out. Pointer-fine devices only; written as CSS variables, never React state. |
| Primary button sheen | A diagonal highlight sweeps once across the primary button on hover, `--dur-sheen`. The fill never lightens (§3.1 accent window). |
| Conic Approve border | Once the gate's Approve control is armed (§6, 400ms), a conic gradient border rotates slowly around it. Static under reduced motion. |
| Meter sheen | While spend is changing, a highlight travels along the budget fill. Idle, it stops. |
| Feed arrival glow | The newest batch of rows carries a team-tinted wash that fades over 1.2s. Opacity only, so §7's batch, stagger and virtualization rules are untouched. |
| Phase progress line | The connector between phase steps fills with the brand gradient as phases complete; the active step shows a spinning arc. |
| Live ping | The live/running dot emits a ring that scales and fades, 2s loop. |
| Skeleton | A slow travelling highlight across the block (`--dur-moment`); see §9. |
| Route cascade (M9h-3) | One stagger across a page's top-level panels on route mount: opacity and 6px `y`, 40ms apart, once. Never re-fired by data updates. |

Hover remains glow, spotlight and border only. A rule in `designRules.ts` (`no-hover-motion`) fails
`hover:translate-*`, `hover:scale-*` and `animate-bounce`, so "hover bounce" cannot creep back in.

---

## 8. The memorable moment: red-team invalidation

**Why this one.** It is the only moment in the product where the system publicly overrules itself.
Every other event is progress; this is the machine catching its own error. That is the one thing an
operator must believe before they will let it run unattended, and it is exactly what SPEC's
recorded demo is built around (the booby-trapped leaky dataset). Boldness spent here buys trust.
Spent anywhere else it is decoration.

**Choreography: 1400ms, one sequence, never reused for anything else.**

| Window | Beat |
|---|---|
| 0–200ms | **The flag.** The invalidated experiment's leaderboard row loses its rank number to `⊘`; its metric strikes through and desaturates. The row does not leave yet. |
| 200–520ms | **The demotion.** The row animates out of the ranked list; rows below close up. It re-lands in the audit strip. |
| 400–900ms | **The connector.** An SVG path draws (`stroke-dashoffset`) from the vacated leaderboard slot down to the audit entry, in `--team-redteam`. **The only drawn connector in the entire app.** |
| 700–1400ms | **The finding.** The audit panel expands: category, the audit tool's actual measured evidence, and the recommendation. The category renders at `--text-display`, the only use of that size on this screen. |

Throughout, a single 2px `--team-redteam` rule runs along the top of the right column and fades
across the full 1400ms. Nothing pulses, nothing bounces. *(revised M9h)* The moment is now louder,
because it is the one thing the whole product is built to show: a danger-tinted bloom (`--bloom-danger`)
swells behind the audit panel, the connector gains a soft glow underlay, and a screen-edge vignette
(`--shadow-vignette-danger`) fades across the same 1400ms. The vignette appears nowhere else in the
app. The choreography's phases, timings and the data that drives them are unchanged.

*The vignette's strength was measured, not assumed.* It is a full-viewport inset shadow, so its
brightest pixel is the viewport edge, at a fraction of its nominal alpha: a Gaussian of sigma =
blur / 2, with the edge sitting `spread` pixels inside the opaque region, gives
`alpha x Phi(spread / sigma)`. The first draft (140px blur, 8px spread, 0.22) therefore painted only
~11% at the edge, +27 on the red channel in a real browser, a rim you had to hunt for. It is now
160px / 60px at 0.22 in dark (0.12 in light): ~17% at the edge, +39 measured, and still +21 at 80px
in, with its opacity peaking at ~0.99 at 250ms and gone by 1.4s (also measured). It paints at z-20,
under the top bar and every dialog, so it can sit over the page ground, the deck and a panel but never
over a raised surface; `tokens.contrast.test.ts` holds text-primary, secondary and muted to 4.5:1 at
that modelled peak over those three grounds.

`aria-live="assertive"` announces it once. Everything else in the app is `polite` and throttled.

The sequence reads as one sentence: *this one was leading, the red team looked at it, it is gone,
here is why.*

---

## 9. States

Skeletons mirror the real grid: the three-column frame renders immediately with panel outlines and
muted blocks, so nothing reflows on load. M9g reverses the original "shimmer-free" rule: a single
skeleton block now carries a slow (`--dur-moment`) opacity sweep, because a lone static block reads
as inert rather than loading. *(revised M9h)* The sweep gains a soft travelling highlight on top of
the opacity pulse. It stays slow and low-contrast, and is implemented inside the `skeleton-sweep`
utility so no `animate-`, `shimmer` or `pulse` class name appears in markup. Empty states name the next action ("No runs
yet. Pick a dataset above to start one."). Error states name the failure and the fix, using
`RunStatus.error` verbatim rather than a generic message. Stream-disconnected shows the
reconnecting bar with automatic retry and backoff, and the feed stays readable and scrollable
while disconnected.

## 10. Accessibility floor

WCAG AA on every token pair in §3 (verified, §11). Full keyboard navigation; 2px `--line-focus`
ring at 2px offset, never suppressed. The live feed is announced through a throttled `aria-live`
region. Team identity is never carried by hue alone. Control boundaries use `--line-control`
(3:1), not the decorative `--line-strong`. Responsive to 375px. Lighthouse performance and
accessibility at 90 or above.

## 11. Contrast verification

Computed with WCAG 2.x relative luminance, for every foreground token against all five surfaces of
its theme. Floors: 4.5:1 for text (1.4.3), 3:1 for graphics and control boundaries (1.4.11).

The first draft of this plan asserted AA without computing it. Computing it found failures, all
corrected above:

| Token | Draft | Problem | Now |
|---|---|---|---|
| dark `--team-redteam` / `--status-danger` | `#E0645F` | 4.2:1 on `raised`, where the red-team alert sits | `#E5726D` |
| dark `--text-muted` | `#7C8FA5` | 4.3:1 on `raised` | `#8396AB` |
| dark `--status-info` / `--line-focus` | `#5B8DEF` | 4.4:1 on `raised` | `#6494F0` |
| dark `--status-idle` | `#5A6B7D` | 3.0:1 on `panel`, 2.6:1 on `raised` | `#66798D` |
| light `--team-principal` | `#8A6D2B` | 4.3:1 on `abyss`/`inset` | `#82662A` |
| light `--team-runner` | `#2E7D63` | 4.4:1 on `abyss`/`inset` | `#2A775E` |
| light `--status-warn` | `#9A6B10` | 4.4:1 on `deck` | `#8E620E` |

`--line-control` was added because panel edges (1.5:1) are decorative but input and button
boundaries must meet 3:1. Result: all 32 token/surface sets pass; the tightest is dark
`--team-redteam` at 4.74:1 on `raised`.

M9b turns this check into a unit test over the real CSS variables so the tokens cannot drift below
AA unnoticed.

**M9g's accent** (§3.1) is checked the same way, against a floor chosen deliberately, not
loosely: `--accent` is a graphic token (3:1) — worst case 3.17:1, on `--surface-raised`, the same
surface every other worst-case in this table lands on. `--accent-contrast` is checked against
`--accent` itself rather than the five grounds, since it is only ever read as a label sitting on a
filled `--accent` surface: 4.51:1, clearing the 4.5:1 text floor with real (if not generous)
margin. Both were chosen by computing the ratio first, the same discipline as the rest of this
table, not by eye.

**M9h's palette** (§3, §12) was computed before it was written down, and the computation again
caught a real failure. The first aurora and spotlight washes were 22% violet over every ground;
composited, `--text-muted` on `--surface-raised` fell to **4.20:1** in dark and, at 14%, to
**4.31:1** in light — both under the 4.5:1 floor. Fixes, each verified:

| Layer | Sits on | Dark alpha | Light alpha | Worst case: 4.5:1 floor, measured |
|---|---|---|---|---|
| aurora violet / cyan / magenta | abyss, deck only | 0.20 / 0.13 / 0.08 | 0.12 / 0.08 / 0.05 | muted text 5.12 dark, 4.59 light |
| bloom brand / danger | abyss, deck only | 0.20 / 0.16 | 0.10 / 0.08 | muted text 5.21 dark, 4.71 light |
| spotlight | all five grounds | 0.12 | 0.08 | muted text 4.76 dark, 4.65 light |
| row wash (`--wash-row`), team and status hues | abyss, deck, panel, raised | 0.08 | 0.05 | label, secondary and muted text 4.57 dark, 4.91 light |
| chip tint | all five grounds | 0.15 | 0.15 | icon 3.44 dark, 3.63 light (graphic floor 3); text-primary label 9.64 dark, 12.01 light |
| red-team vignette (inset shadow, §8) | abyss, deck, panel (paints under dialogs and the top bar) | 0.22 nominal, 0.170 at the edge | 0.12 nominal, 0.093 at the edge | muted text 4.70 dark, 4.63 light |

The row wash is a per-theme token, not a fixed alpha, and that came from looking at the screenshots
rather than the maths: 8% of a dark hue is a quiet tint on navy but, on near-white paper, turned the
feed into dirty beige-and-khaki stripes, so light restates `--wash-row` at 5%.

Two other first drafts failed the same computation and were corrected rather than waved through.
Light principal, runner and red team (and later status ok) sat within half a point of the floor, and a
feed label sits on a wash of its *own* hue, which costs about 0.5:1: `#85600F` / `#0F7656` / `#C42B48`
fell to 4.50 / 4.38 / 4.29 and `#0E7550` to 4.46, so each is now a shade darker (§3.2). And a chip's
*label* is `--text-primary`, never the tone colour, because tone text on its own tint fell to 3.7:1 on
the light theme; only the chip's icon takes the tone, and an icon needs 3:1.

A fully stacked worst case (all three aurora peaks at one pixel) does fail, so the guard is
deliberately *per layer at its peak*, and the three glow centres are placed far apart (top-left,
top-right, bottom-right), each falling to transparent by 70%, so no pixel sees more than one at
anything near peak. `tokens.contrast.test.ts` composites every translucent layer in the aurora,
spotlight and bloom tokens over each ground it can sit on and fails the build if any of
`--text-primary/secondary/muted` drops under 4.5:1; a separate case does the same for the 8% team
wash. The dark worst case still lands on `--surface-raised`, so the existing "every quoted worst
case sits on raised" assertion holds, now with new figures.

---

## Backend additions M9b lands first

Types are generated from OpenAPI, never hand-written. Each item gets unit tests before being wired
to the UI.

| Change | File |
|---|---|
| Add `code: str` and truncated `stdout` / `stderr` to `ExperimentResult`; populate from `SandboxResult` | `foundry/models.py`, `foundry/teams/experiment_runner.py` |
| Add `experiments`, `invalidations`, `model_card_md`, `data_profile` to `RunStatus` | `app/schemas.py`, `app/runs.py` |
| `GET /runs/{id}/experiments` returning `list[ExperimentResult]` | `app/main.py` |
| `GET /eval` returning the parsed `artifacts/eval/results.json` | `app/main.py` |
| JSONL event recording, plus `GET /replays` and `GET /replays/{name}` | new `app/replay.py` |
| Rehydrate `GET /runs` from the checkpointer, not just `_handles` | `app/runs.py` |

---

## Self-critique against SPEC's avoid-list

Revisions made to the plan, not hypotheticals.

1. **Near-black plus a single neon accent.** First pass was a `#0A0D10` ground with one cyan
   accent. Revised to a blue-slate ground across five layers and **no single accent**: six
   functional team hues plus a separate status ramp. Color answers "who acted" and "what state",
   so it cannot collapse into decoration. *Residual risk:* six hues could read as a rainbow.
   Mitigated by low saturation, by restricting them to a 3px rail and a glyph, and by using no team
   color at all in the leaderboard or any table.
2. **Identical rounded cards with the same soft grey shadow.** First pass had one
   `--radius-card: 8px` and one elevation shadow on every panel. Revised: radius encodes
   permanence (3px docked, 10px floating); docked panels carry no box-shadow and separate by
   border and surface hue; the system defines exactly one shadow, tinted, for the float layer only.
   Runs home changed from a card grid to a dense table for the same reason.
3. **Gradient washes as decoration.** Cut a planned gradient behind the run header. The only
   gradients left encode data: the budget meter's projected-spend hatch and the red-team connector
   stroke.
4. **ALL-CAPS tracked-out eyebrow labels.** First wireframe had `ACTIVITY`, `BUDGET`,
   `LEADERBOARD` as tracked caps. Revised to sentence-case `--text-xs` in `--text-muted` at normal
   tracking, and the scale defines no letter-spacing token above `0.01em`, so it cannot return by
   habit.
5. **Middle-dot-joined meta strings.** First top bar read `churn · run 5c25…37 · $12.84 · 14:02`.
   Revised: meta is spaced columns with a muted micro-label and a mono value; separation is
   whitespace and a 1px rule, never a glyph. The same fix applied to feed rows, where timestamp and
   cost became right-aligned columns.
6. **`→` appended to buttons.** Cut. "View experiment →" became "Open experiment". Buttons state the
   action only. The one arrow-like glyph remaining is the replay transport `⏴⏵`, a transport
   control rather than a button affordance.
7. **Numbered markers on non-sequences.** Audited each numbered element. Leaderboard ranks are a
   real ordering (`LeaderboardEntry.rank`), self-debug attempts are a real sequence
   (`ExperimentResult.attempts`), and the phase ladder is genuine pipeline order, so all keep their
   numbers. The gate dialog's context blocks were numbered 1/2/3 in the first draft; those are
   parallel facts, not steps, and became unnumbered labeled rows.

Two critiques beyond SPEC's list:

- **Density versus the 375px requirement.** The fixed three-column frame is the entire concept and
  it cannot survive 375px. The columns are not reflowed into a scroll stack, because that would
  destroy the one rule the design is built on. Mobile keeps a 44px sticky bar with the three values
  that must never be lost, and demotes everything else to tabs. A deliberate trade, not an
  oversight.
- **Unverified accessibility claims.** The first draft asserted AA without computing it, and
  computing it found seven failures, one of them on the red-team alert itself. Fixed in §3 and
  recorded in §11.

8. **Flat, motionless surfaces read as unfinished rather than restrained.** M9a–M9f's console had
   real motion (§7), but all of it was data-driven — it fired on events, never on the pointer.
   Leaderboard rows, audit rows, and both dense tables were clickable with no hover or focus
   feedback beyond the unstyled default; the whole app had three CSS transitions total. Checked
   against real screenshots rather than against the token list, the flatness read as an incomplete
   build, not a deliberate one — and primary actions ("Start run", "Approve") were visually
   identical to secondary ones ("Reject"), which is a usability gap, not only a taste question.
   M9g's fix is scoped narrowly: one accent color (§3.1) for primary actions and focus emphasis
   only, a tokenized shadow ladder (§3.3) that fires on interaction rather than at rest, and an
   interaction-motion table (§7) that runs alongside the event-driven one rather than replacing it.
   What stays cut, unchanged from critiques 1–7: no second accent, no box-shadow on a docked panel
   at rest, no shimmer across a dense grid of simultaneous skeletons (a single skeleton may now
   sweep; §9), no tracked caps, no weight above 600.

9. **Restraint was the defect, and M9g under-corrected it (M9h).** Critique 8 fixed the *symptoms*
   narrowly — one accent, a shadow ladder, hover states — and left the cause: a contract written to
   avoid every AI-default trope also avoided colour, depth, iconography and atmosphere. The
   console still read as cheap, and the screenshots say why: five near-identical slate greys with no
   atmosphere; 3px-radius boxes with 1px grey borders; colour limited to 3px rails and 6px dots;
   text-glyph "icons" (`· ✓ ◐ ● ⊘ ▼`); a plain-text wordmark; 12px muted panel titles; browser-default
   select, range slider, links and scrollbars; and, on page screens, a lighter centre band that
   looked like a rendering bug. M9h therefore lifts the restraint rules that produced those
   (§12.1) rather than patching around them, and keeps the ones that guard against *actual*
   generic-AI tells: no ALL-CAPS tracked eyebrows, no middle-dot meta strings, no `→` on buttons, no
   numbered non-sequences, no cream/terracotta, no look-alike cards. The mechanical guards were kept
   and extended, not relaxed: a new `no-hover-motion` rule, and a contrast composite test for every
   translucent layer.

---

## 12. M9h revision — "Aurora"

M9h is a visual overhaul that changes material, colour, type, iconography and motion. It does not
touch layout geometry (§5), data flow, the run sources, the replay format, the choreography's logic
and timings (§8), or the backend. Direction chosen with the operator: **Aurora** (indigo-ink ground,
violet → blue → cyan identity gradient, vivid team and status colour, glass and gradient-hairline
materials). Staged: **h1** foundation, shell and live run view; **h2** runs home, report, eval and
states; **h3** motion polish and hardening (Lighthouse, reduced-motion audit, mobile and light passes).

### 12.1 Rules overridden, and rules that stay

| Rule before | Now |
|---|---|
| SPEC avoid-list "gradient washes used as decoration"; critique 3 | Allowed when tokenized and capped (§12.3): one brand gradient, one ambient aurora, state-coloured meter fills, gradient hairlines |
| §2 and SPEC "boldness spent once" | Boldness goes into material, brand and live state; the red-team moment stays the single loudest (§8) |
| SPEC "no fade-slide-up on every section, no hover bounce" | One route entrance plus one cascade per route mount; hover = glow, spotlight, border; never a lift or scale (`no-hover-motion`) |
| §3.3 radius encodes permanence, 3/4/10px | Radius encodes role: 14 / 10 / 8 / 20 / pill |
| §3.3 / M9g no resting shadow on docked panels | Tinted layered `--shadow-panel`; glow reserved for semantic state |
| §3.1 team hue "never a fill" | 15% icon chips and a row wash (8% dark, 5% light); still never in the leaderboard or any table |
| §3.1 one accent, no second | A three-stop brand gradient is the identity; solid `--accent` remains for label-on-fill |
| §7 and §9 "no pulse, no glow", shimmer-free skeleton | Glow and a ping ring for live/running/critical, always beside a text label; skeletons get a travelling highlight |
| §4 IBM Plex | Geist and Geist Mono; Newsreader unchanged |

**Stays:** the 216 / fluid / 340 frame, 56px top bar, mobile 44px instrument bar and tabs; WCAG AA
(test-enforced, both themes); reduced-motion handling; team identity as label + icon + hue; tabular
numerics; Approve arms for 400ms and Enter does not submit; the 2px focus ring; no ALL-CAPS tracked
eyebrows, no middle-dot meta strings, no `→` on buttons, no numbered non-sequences, no cream or
terracotta, no weight above 600; no raw colour and no literal shadow outside `tokens.css`; Radix
dialogs, fully restyled; `--text-display` stays reserved for the red-team category and the report's
final metric, so new hero numerals use `--text-2xl`.

### 12.2 New tokens

All live in `tokens.css`, the only file allowed a raw colour, and are defined in both themes.

- **Brand and gradients:** `--brand-1/2/3`, `--accent-to`, `--gradient-brand`, `--gradient-brand-deep`,
  `--gradient-border`, `--gradient-danger` (the red-team category word, §8),
  `--gradient-meter-{safe,pressure,critical}` with `--meter-pressure-end` and `--meter-critical-end`.
- **Ambient and washes:** `--aurora` (three radial layers), `--grain`, `--spotlight-color`,
  `--bloom-brand`, `--bloom-danger`, `--sheen`, and `--wash-row`, the per-theme strength of a feed or
  roster row's tint (8% dark, 5% light; the `wash` utility reads it). The spotlight's *gradient* is built in `base.css`, not
  here: a custom property holding `var(--mx)` substitutes where it is declared, so it would freeze at
  its fallback instead of following the pointer. There is no separate "alpha cap" token; the guard
  composites each layer's own alpha (§11), which is stricter and cannot drift from the value it checks.
- **Shadows:** `--shadow-panel`, `--shadow-glow-{brand,ok,warn,danger}`, `--shadow-vignette-danger`;
  the existing four re-tinted.
- **Shape and type:** `--radius-chip` plus the new radii (§3.3); `--font-sans` and `--font-mono` now
  Geist; `--tracking-tight`.
- **Motion:** `--ease-spring`, `--dur-ambient` (40s), `--dur-sheen` (2.4s).

### 12.3 Ambient layer, washes, and the alpha rule

`AmbientBackground` is a fixed, `aria-hidden`, `pointer-events: none` layer behind the frame: the
aurora gradients plus a fine grain tile (which also breaks up gradient banding on dark). The root
that hosts it is `isolate` so the layer paints above the root's own ground and below content. The
live view's centre column is `--surface-deck` at 60% so the aurora glows through; the rail and dock
sit directly on it. Washes never exceed the alphas verified in §11, and nothing in the aurora
animates anything but `transform`.

The three glows are placed so their *peaks are on screen*. The layer is inset -15% on every side (so
the drift never exposes an edge), which makes it 130% of the viewport, so a layer position `p` lands at
`(p x 1.3 - 15)%` of the screen. The first draft put the peaks at 10% / 6%, just off the top-left
corner, and only the faint tail showed; measured pixels at the top-left read `#171534` against a
`#0A0C1C` ground. They now land near 13% / 19% (violet), 89% / 92% (cyan) and 79% / 16% (magenta),
and the same pixel reads `#211C46`, with the violet reaching down the whole left side.

### 12.4 Iconography

`lucide-react`, imported per icon. Teams: principal `Compass`, data `Database`, modeling
`BrainCircuit`, runner `FlaskConical`, red team `ShieldAlert`, reporter `FileText`. State glyphs
(`✓ ◐ · ● ⊘ ▼`) become icons with the same sr-only state word the glyph had, so no state is carried by
an icon alone. The wordmark is a geometric "F" in a gradient squircle (`Logo`), also the favicon.

### 12.5 Material guide

- **Panel:** opaque `--surface-panel`, 14px, gradient hairline (mask-composite ring), `--shadow-panel`,
  13px semibold secondary title with an optional icon, cursor spotlight on pointer-fine devices.
- **Button:** primary is the deep gradient with a sheen sweep and glow on hover; default is a bordered
  panel surface; quiet is text until hovered. Press is `scale(0.98)`; hover never moves.
- **Chip:** tinted `bg-<token>/15` with a token-coloured icon or dot and a text label.
- **Float layer:** 20px glass with a gradient hairline and a bloom behind it.
- **Controls:** styled select with a chevron, glow focus on inputs beside the unchanged 2px ring,
  custom range slider and thin scrollbars, all from tokens.
- **Gradient text:** hero numerals (budget and gate now; the report metric arrives in h2) in the brand
  gradient, the red-team category word in the danger gradient (`danger-text`), and the wordmark, which
  is a logotype and so exempt from the contrast minimum (WCAG 1.4.3). Otherwise always large text.
