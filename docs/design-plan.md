# foundry operator console — design plan (M9a)

Status: approved design, no code. This is the contract for M9b–M9f. CLAUDE.md requires the
frontend to follow it exactly; a change to anything here means re-entering Plan Mode, not
improvising in code.

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

---

## 3. Color tokens

Two complete themes, not an inversion. Dark is primary. All values are CSS custom properties on
`:root` and `:root[data-theme="light"]`. Components reference tokens only, never raw hex.

Contrast figures below are the **worst case across all five surfaces** of that theme (see §11 for
method and the full check).

### 3.1 Dark — "instrument slate"

Five ground layers, hue ~215. Elevation in the docked layer comes from a surface-hue shift plus a
1px border, never a shadow.

| Token | Hex | Use |
|---|---|---|
| `--surface-abyss` | `#0D1117` | page behind the frame |
| `--surface-deck` | `#141A22` | main panel ground |
| `--surface-panel` | `#1A212B` | docked panels |
| `--surface-raised` | `#222B36` | drawers, dialogs, hover, the red-team alert |
| `--surface-inset` | `#0F151C` | wells: code, stdout, meter track |
| `--line-hairline` | `#232C38` | dividers inside a panel (decorative) |
| `--line-strong` | `#33404F` | panel edges (decorative) |
| `--line-control` | `#62798F` | input and button boundaries, 3.2:1 |
| `--line-focus` | `#6494F0` | focus ring, 2px at 2px offset, 4.8:1 |
| `--text-primary` | `#E6EDF5` | 12.1:1 (14.8:1 on deck) |
| `--text-secondary` | `#9FB0C3` | 6.5:1 (7.9:1 on deck) |
| `--text-muted` | `#8396AB` | 4.7:1 (5.8:1 on deck) — the text floor |

**Team hues.** Each agent team owns one desaturated hue. This is functional encoding — it answers
"who acted" at a glance in a dense feed. Used only as a 3px left rail and a small glyph. Never as
a fill. Never in a table.

| Token | Hex | Team | Min contrast |
|---|---|---|---|
| `--team-principal` | `#C9B27A` | principal | 6.9:1 |
| `--team-data` | `#5FA8C7` | data_team | 5.4:1 |
| `--team-modeling` | `#8C9EE0` | modeling_team | 5.5:1 |
| `--team-runner` | `#6FB39A` | experiment_runner | 5.9:1 |
| `--team-redteam` | `#E5726D` | red_team | 4.7:1 |
| `--team-reporter` | `#B08CC7` | reporter | 5.1:1 |

Every team row also carries a text label and a distinct glyph, so hue is redundant encoding (WCAG
1.4.1). This matters most for `--team-runner` against `--team-redteam`, the red/green pair.

**Status ramp**, deliberately separate from team hues because "who" and "what state" are different
questions:

| Token | Hex | Min contrast |
|---|---|---|
| `--status-ok` | `#4FB286` | 5.5:1 |
| `--status-warn` | `#D9A44C` | 6.4:1 |
| `--status-danger` | `#E5726D` | 4.7:1 |
| `--status-info` | `#6494F0` | 4.8:1 |
| `--status-idle` | `#66798D` | 3.2:1, graphic use only |

`--status-danger` is intentionally the same value as `--team-redteam`: invalidation *is* the
danger state. `--status-idle` is for dots and glyphs and always paired with a text label in
`--text-muted`; it is not a text color.

**Budget meter.** A continuous quantity gets its own ramp:

| Token | Value | Threshold |
|---|---|---|
| `--meter-track` | `#232C38` | — |
| `--meter-safe` | `#4FB286` | under 70% of cap |
| `--meter-pressure` | `#D9A44C` | 70–90% |
| `--meter-critical` | `#E5726D` | over 90% |
| `--meter-projected` | `#D9A44C` at 35% | 45° hatch, the `projected_usd` beyond spend |

The meter is never the only carrier of its value: a numeric readout always sits beside it.

### 3.2 Light — "datasheet"

Cool neutral paper. Not an inversion of dark, and explicitly not cream.

| Token | Hex |
|---|---|
| `--surface-abyss` | `#EEF1F5` |
| `--surface-deck` | `#F7F9FB` |
| `--surface-panel` | `#FFFFFF` |
| `--surface-raised` | `#FFFFFF` (bordered with `--line-strong`) |
| `--surface-inset` | `#EDF1F5` |
| `--line-hairline` | `#DCE3EB` |
| `--line-strong` | `#C2CDD9` |
| `--line-control` | `#718AA6` |
| `--line-focus` | `#2A5FC7` |
| `--text-primary` | `#131A22` |
| `--text-secondary` | `#45566A` |
| `--text-muted` | `#5A6D83` |

Team hues, same hue angle, lower lightness to hold contrast on paper: principal `#82662A`, data
`#1F6F91`, modeling `#4A5CB0`, runner `#2A775E`, red team `#C0342E`, reporter `#7A4F94`.

Status: ok `#1F7A55`, warn `#8E620E`, danger `#C0342E`, info `#2A5FC7`, idle `#6B7D91`.

### 3.3 Shape and elevation

Radius encodes **permanence**.

| Token | Value | Applies to |
|---|---|---|
| `--radius-panel` | `3px` | docked panels — rack-mounted, nearly square |
| `--radius-control` | `4px` | buttons, inputs |
| `--radius-float` | `10px` | drawers, gate dialogs, the red-team alert |
| `--radius-pill` | `999px` | replay speed selector, status dots only |

**No `box-shadow` exists in the docked layer.** The system defines exactly one shadow, for the
float layer, and it is tinted rather than neutral grey:
`--shadow-float: 0 16px 40px -12px rgba(6, 10, 16, 0.72)`.

Spacing is a 4px grid: `4 8 12 16 24 32 48 64`.

---

## 4. Typefaces

| Role | Family | Weights | Why |
|---|---|---|---|
| Interface | **IBM Plex Sans** | 400, 500, 600 | drawn for technical interfaces; shares metrics with Plex Mono |
| Measured values | **IBM Plex Mono** | 400, 500 | every number: cost, metric, duration, `seq`, timestamp, `experiment_id` |
| Produced document | **Newsreader** | 400, 500 | report view and model card only |

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
across the full 1400ms. Nothing pulses, nothing glows, nothing bounces.

`aria-live="assertive"` announces it once. Everything else in the app is `polite` and throttled.

The sequence reads as one sentence: *this one was leading, the red team looked at it, it is gone,
here is why.*

---

## 9. States

Skeletons mirror the real grid: the three-column frame renders immediately with panel outlines and
shimmer-free muted blocks, so nothing reflows on load. Empty states name the next action ("No runs
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
