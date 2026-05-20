#!/usr/bin/env bash

DB_DIR="${DB_DIR:-db}"
GAPS_DIR="${GAPS_DIR:-gaps}"
GAPS_FILE="${GAPS_FILE:-${GAPS_DIR}/query-gaps.jsonl}"
SESSION_ID_FILE="${SESSION_ID_FILE:-.session_id}"
CMD="${1:-}"
shift || true

usage() {
  echo "Usage: query.sh <search|expand|siblings|parent> [args]" >&2
  exit 1
}

# JSON string escaping matching JSON.stringify for the realistic cases:
# backslash, quote, and the named control escapes (\b \f \n \r \t).
# UTF-8 (e.g. CJK) passes through unescaped, exactly as JSON.stringify does.
# Other raw control bytes (<0x20) are out of scope for a search keyword.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\b'/\\b}"
  s="${s//$'\f'/\\f}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

# Append a GapEvent line, schema-identical to the browser sink
# (src/gaps.ts BrowserGapSink). The script owns recording.
record_gap() {
  local kw="$1" scope_in="$2"
  mkdir -p "$GAPS_DIR"
  local ymd ts n seq scope_json
  ymd="$(date -u +%Y%m%d)"
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  n="$(grep -c "\"gap_id\":\"gap_${ymd}_" "$GAPS_FILE" 2>/dev/null || true)"
  n="${n//[^0-9]/}"; [[ -z "$n" ]] && n=0
  seq="$(printf '%03d' "$((n + 1))")"
  scope_json="null"
  [[ -n "$scope_in" ]] && scope_json="\"$(json_escape "$scope_in")\""
  # session_id: read the program-written .session_id (never user-supplied);
  # absent → omit the key.
  local sid=""
  if [[ -f "$SESSION_ID_FILE" ]]; then
    IFS= read -r sid < "$SESSION_ID_FILE" || true
  fi
  local sess_json=""
  [[ -n "$sid" ]] && sess_json=",\"session_id\":\"$(json_escape "$sid")\""
  printf '{"source":"local","gap_id":"gap_%s_%s","keyword":"%s","scope":%s,"timestamp":"%s"%s}\n' \
    "$ymd" "$seq" "$(json_escape "$kw")" "$scope_json" "$ts" "$sess_json" >> "$GAPS_FILE"
}

# Count dashes in a string
count_dashes() {
  local s="${1//-/}"
  echo $(( ${#1} - ${#s} ))
}

# ── search <keyword> [--scope <doc_id>] ──────────────────────────────────────
if [[ "$CMD" == "search" ]]; then
  KEYWORD="${1:-}"
  SCOPE=""
  shift || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --scope) SCOPE="${2:-}"; shift 2 ;;
      *) shift ;;
    esac
  done
  [[ -z "$KEYWORD" ]] && usage

  SEARCH_DIR="${DB_DIR}"
  [[ -n "$SCOPE" ]] && SEARCH_DIR="${DB_DIR}/${SCOPE}"

  # keyword is one regex: -E so `a|b` is alternation (OR), -i to match the
  # browser default (case-insensitive). Whitespace is literal (no multi-term).
  RESULTS="$(grep -rlEi --include="*.md" "$KEYWORD" "$SEARCH_DIR" 2>/dev/null \
    | grep -v "_index\.md" \
    | sort \
    || true)"

  if [[ -z "$RESULTS" ]]; then
    # Record-time fan-out: simple-OR keyword (contains `|` and no other
    # regex metachar) becomes one gap per alternative. Out-of-contract
    # regex stays as a single raw-keyword event.
    if [[ "$KEYWORD" == *"|"* ]] \
       && ! printf '%s' "$KEYWORD" | grep -qE '[].*+?^${}()[\]'; then
      IFS='|' read -ra ALTS <<< "$KEYWORD"
      for alt in "${ALTS[@]}"; do
        # trim leading/trailing whitespace; preserve case + internal spaces
        alt="${alt#"${alt%%[![:space:]]*}"}"
        alt="${alt%"${alt##*[![:space:]]}"}"
        [[ -z "$alt" ]] && continue
        record_gap "$alt" "$SCOPE"
      done
    else
      record_gap "$KEYWORD" "$SCOPE"
    fi
  else
    echo "$RESULTS"
  fi
  exit 0
fi

# ── Path helpers (used by parent/siblings/expand) ────────────────────────────
chunk_path="${1:-}"
[[ -z "$chunk_path" ]] && usage

chunk_path="${chunk_path%.md}"
chunk_id="$(basename "$chunk_path")"
doc_dir="$(dirname "$chunk_path")"
doc_id="$(basename "$doc_dir")"

# ── parent <path> ────────────────────────────────────────────────────────────
if [[ "$CMD" == "parent" ]]; then
  dashes=$(count_dashes "$chunk_id")
  if [[ $dashes -eq 0 ]]; then
    echo "null"
  else
    parent_id="${chunk_id%-*}"
    echo "${doc_dir}/${parent_id}.md"
  fi
  exit 0
fi

# ── siblings <path> ──────────────────────────────────────────────────────────
if [[ "$CMD" == "siblings" ]]; then
  depth=$(( $(count_dashes "$chunk_id") + 1 ))

  while IFS= read -r f; do
    n="$(basename "$f" .md)"
    [[ "$n" == "_index" ]] && continue
    [[ "$n" == "$chunk_id" ]] && continue
    n_depth=$(( $(count_dashes "$n") + 1 ))
    [[ $n_depth -ne $depth ]] && continue
    if [[ $depth -gt 1 ]]; then
      prefix="${chunk_id%-*}-"
      [[ "$n" != ${prefix}* ]] && continue
    fi
    echo "$f"
  done < <(find "$doc_dir" -maxdepth 1 -name "*.md" 2>/dev/null | sort)
  exit 0
fi

# ── expand <path> [--level N] ────────────────────────────────────────────────
if [[ "$CMD" == "expand" ]]; then
  shift || true  # chunk_path already consumed
  LEVEL=1
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --level) LEVEL="${2:-1}"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [[ $LEVEL -eq 0 ]]; then
    echo "${doc_dir}/${chunk_id}.md"
    exit 0
  fi

  if [[ $LEVEL -ge 3 ]]; then
    find "$doc_dir" -maxdepth 1 -name "*.md" ! -name "_index.md" 2>/dev/null | sort
    exit 0
  fi

  declare -A seen
  result=()

  add() { local p="$1"; [[ -z "${seen[$p]+x}" ]] && seen[$p]=1 && result+=("$p"); }

  add "${doc_dir}/${chunk_id}.md"

  # siblings
  while IFS= read -r sib; do
    [[ -n "$sib" ]] && add "$sib"
  done < <(bash "$0" siblings "${doc_dir}/${chunk_id}.md" 2>/dev/null || true)

  # parent (level 2+)
  if [[ $LEVEL -ge 2 ]]; then
    parent_out=$(bash "$0" parent "${doc_dir}/${chunk_id}.md")
    [[ "$parent_out" != "null" ]] && [[ -f "$parent_out" ]] && add "$parent_out"
  fi

  printf '%s\n' "${result[@]}" | sort -u
  exit 0
fi

usage
