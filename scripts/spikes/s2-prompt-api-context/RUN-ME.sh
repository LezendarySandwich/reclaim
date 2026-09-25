#!/bin/zsh
# Settles the LanguageModel-context question empirically in YOUR Chrome.
# Run from a normal Terminal (NOT from an agent session - Chrome cannot
# register Mach ports inside the agent sandbox).
set -e
cd "$(cd "$(dirname "$0")" && pwd)"
python3 srv/server.py & SRV=$!
sleep 1
rm -rf profile && mkdir -p profile
ln -s "$HOME/Library/Application Support/Google/Chrome/OptGuideOnDeviceModel" profile/OptGuideOnDeviceModel 2>/dev/null || true
: > results.jsonl
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$(cd "$(dirname "$0")" && pwd)"/profile \
  --no-first-run --no-default-browser-check --disable-search-engine-choice-screen \
  --disable-extensions-except="$(cd "$(dirname "$0")" && pwd)"/ext --load-extension="$(cd "$(dirname "$0")" && pwd)"/ext \
  --host-resolver-rules="MAP *.test 127.0.0.1" --ignore-certificate-errors \
  "https://www.linkedin.test:8443/feed" "https://www.linkedin.test:8443/feed-blocked" &
CHR=$!
echo "Waiting 60s for probes..."; sleep 60
kill $CHR 2>/dev/null || true; kill $SRV 2>/dev/null || true
echo "==================== RESULTS ===================="
python3 - <<'PY'
import json
for l in open('"$(cd "$(dirname "$0")" && pwd)"/results.jsonl'):
    l=l.strip()
    if not l: continue
    d=json.loads(l)
    print(f"{d.get('ctx','?'):26} LM={str(d.get('typeofLanguageModel')):10} "
          f"avail={str(d.get('availability')):12} ppAllows={d.get('ppAllowsLanguageModel', d.get('ppAllows'))} "
          f"secure={d.get('isSecureContext')} {str(d.get('href',''))[:52]}")
    for k in ('createError','availabilityError','answer','createMs','promptMs'):
        if d.get(k) is not None: print(f"      {k}: {d[k]}")
PY
