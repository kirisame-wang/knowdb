#!/usr/bin/env bash

DB_DIR="${DB_DIR:-db}"
CMD="${1:-}"
shift || true

usage() {
  echo "Usage: query.sh <search|expand|siblings|parent> [args]" >&2
  exit 1
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

  grep -rl --include="*.md" "$KEYWORD" "$SEARCH_DIR" 2>/dev/null \
    | grep -v "_index\.md" \
    | sort \
    || true
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
