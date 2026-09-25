#!/bin/zsh
exec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=/tmp/pmprobe/profile \
  --no-first-run --no-default-browser-check --disable-search-engine-choice-screen \
  --disable-extensions-except=/tmp/pmprobe/ext --load-extension=/tmp/pmprobe/ext \
  --host-resolver-rules="MAP *.test 127.0.0.1" \
  --ignore-certificate-errors \
  --window-size=1000,760 \
  "https://www.linkedin.test:8443/feed" \
  "https://www.linkedin.test:8443/feed-blocked" \
  > /tmp/pmprobe/chrome.log 2>&1
