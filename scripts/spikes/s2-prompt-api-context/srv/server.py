import http.server, ssl, json, sys, threading, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'results.jsonl')

PAGE = """<!doctype html><meta charset=utf-8><title>%(title)s</title>
<h1>%(title)s</h1>
<p>PP header sent: <code>%(pp)s</code></p>
<iframe src="/frame?label=same-origin-iframe" style="width:300px;height:80px"></iframe>
<iframe src="https://cdn.other.localtest.me:8443/frame?label=cross-origin-iframe" style="width:300px;height:80px"></iframe>
<script>
(async () => {
  const r = {ctx:'PAGE_INLINE', href:location.href, origin:location.origin,
    isSecureContext:window.isSecureContext,
    typeofLanguageModel: typeof window.LanguageModel};
  try {
    const fp = document.featurePolicy || document.permissionsPolicy;
    if (fp) { r.ppAllows = fp.allowsFeature('language-model');
      r.ppHasToken = fp.features().includes('language-model');
      r.ppAllFeatures = fp.features().sort(); }
  } catch(e){ r.ppErr=String(e); }
  fetch('https://www.linkedin.localtest.me:8443/report',{method:'POST',body:JSON.stringify(r)}).catch(()=>{});
})();
</script>
"""

FRAME = """<!doctype html><meta charset=utf-8><html data-frame-label="%(label)s"><body>
<script>
(async () => {
  const r = {ctx:'IFRAME_MAIN_WORLD', label:'%(label)s', href:location.href, origin:location.origin,
    isTop: window.top===window, isSecureContext:window.isSecureContext,
    typeofLanguageModel: typeof window.LanguageModel};
  try { const fp=document.featurePolicy||document.permissionsPolicy;
    if(fp){ r.ppAllows=fp.allowsFeature('language-model'); } } catch(e){ r.ppErr=String(e); }
  if (r.typeofLanguageModel!=='undefined'){
    try { r.availability = await window.LanguageModel.availability(); }
    catch(e){ r.availabilityError = e.name+': '+e.message; }
  }
  fetch('https://www.linkedin.localtest.me:8443/report',{method:'POST',body:JSON.stringify(r),mode:'cors'}).catch(()=>{});
})();
</script></body></html>
"""

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass

    def _send(self, body, ctype='text/html; charset=utf-8', extra=None, code=200):
        b = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(b)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def do_OPTIONS(self): self._send('', 'text/plain')

    def do_GET(self):
        p = self.path.split('?')[0]
        q = self.path.split('?')[1] if '?' in self.path else ''
        if p == '/feed':
            self._send(PAGE % {'title': 'feed (no Permissions-Policy header)', 'pp': '(none)'})
        elif p == '/feed-blocked':
            hdr = 'language-model=(), summarizer=()'
            self._send(PAGE % {'title': 'feed-blocked', 'pp': hdr}, extra={'Permissions-Policy': hdr})
        elif p == '/feed-self':
            hdr = 'language-model=(self)'
            self._send(PAGE % {'title': 'feed-self', 'pp': hdr}, extra={'Permissions-Policy': hdr})
        elif p == '/frame':
            label = q.replace('label=', '') or 'frame'
            self._send(FRAME % {'label': label})
        elif p == '/results':
            self._send(open(OUT).read() if os.path.exists(OUT) else '', 'text/plain')
        else:
            self._send('ok', 'text/plain')

    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        data = self.rfile.read(n)
        with open(OUT, 'ab') as f:
            f.write(data + b'\n')
        self._send('ok', 'text/plain')


if __name__ == '__main__':
    open(OUT, 'w').close()
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(os.path.join(HERE, 'cert.pem'), os.path.join(HERE, 'key.pem'))
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8443), H)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    print('serving https on 127.0.0.1:8443', flush=True)
    srv.serve_forever()
