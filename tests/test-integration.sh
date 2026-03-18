#!/usr/bin/env bash
# Integration test: validates web frontend API calls against the running backend.
# Requires: backend running on :3100 (mastersof-ai --serve)
#
# Usage: bash web/test-integration.sh

set -uo pipefail

BACKEND="http://localhost:3100"
VALID_TOKEN="b3f88d0b-e226-486e-b0f6-80a5b98535cc"
INVALID_TOKEN="bad-token-12345"
PASS=0
FAIL=0

check() {
  local desc="$1" expected_code="$2" actual_code="$3" body="$4"
  if [[ "$actual_code" == "$expected_code" ]]; then
    echo "  PASS: $desc (HTTP $actual_code)"
    ((PASS++))
  else
    echo "  FAIL: $desc — expected HTTP $expected_code, got $actual_code"
    echo "        body: $body"
    ((FAIL++))
  fi
}

check_body() {
  local desc="$1" pattern="$2" body="$3"
  if echo "$body" | grep -q "$pattern"; then
    echo "  PASS: $desc (contains '$pattern')"
    ((PASS++))
  else
    echo "  FAIL: $desc — expected body to contain '$pattern'"
    echo "        body: $body"
    ((FAIL++))
  fi
}

echo "=== Health ==="
RESP=$(curl -s -w "\n%{http_code}" "$BACKEND/health")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /health" 200 "$CODE" "$BODY"
check_body "health response has status:ok" '"status":"ok"' "$BODY"

echo ""
echo "=== Auth: invalid token ==="
RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $INVALID_TOKEN" "$BACKEND/api/agents")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/agents (invalid token)" 401 "$CODE" "$BODY"

echo ""
echo "=== Auth: no token ==="
RESP=$(curl -s -w "\n%{http_code}" "$BACKEND/api/agents")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/agents (no token)" 401 "$CODE" "$BODY"

echo ""
echo "=== Agent roster ==="
RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $VALID_TOKEN" "$BACKEND/api/agents")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/agents (valid token)" 200 "$CODE" "$BODY"
check_body "roster is an array" '^\[' "$BODY"
# Count agents
AGENT_COUNT=$(echo "$BODY" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
if [[ "$AGENT_COUNT" -gt 0 ]]; then
  echo "  PASS: roster has $AGENT_COUNT agents"
  ((PASS++))
else
  echo "  FAIL: roster is empty (expected at least 1 agent)"
  ((FAIL++))
fi

# Get first agent ID
FIRST_AGENT=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])" 2>/dev/null || echo "")
echo "  INFO: first agent is '$FIRST_AGENT'"

echo ""
echo "=== Single agent ==="
RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $VALID_TOKEN" "$BACKEND/api/agents/$FIRST_AGENT")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/agents/$FIRST_AGENT" 200 "$CODE" "$BODY"
check_body "agent has id field" '"id"' "$BODY"
check_body "agent has name field" '"name"' "$BODY"
check_body "agent has description field" '"description"' "$BODY"

echo ""
echo "=== Agent not found ==="
RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $VALID_TOKEN" "$BACKEND/api/agents/nonexistent-agent-xyz")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/agents/nonexistent (404)" 404 "$CODE" "$BODY"

echo ""
echo "=== Sessions: list ==="
RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $VALID_TOKEN" "$BACKEND/api/sessions?agent=$FIRST_AGENT")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/sessions?agent=$FIRST_AGENT" 200 "$CODE" "$BODY"
check_body "sessions is an array" '^\[' "$BODY"

echo ""
echo "=== Sessions: create ==="
RESP=$(curl -s -w "\n%{http_code}" -X POST -H "Authorization: Bearer $VALID_TOKEN" -H "Content-Type: application/json" \
  -d "{\"agent\":\"$FIRST_AGENT\"}" "$BACKEND/api/sessions")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "POST /api/sessions (create)" 201 "$CODE" "$BODY"
check_body "session has id" '"id"' "$BODY"
NEW_SESSION=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
echo "  INFO: created session '$NEW_SESSION'"

echo ""
echo "=== Sessions: delete ==="
if [[ -n "$NEW_SESSION" ]]; then
  RESP=$(curl -s -w "\n%{http_code}" -X DELETE -H "Authorization: Bearer $VALID_TOKEN" \
    "$BACKEND/api/sessions/$NEW_SESSION?agent=$FIRST_AGENT")
  CODE=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')
  check "DELETE /api/sessions/$NEW_SESSION" 200 "$CODE" "$BODY"
  check_body "delete response has deleted:true" '"deleted":true' "$BODY"
else
  echo "  SKIP: no session ID to delete"
fi

echo ""
echo "=== Sessions: missing agent param ==="
RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $VALID_TOKEN" "$BACKEND/api/sessions")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/sessions (no agent param)" 400 "$CODE" "$BODY"

echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
