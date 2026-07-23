#!/usr/bin/env bash
# OBSERVER_VERSION=4
# ══════════════════════════════════════════════════════════════════════════
#  GLOBAL AUTORESEARCH OBSERVER  v3
#
#  Extension point: this hook fires BEFORE each autoresearch iteration.
#  Receives JSON payload on stdin (BeforeHookPayload), outputs steer text on
#  stdout (delivered to the agent as a steer message).
#
#  Triggers (priority order — first match wins):
#    🔊 NOISE GATE   — system noise > best + 10% → warning (T6)
#    🔬 FLOOR        — metric stable across 15+ runs → finalize recommend (T1)
#    🏁 FINALIZE     — agent wrote finalize entry → /autoresearch off (T4)
#    🔄 STAGNATION   — N consecutive runs without new best (escalating)
#    🎯 PROGRESS     — every M improvements (trend analysis)
#
#  ASI-aware steers (T2): parses asi fields from recent log entries and
#  adapts stagnation messages — skips "profile the code" if already profiled,
#  recommends finalize if agent proved floor/impossible.
# ══════════════════════════════════════════════════════════════════════════

set -uo pipefail

# ── Bootstrap jq (Windows Git Bash workaround) ────────────────────────────
if ! command -v jq &>/dev/null; then
  for p in \
    "/c/Users/${USER:-${USERNAME:-user}}/AppData/Local/Microsoft/WinGet/Links" \
    "${LOCALAPPDATA:-}/Microsoft/WinGet/Links" \
    "${HOME:-}/AppData/Local/Microsoft/WinGet/Links"; do
    [ -n "$p" ] && [ -x "$p/jq.exe" ] && export PATH="$PATH:$p" && break
  done
fi
command -v jq &>/dev/null || exit 0

# ── Config ────────────────────────────────────────────────────────────────
readonly STAGNATION_THRESHOLD=5
readonly PROGRESS_MILESTONE=5
readonly FLOOR_STREAK_THRESHOLD=15       # T1: min streak for floor detection
readonly FLOOR_CV_THRESHOLD=0.15         # T1: coefficient of variation < this = stable
readonly NOISE_GATE_MARGIN=1.10          # T6: noise_min > best * 1.10 = gate
readonly NOISE_SAMPLES=3                 # T6: quick diagnostic samples

# ── Parse stdin ───────────────────────────────────────────────────────────
input="$(cat)"
cwd="$(jq -r '.cwd' <<<"$input")"
direction="$(jq -r '.session.direction // "lower"' <<<"$input")"
metric_unit="$(jq -r '.session.metric_unit // ""' <<<"$input")"
baseline_metric="$(jq -r '.session.baseline_metric // ""' <<<"$input")"
best_metric_payload="$(jq -r '.session.best_metric // ""' <<<"$input")"

# ── Resolve log file ──────────────────────────────────────────────────────
jsonl=""
[ -f "$cwd/.auto/log.jsonl"   ] && jsonl="$cwd/.auto/log.jsonl"
[ -z "$jsonl" -a -f "$cwd/autoresearch.jsonl" ] && jsonl="$cwd/autoresearch.jsonl"
[ -z "$jsonl" ] && exit 0

# ── Compute state (jq: reduce → best, streak, improvements, recent, history) ─
state_json="$(jq -rs --arg dir "$direction" '
  (. | map(select(.run != null and (.type // null) != "hook" and (.type // null) != "finalize"))) as $runs
  | if ($runs | length) == 0 then
      {streak:0, improvements:0, best:null, recent:[], imp_history:[], recent_metrics:[]}
    else
      ($runs[-1].segment // 0) as $seg
      | ($runs | map(select(.segment == $seg))) as $sr
      | if ($sr | length) == 0 then
          {streak:0, improvements:0, best:null, recent:[], imp_history:[], recent_metrics:[]}
        else
          (reduce $sr[] as $r (
            {best:null, streak:0, improvements:0, recent:[], imp_history:[], recent_metrics:[]};
            (if ($r.status == "keep") and ($r.metric != null) and ($r.metric != 0) and
               (.best == null or
                ($dir == "lower"  and $r.metric < .best) or
                ($dir == "higher" and $r.metric > .best))
             then  # New best — real improvement
              {best:$r.metric, streak:0, improvements:(.improvements+1), recent:[],
               imp_history:(.imp_history+[$r.metric]), recent_metrics:(.recent_metrics+[$r.metric])}
             else  # Non-improving
              {best:.best, streak:(.streak+1), improvements:.improvements,
               recent:(.recent+[$r]), imp_history:.imp_history,
               recent_metrics:(.recent_metrics + ([$r.metric // empty]))}
             end)
          ))
        end
      end
' "$jsonl" 2>/dev/null)" || exit 0

# ── Extract fields ────────────────────────────────────────────────────────
streak="$(jq -r '.streak'          <<<"$state_json")"
improvements="$(jq -r '.improvements' <<<"$state_json")"
best_metric="$(jq -r '.best // ""'    <<<"$state_json")"
[[ "$streak" =~ ^[0-9]+$ ]] || streak=0
[[ "$improvements" =~ ^[0-9]+$ ]] || improvements=0

ideas_hint="$cwd/.auto/ideas.md"

# ── T2: Parse ASI from recent log entries for context-aware steers ────────
recent_asi="$(jq -rs --argjson n 5 '
  [.[] | select(.run != null) | .asi // empty]
  | .[-($n):]
  | map(.learned // .hypothesis // .proof // .rollback_reason // .next_action_hint // "")
  | .[]
' "$jsonl" 2>/dev/null | tr '\n' ' ')"

asi_floor=false
asi_profiled=false
asi_noise=false
asi_exhausted=false
echo "$recent_asi" | grep -qiE "floor|impossible|provably|0%|irreducible|exhausted|structural.*limit|theoretical.*limit|cannot.*influence|optimally|optimal" && asi_floor=true
echo "$recent_asi" | grep -qiE "profil|measured|benchmarked|breakdown|spawnSync|execSync|hrtime|timing" && asi_profiled=true
echo "$recent_asi" | grep -qiE "noise|outlier|variance|startup.*cost|process.*creation" && asi_noise=true
echo "$recent_asi" | grep -qiE "exhaust|tried.*all|no.*untried|provably.*complete|optimization.*complete" && asi_exhausted=true

# ── T2: Also check ideas.md for marker words (fallback) ───────────────────
if [ "$asi_floor" = false ] && [ -f "$ideas_hint" ]; then
  grep -qiE "PROVEN COMPLETE|MATHEMATICALLY IMPOSSIBLE|FLOOR REACHED|PROVABLY" "$ideas_hint" && asi_floor=true
fi

# ── T4: Check for finalize entries ────────────────────────────────────────
finalize_confidence="$(jq -r 'select(.type == "finalize") | .confidence // empty' "$jsonl" 2>/dev/null | tail -1)"

# ══════════════════════════════════════════════════════════════════════════
# TRIGGER 0: FINALIZE SIGNAL (T4) — agent explicitly signaled completion
# ══════════════════════════════════════════════════════════════════════════
if [ -n "$finalize_confidence" ]; then
  conf_pct="$(awk -v c="$finalize_confidence" 'BEGIN { printf "%.0f", c * 100 }' 2>/dev/null || echo "?")"
  finalize_reason="$(jq -r 'select(.type == "finalize") | .reason // "no reason given"' "$jsonl" 2>/dev/null | tail -1)"

  if [ "$(awk -v c="$finalize_confidence" 'BEGIN { print (c > 0.8) ? 1 : 0 }')" = "1" ]; then
    cat <<EOF
🏁 FINALIZE SIGNAL (confidence ${conf_pct}%): Agent signaled optimization is complete.
   Reason: ${finalize_reason}

   The agent has explicitly recorded a finalize entry with high confidence.
   Strongly recommended: run /autoresearch off to finalize this session.
   To override: delete the finalize entry from .auto/log.jsonl or set confidence < 0.8.
EOF
    exit 0
  elif [ "$(awk -v c="$finalize_confidence" 'BEGIN { print (c > 0.5) ? 1 : 0 }')" = "1" ]; then
    cat <<EOF
🏁 FINALIZE SIGNAL (confidence ${conf_pct}%): Agent signaled possible completion.
   Reason: ${finalize_reason}

   Consider whether further optimization is worth the cost.
   Run /autoresearch off if you agree, or continue if you disagree.
EOF
    exit 0
  fi
fi

# ══════════════════════════════════════════════════════════════════════════
# TRIGGER 1: NOISE GATE (T6) — system noise > best + margin
# ══════════════════════════════════════════════════════════════════════════
# Only run noise diagnostic if we have a best metric and a measure.sh to test
if [ -n "$best_metric" ] && [ "$best_metric" != "null" ] && [ -f "$cwd/.auto/measure.sh" ]; then
  # Check for override in config
  noise_gate_mode="$(jq -r '.noise_gate // "warn"' "$cwd/.auto/config.json" 2>/dev/null || echo "warn")"
  if [ "$noise_gate_mode" != "off" ]; then
    # Quick noise diagnostic: time 3 minimal bash invocations
    noise_samples=()
    for _i in $(seq 1 $NOISE_SAMPLES); do
      t0=$(date +%s%N 2>/dev/null || python -c "import time;print(int(time.time()*1e9))" 2>/dev/null || echo 0)
      bash -c 'true' 2>/dev/null
      t1=$(date +%s%N 2>/dev/null || python -c "import time;print(int(time.time()*1e9))" 2>/dev/null || echo 0)
      if [ "$t0" -gt 0 ] && [ "$t1" -gt 0 ]; then
        delta_ms=$(( (t1 - t0) / 1000000 ))
        noise_samples+=("$delta_ms")
      fi
    done

    if [ ${#noise_samples[@]} -ge 2 ]; then
      # Compute minimum (best-case noise floor)
      noise_min=$(printf '%s\n' "${noise_samples[@]}" | sort -n | head -1)

      # Compare against best (only for "lower" direction — noise gate makes sense when lower is better)
      if [ "$direction" = "lower" ] && [ "$noise_min" -gt 0 ]; then
        # Use awk for float comparison
        noise_exceeds=$(awk -v n="$noise_min" -v b="$best_metric" -v m="$NOISE_GATE_MARGIN" \
          'BEGIN { print (n > b * m) ? 1 : 0 }')

        if [ "$noise_exceeds" = "1" ]; then
          noise_delta=$(awk -v n="$noise_min" -v b="$best_metric" 'BEGIN { printf "%.1f", ((n - b) / b * 100) }')
          if [ "$noise_gate_mode" = "hard" ]; then
            cat <<EOF
🔇 NOISE GATE (hard): System noise floor (${noise_min}ms) exceeds best (${best_metric}${metric_unit}) by ${noise_delta}%.
   Current conditions cannot produce an improvement. Experiment SKIPPED.

   Options:
   → Wait for system load to decrease and retry
   → Set "noise_gate": "off" in .auto/config.json to disable
   → Run /autoresearch off and finalize
EOF
            exit 0
          else
            cat <<EOF
🔇 NOISE WARNING: System noise floor (${noise_min}ms) exceeds best (${best_metric}${metric_unit}) by ${noise_delta}%.
   This experiment will almost certainly be a discard.

   To suppress: set "noise_gate": "off" in .auto/config.json
   To hard-block: set "noise_gate": "hard" in .auto/config.json
EOF
            exit 0
          fi
        fi
      fi
    fi
  fi
fi

# ══════════════════════════════════════════════════════════════════════════
# TRIGGER 2: FLOOR DETECTION (T1) — metric stable across many runs
# ══════════════════════════════════════════════════════════════════════════
if [ "$streak" -ge "$FLOOR_STREAK_THRESHOLD" ]; then
  # Compute coefficient of variation (CV) of recent metrics
  recent_metrics_csv="$(jq -r --argjson n 10 '
    [.recent_metrics[] | select(. != null and . != 0)]
    | .[-($n):] | @csv
  ' <<<"$state_json" 2>/dev/null)"

  if [ -n "$recent_metrics_csv" ]; then
    cv_info="$(echo "$recent_metrics_csv" | awk -F',' '
      {
        n = NF; if (n < 5) { print "INSUFFICIENT"; exit }
        sum = 0; for (i=1; i<=n; i++) sum += $i
        mean = sum / n
        var = 0; for (i=1; i<=n; i++) var += ($i - mean)^2
        var /= n; std = sqrt(var)
        cv = (mean > 0) ? std / mean : 1
        printf "%.4f %.2f %.2f %d", cv, mean, std, n
      }
    ')"

    cv_value="${cv_info%% *}"  # first field = CV
    cv_rest="${cv_info#* }"    # remaining fields
    cv_mean="$(echo "$cv_rest" | awk '{print $1}')"
    cv_std="$(echo "$cv_rest" | awk '{print $2}')"
    cv_n="$(echo "$cv_rest" | awk '{print $3}')"

    # Check for floor override
    floor_override="$(jq -r '.auto_floor_override // false' "$cwd/.auto/config.json" 2>/dev/null || echo "false")"

    is_floor=false
    if [ "$floor_override" != "true" ] && [ "$cv_value" != "INSUFFICIENT" ]; then
      cv_below=$(awk -v c="$cv_value" -v t="$FLOOR_CV_THRESHOLD" 'BEGIN { print (c < t) ? 1 : 0 }')
      if [ "$cv_below" = "1" ]; then
        is_floor=true
      fi
    fi

    # T1+T2: Floor detection OR ASI proves floor/exhaustion
    if [ "$is_floor" = "true" ] || { [ "$streak" -ge 20 ] && [ "$asi_floor" = "true" ]; }; then
      trigger_reason="variance"
      [ "$is_floor" = "false" ] && trigger_reason="asi_proof"

      cat <<EOF
🔬 FLOOR DETECTED: Optimization has reached its structural limit (trigger: ${trigger_reason}).
$([ "$trigger_reason" = "variance" ] && echo "   Metric stable at ~${cv_mean}${metric_unit} ± ${cv_std}${metric_unit} (CV=${cv_value}, n=${cv_n}) across ${streak} non-improving runs.")
$([ "$trigger_reason" = "asi_proof" ] && echo "   Agent ASI/ideas.md contains proof that further optimization is impossible.")
$([ "$asi_profiled" = "true" ] && echo "   Profiling data confirms the limit is structural, not algorithmic.")

   Evidence:
   - Best: ${best_metric:-?}${metric_unit}
   - Streak: ${streak} non-improving runs
$([ "$trigger_reason" = "variance" ] && echo "   - Recent median: ${cv_mean}${metric_unit} ± ${cv_std}${metric_unit}")
$([ -f "$ideas_hint" ] && echo "   - Reflections in ${ideas_hint}")

   RECOMMENDED ACTION:
   → Run /autoresearch off and finalize
   → Or call finalize_research(reason="...", confidence=0.9)
   → Or start a fresh segment with a different metric/target

   To override: set "auto_floor_override": true in .auto/config.json
EOF
      exit 0
    fi
  fi
fi

# ══════════════════════════════════════════════════════════════════════════
# TRIGGER 3: STAGNATION  (streak ≥ THRESHOLD, modulo cooldown)
# ══════════════════════════════════════════════════════════════════════════
if [ "$streak" -ge "$STAGNATION_THRESHOLD" ] && [ $((streak % STAGNATION_THRESHOLD)) -eq 0 ]; then

  level=$((streak / STAGNATION_THRESHOLD))

  # ── Format recent runs ────────────────────────────────────────────────
  recent_formatted="$(jq -r --argjson n "$STAGNATION_THRESHOLD" '
    .recent[-($n):]
    | .[]
    | if .metric != null and .metric != 0
      then "  • \(.status // "?") — \"\(.description // "(no desc)")\" (\(.metric))"
      else "  • \(.status // "?") — \"\(.description // "(no desc)")\" (failed)"
      end
  ' <<<"$state_json" 2>/dev/null)"

  # ── Status pattern detection ─────────────────────────────────────────
  status_list="$(jq -r --argjson n "$STAGNATION_THRESHOLD" '
    .recent[-($n):] | .[].status // "unknown"
  ' <<<"$state_json" 2>/dev/null | tr -d '\r')"

  crash_count=0; discard_count=0; keep_count=0; other_count=0
  for s in $status_list; do
    case "$s" in
      crash|checks_failed) crash_count=$((crash_count + 1)) ;;
      discard)             discard_count=$((discard_count + 1)) ;;
      keep)                keep_count=$((keep_count + 1)) ;;
      *)                   other_count=$((other_count + 1)) ;;
    esac
  done
  total=$((crash_count + discard_count + keep_count + other_count))

  # Determine dominant pattern
  if [ "$crash_count" -eq "$total" ] && [ "$total" -gt 0 ]; then
    pattern_hint="🔧 TECHNICAL: All recent runs CRASHED. Your code is breaking — fix stability before optimizing further."
  elif [ "$discard_count" -eq "$total" ] && [ "$total" -gt 0 ]; then
    pattern_hint="📉 DIRECTION: All recent runs DISCARDED. Your optimization approaches aren't working — change direction entirely."
  elif [ "$keep_count" -eq "$total" ] && [ "$total" -gt 0 ]; then
    pattern_hint="⚠️  SELECTIVITY: All recent runs KEPT but none improved the metric. You may be accepting changes that don't help — be more selective."
  else
    pattern_hint="🔀 MIXED: Outcomes vary (crash:$crash_count discard:$discard_count keep:$keep_count). Find what DIFFERS between successes and failures."
  fi

  # ── T2: ASI-aware escalation messages ────────────────────────────────
  # If agent already proved floor/exhaustion, skip generic advice
  if [ "$asi_floor" = "true" ] || [ "$asi_exhausted" = "true" ]; then
    cat <<EOF
🔄 STAGNATION: No metric improvement in ${streak} runs.

⚠️  ASI CONTEXT: Your recent log entries already contain proof that further
   optimization is impossible or exhausted. The limit appears structural.

   Best: ${best_metric:-?}${metric_unit}
   ${pattern_hint}

   RECOMMENDED: Call finalize_research() or run /autoresearch off.
   The observer will not ask you to "change direction" again — the evidence
   in your ASI fields shows there is nowhere to change TO.
EOF
    exit 0
  fi

  # ── Progressive escalation message ───────────────────────────────────
  # Each level adds a parallel-mode recommendation matched to the situation.
  case "$level" in
    1) escalation="

💡 PARALLEL HINT: Stuck on the same approach? Try BestOfN with 3 different hypotheses:
   BestOfN({ candidates: [{hypothesis:"...",complexity:"medium"}, ...], metric_name:"...", direction:"..." })
   Workers run in isolated worktrees (cheap flash model), winner is re-measured in full."
 ;;
    2) escalation="

⚠️  SECOND STAGNATION CYCLE. Your first reflection didn't break through.

💡 PARALLEL HINT: The landscape may be multimodal — try SpaceSearch beam search:
   SpaceSearch({ action:"init", beam_width:3, candidates_per_state:3, diversity_hints:["approach1","approach2","approach3"] })
   Then step() to explore, finish() to re-measure the winner. Beam maintains K diverse states to avoid local optima.

Or if you need to get worse before better (refactor, algorithm swap), use phases:
   startPhase({ name:"refactor", max_steps:5, hard_floor_pct:40 })"
 ;;
    3) escalation="

🚨 THIRD STAGNATION CYCLE. Two reflections, zero progress.

💡 PARALLEL HINT: If you're in a phase and stuck at maxSteps, spawn diverse continuations:
   valleyProbe({ strategies:["strategy1","strategy2","strategy3"], baseline_metric:..., metric_name:"...", direction:"..." })
   Workers branch from the best checkpoint with different strategies.

Otherwise: ABANDON the current direction entirely. Try a radically different approach." ;;
    *) escalation="

💀 CRITICAL: ${streak} non-improving runs (${level} stagnation cycles). The session appears EXHAUSTED. Consider /autoresearch off and finalize, or call finalize_research() to signal completion." ;;
  esac

  # ── T2: Adapt REFLECT questions based on ASI context ─────────────────
  reflect_questions=""
  if [ "$asi_profiled" = "true" ]; then
    # Agent already profiled — skip the "profile the code" question
    reflect_questions="REFLECT:
1. Your profiling (per ASI) shows where time is spent. Is the bottleneck ADDRESSABLE from the code you're allowed to change?
2. Are there orthogonal dimensions you haven't explored (memory, I/O, caching, precomputation)?
3. Would a completely different algorithm or data structure help, even if more complex?
4. Consider calling finalize_research() if the limit is structural."
  else
    reflect_questions="REFLECT:
1. What PATTERN do these runs share? What common assumption are they all making?
2. Are you optimizing the right thing? Profile the code — where is time actually spent?
3. Is the current approach fundamentally limited? What structural change would unlock new gains?
4. What haven't you tried that is DIFFERENT (not a variation)?

Write your analysis to ${ideas_hint}, then try the most fundamentally different approach."
  fi

  # ── Output ───────────────────────────────────────────────────────────
  cat <<EOF
🔄 STAGNATION: No metric improvement in ${streak} runs.

${pattern_hint}

Recent runs (none beat best ${best_metric:-?}${metric_unit}):
${recent_formatted}
${escalation}
${reflect_questions}
EOF
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════════
# TRIGGER 4: PROGRESS  (streak==0, improvements multiple of MILESTONE)
# ══════════════════════════════════════════════════════════════════════════
if [ "$streak" -eq 0 ] && [ "$improvements" -gt 0 ] && [ $((improvements % PROGRESS_MILESTONE)) -eq 0 ]; then

  # ── Improvement progression ───────────────────────────────────────────
  progression="$(jq -r '.imp_history | join(" → ")' <<<"$state_json" 2>/dev/null)"

  # ── Compute deltas and trend ─────────────────────────────────────────
  trend_info="$(jq -r '[.imp_history[]] | @csv' <<<"$state_json" 2>/dev/null | awk -F',' '
    NF < 3 { print "INSUFFICIENT||"; exit }
    {
      n = NF
      for (i = 1; i < n; i++) {
        d[i] = $(i+1) - $i
        abd[i] = (d[i] < 0) ? -d[i] : d[i]
      }
      nd = n - 1
      printf "DELTAS:"
      for (i = 1; i <= nd; i++) {
        printf "%s%.1f", (i>1 ? "," : ""), d[i]
      }
      printf "||"
      if (abd[1] == 0) { print "INSUFFICIENT"; exit }
      ratio = abd[nd] / abd[1]
      mean = 0; for (i=1;i<=nd;i++) mean += abd[i]; mean /= nd
      var = 0; for (i=1;i<=nd;i++) var += (abd[i]-mean)^2; var /= nd
      cv = (mean > 0) ? sqrt(var)/mean : 0
      if (cv > 0.8)      print "ERRATIC"
      else if (ratio < 0.3)  print "DIMINISHING"
      else if (ratio < 0.7)  print "MODERATELY_DIMINISHING"
      else                    print "LINEAR"
    }
  ')"

  trend="${trend_info#*||}"
  deltas_str="${trend_info%%||*}"
  deltas_str="${deltas_str#DELTAS:}"

  case "$trend" in
    DIMINISHING)              trend_msg="📉 DIMINISHING RETURNS — gains are shrinking rapidly. You're near the performance floor." ;;
    MODERATELY_DIMINISHING)   trend_msg="📉 Moderately diminishing — gains getting smaller. Consider whether further effort is worth it." ;;
    LINEAR)                   trend_msg="📊 Linear progress — consistent gains. Keep going if unexplored directions remain." ;;
    ERRATIC)                  trend_msg="⚡ ERRATIC — high variance in gains. Results may be noise-dominated; verify with multiple runs." ;;
    *)                        trend_msg="" ;;
  esac

  # ── Output ───────────────────────────────────────────────────────────
  cat <<EOF
🎯 MILESTONE: ${improvements} improvements made.
   Progression: ${progression}${metric_unit}
   Deltas: ${deltas_str}${metric_unit}
   ${trend_msg}

STEP BACK and think strategically:
1. OVERFITTING CHECK: Are these gains real or specific to this benchmark? Would they generalize?
2. ORTHOGONAL DIRECTIONS: Is there a completely different optimization axis unexplored?
3. TRADE-OFFS: What are you sacrificing (memory, complexity, readability) for performance?
4. THE BIG PICTURE: If you started over knowing what you know now, what would you do differently?

Write your strategic assessment to ${ideas_hint}.
EOF
  exit 0
fi

# Between triggers: silent
exit 0
