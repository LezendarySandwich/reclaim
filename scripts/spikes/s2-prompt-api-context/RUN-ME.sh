#!/bin/zsh
# S2 — Where can the Prompt API and WebGPU actually run?
#
# Settles empirically, in YOUR Chrome, whether `LanguageModel` and `navigator.gpu` work inside an
# offscreen document, and whether a host page's Permissions-Policy reaches a content script's
# isolated world. See ../README.md for what the output means.
#
# Run from a normal Terminal. NOT from an agent session — Chrome cannot register Mach ports
# inside the agent sandbox and dies with `bootstrap_check_in ... Permission denied (1100)`.
#
# Chrome will NOT auto-load the probe extension: --load-extension was restricted as an
# anti-malware measure and is now silently ignored (verified on 153.0.8010.53 — the profile's
# Preferences showed zero registered extensions). The script tries the debugging flag that
# sometimes re-enables it, then falls back to asking you to click three things.

set -euo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"
ROOT="$PWD"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HOST="www.linkedin.localtest.me"
PORT=8443

fail() { print -u2 "\n✗ $1\n"; exit 1; }

# grep -c prints "0" AND exits 1 on an empty file, so `|| print 0` would append a SECOND zero and
# produce "0 0" — which is what crashed the previous version with "bad math expression".
count() { grep -c . results.jsonl 2>/dev/null || true; }

ext_contexts() {
  python3 - "$ROOT/results.jsonl" <<'PY' 2>/dev/null || print 0
import json, sys
ctx = set()
try:
    for line in open(sys.argv[1]):
        line = line.strip()
        if line:
            try: ctx.add(json.loads(line).get('ctx'))
            except Exception: pass
except Exception: pass
print(len(ctx & {'SERVICE_WORKER', 'OFFSCREEN', 'EXTENSION_PAGE', 'CONTENT_ISOLATED', 'WORKER'}))
PY
}

# ─────────────────────────── preflight ───────────────────────────
[[ -x "$CHROME" ]] || fail "Chrome not found at:\n    $CHROME\nEdit CHROME= at the top of this script."

# *.localtest.me is public DNS pointing at 127.0.0.1 — no /etc/hosts edit needed.
#
# The first version used *.test with --host-resolver-rules and failed with DNS_PROBE_STARTED,
# because this machine proxies through localhost:10054 and NO_PROXY covers only
# 127.0.0.1/localhost/::1. --host-resolver-rules is a no-op whenever a proxy is in play, since the
# proxy resolves names itself. Hence both a publicly-resolvable host AND --no-proxy-server below.
resolved=$(python3 -c "import socket
try: print(socket.gethostbyname('$HOST'))
except Exception as e: print('FAIL: '+str(e))")
[[ "$resolved" == "127.0.0.1" ]] || fail "$HOST resolved to '$resolved', expected 127.0.0.1.\nIf offline, add to /etc/hosts:\n    127.0.0.1 $HOST cdn.other.localtest.me"

# HARD STOP, not a warning. If Chrome is already running, the URLs below can be handed to your
# EXISTING window instead of the throwaway profile — and then the manual "Load unpacked" step
# installs the probe into your REAL browser profile, where its service worker will keep retrying
# POSTs to a report server that stops existing when this script ends.
if pgrep -x "Google Chrome" >/dev/null 2>&1 && [[ "${1:-}" != "--i-know-chrome-is-running" ]]; then
  fail "Chrome is already running — quit it completely (Cmd-Q) and rerun.

  Why this is a hard stop and not a warning: a running Chrome can swallow these URLs into your
  existing window and drop every command-line flag. You would then load the probe extension into
  your REAL profile rather than the throwaway one. Its service worker keeps probing, and its
  reports go to a server that only exists while this script runs — so you get repeated failing
  requests, and chrome-extension://invalid/ once the extension is removed.

  If you have already done that: open chrome://extensions in your normal Chrome and remove
  \"PromptAPI Context Probe\".

  To override anyway:  $0 --i-know-chrome-is-running"
fi

lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && \
  fail "Port $PORT is in use:\n$(lsof -nP -iTCP:$PORT -sTCP:LISTEN | tail -n +2)"

# ─────────────────────────── server ───────────────────────────
: > results.jsonl
python3 srv/server.py >srv.log 2>&1 & SRV=$!
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
# Symlink the real on-device model directory into the throwaway profile so it can see an
# already-downloaded Gemini Nano instead of pulling 4.27 GB.
ln -s "$HOME/Library/Application Support/Google/Chrome/OptGuideOnDeviceModel" \
      profile/OptGuideOnDeviceModel 2>/dev/null || true

"$CHROME" \
  --user-data-dir="$ROOT/profile" \
  --no-first-run --no-default-browser-check --disable-search-engine-choice-screen \
  --disable-extensions-except="$ROOT/ext" --load-extension="$ROOT/ext" \
  --enable-unsafe-extension-debugging \
  --ignore-certificate-errors --no-proxy-server \
  --host-resolver-rules="MAP *.localtest.me 127.0.0.1" \
  "https://$HOST:$PORT/feed" "https://$HOST:$PORT/feed-blocked" \
  >chrome.log 2>&1 &
CHR=$!
print "✓ chrome launched (pid $CHR)"

print -n "waiting for page probes"
for i in {1..20}; do sleep 0.5; print -n "."; [[ $(count) -ge 4 ]] && break; done
print ""

# Did the extension actually load? Read it out of the profile rather than assuming.
ext_loaded=$(python3 - "$ROOT/profile/Default/Preferences" <<'PY' 2>/dev/null || print 0
import json, sys
try: print(len(json.load(open(sys.argv[1])).get('extensions', {}).get('settings', {})))
except Exception: print(0)
PY
)

if [[ "$ext_loaded" == "0" ]]; then
  print ""
  print "──────────────────────────────────────────────────────────────────────"
  print " Chrome ignored --load-extension (registered extensions: 0)."
  print " Expected on current Chrome. Load it by hand — about 20 seconds:"
  print ""
  print "   1. In the Chrome window that just opened, visit:  chrome://extensions"
  print "   2. Toggle ON \"Developer mode\" (top right)"
  print "   3. Click \"Load unpacked\" and select this folder:"
  print ""
  print "        $ROOT/ext"
  print ""
  print "   4. Then open these two tabs:"
  print "        https://$HOST:$PORT/feed"
  print "        https://$HOST:$PORT/feed-blocked"
  print ""
  print " Leave them for a few seconds. This script is watching results.jsonl."
  print "──────────────────────────────────────────────────────────────────────"
  print ""
fi

print -n "waiting for extension probes (up to 4 min; Ctrl-C to stop and report anyway)"
for i in {1..240}; do
  sleep 1
  (( i % 5 == 0 )) && print -n "."
  [[ "$(ext_contexts)" -ge 4 ]] && { print "\n✓ extension contexts reported"; break; }
done
print ""

# ─────────────────────────── results ───────────────────────────
kill $CHR 2>/dev/null || true
sleep 0.5
python3 report.py || true

print "Raw:    $ROOT/results.jsonl"
print "Chrome: $ROOT/chrome.log"
print "Re-print this report any time:  python3 $ROOT/report.py"
