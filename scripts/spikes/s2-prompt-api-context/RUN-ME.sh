#!/bin/zsh
# S2 — Where can the Prompt API and WebGPU actually run?
#
# Settles empirically, in YOUR Chrome, whether `LanguageModel` and `navigator.gpu` work inside an
# offscreen document, and whether a host page's Permissions-Policy reaches a content script's
# isolated world. See ../README.md for what to look for in the output.
#
# Run from a normal Terminal. NOT from an agent session — Chrome cannot register Mach ports
# inside the agent sandbox and dies with `bootstrap_check_in ... Permission denied (1100)`.

set -euo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"
ROOT="$PWD"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HOST="www.linkedin.localtest.me"
PORT=8443

fail() { print -u2 "\n✗ $1\n"; exit 1; }

# ─────────────────────────── preflight ───────────────────────────
# Each of these has silently produced a confusing browser error page at least once.

[[ -x "$CHROME" ]] || fail "Chrome not found at:\n    $CHROME\nEdit CHROME= at the top of this script."

# *.localtest.me is public DNS pointing at 127.0.0.1 — no /etc/hosts edit and no reliance on
# Chrome's --host-resolver-rules.
#
# The first version of this script used *.test with --host-resolver-rules and failed with
# DNS_PROBE_STARTED. Cause: this machine runs a proxy on localhost:10054, and NO_PROXY covers only
# 127.0.0.1/localhost/::1. --host-resolver-rules is ignored whenever a proxy is in play, because
# the proxy performs name resolution, and the proxy could not resolve a .test name. Hence both the
# publicly-resolvable hostname and --no-proxy-server below: either alone would fix it, together
# they are robust to whatever proxy config the next machine has.
resolved=$(python3 -c "import socket
try: print(socket.gethostbyname('$HOST'))
except Exception as e: print('FAIL: '+str(e))")
[[ "$resolved" == "127.0.0.1" ]] || fail "$HOST resolved to '$resolved', expected 127.0.0.1.\nIf you are offline, add to /etc/hosts:\n    127.0.0.1 $HOST cdn.other.localtest.me"

if pgrep -x "Google Chrome" >/dev/null 2>&1; then
  print -u2 "⚠ Chrome is already running. A running instance can swallow these URLs into itself,"
  print -u2 "  losing every command-line flag. If the probe reports nothing, quit Chrome and rerun."
  print -u2 ""
fi

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Port $PORT is already in use:\n$(lsof -nP -iTCP:$PORT -sTCP:LISTEN | tail -n +2)"
fi

# ─────────────────────────── server ───────────────────────────
: > results.jsonl
python3 srv/server.py & SRV=$!
cleanup() { kill $SRV 2>/dev/null || true; kill ${CHR:-0} 2>/dev/null || true; }
trap cleanup EXIT INT TERM

for i in {1..20}; do
  curl -sk --noproxy '*' --max-time 2 "https://$HOST:$PORT/feed" >/dev/null 2>&1 && break
  [[ $i == 20 ]] && fail "Server never came up on https://$HOST:$PORT"
  sleep 0.25
done
print "✓ server up on https://$HOST:$PORT"

# ─────────────────────────── chrome ───────────────────────────
rm -rf profile && mkdir -p profile
# Symlink the real on-device model directory into the throwaway profile, so it can see an
# already-downloaded Gemini Nano instead of pulling 4.27 GB.
ln -s "$HOME/Library/Application Support/Google/Chrome/OptGuideOnDeviceModel" \
      profile/OptGuideOnDeviceModel 2>/dev/null || true

"$CHROME" \
  --user-data-dir="$ROOT/profile" \
  --no-first-run --no-default-browser-check --disable-search-engine-choice-screen \
  --disable-extensions-except="$ROOT/ext" --load-extension="$ROOT/ext" \
  --ignore-certificate-errors \
  --no-proxy-server \
  --host-resolver-rules="MAP *.localtest.me 127.0.0.1" \
  "https://$HOST:$PORT/feed" "https://$HOST:$PORT/feed-blocked" \
  >chrome.log 2>&1 &
CHR=$!

# Poll rather than sleeping blind, so a fast machine is not made to wait and a slow one is not
# cut off early.
print -n "waiting for probes"
for i in {1..60}; do
  sleep 1
  print -n "."
  n=$(grep -c . results.jsonl 2>/dev/null || print 0)
  [[ $n -ge 8 ]] && break
done
print ""

kill $CHR 2>/dev/null || true
sleep 0.5

# ─────────────────────────── results ───────────────────────────
print "\n==================== RESULTS ====================\n"
ROOT="$ROOT" python3 - <<'PY'
import json, os

path = os.path.join(os.environ['ROOT'], 'results.jsonl')
rows = []
with open(path) as fh:
    for line in fh:
        line = line.strip()
        if line:
            try: rows.append(json.loads(line))
            except json.JSONDecodeError: pass

if not rows:
    print("NO RESULTS. Check chrome.log — Chrome may not have launched.")
    raise SystemExit(1)

seen = set()
for d in rows:
    key = (d.get('ctx'), d.get('label'), d.get('href'))
    if key in seen: continue
    seen.add(key)
    print(f"{str(d.get('ctx','?')):26} LM={str(d.get('typeofLanguageModel')):10} "
          f"avail={str(d.get('availability')):13} "
          f"pp={str(d.get('ppAllowsLanguageModel', d.get('ppAllows'))):6} "
          f"gpu={str(d.get('gpuAdapter', d.get('hasWebGPU'))):18} "
          f"secure={d.get('isSecureContext')}")
    if d.get('href'): print(f"      {str(d['href'])[:88]}")
    for k in ('adapterInfo','createError','availabilityError','gpuError','answer','createMs','promptMs'):
        if d.get(k) is not None: print(f"      {k}: {d[k]}")

print("\n---------------- WHAT THIS MEANS ----------------")
ctxs = {d.get('ctx'): d for d in rows}

off = ctxs.get('OFFSCREEN')
if off:
    lm_ok  = off.get('typeofLanguageModel') not in (None, 'undefined')
    gpu_ok = bool(off.get('gpuAdapter') or off.get('hasWebGPU'))
    print(f"OFFSCREEN   LanguageModel: {'YES' if lm_ok else 'NO'}    WebGPU: {'YES' if gpu_ok else 'NO'}")
    if lm_ok and gpu_ok:
        print("  -> ADR-009 confirmed. Build the model layer in the offscreen document.")
    else:
        print("  -> ADR-009 FAILS. The model host must move to an extension page or side panel.")
        print("     Update docs/product/decisions.md before writing any engine code.")
    info = str(off.get('adapterInfo', ''))
    if 'swiftshader' in info.lower() or 'llvmpipe' in info.lower():
        print("  -> WARNING: software renderer, not a real GPU. Not viable for WebLLM.")
else:
    print("OFFSCREEN   no result — the offscreen document did not report. Check chrome.log.")

sw = ctxs.get('SERVICE_WORKER')
if sw:
    print(f"SW          LanguageModel: {sw.get('typeofLanguageModel')}  "
          f"(expected 'undefined' — AIPromptAPIForWorkers is off with no flag)")

cs = [d for d in rows if d.get('ctx') == 'CONTENT_ISOLATED']
if len(cs) >= 2:
    vals = {str(d.get('href','')).rstrip('/').split('/')[-1]:
            d.get('ppAllowsLanguageModel', d.get('ppAllows')) for d in cs}
    print(f"CONTENT     Permissions-Policy by page: {vals}")
    if len(set(vals.values())) > 1:
        print("  -> An isolated world DOES inherit the host page's Permissions-Policy.")
        print("     LinkedIn holds a one-header kill switch over content-script inference.")
    else:
        print("  -> Isolated world appears immune to the host page's Permissions-Policy.")
print()
PY

print "Full raw output: $ROOT/results.jsonl"
print "Chrome stderr:   $ROOT/chrome.log"
