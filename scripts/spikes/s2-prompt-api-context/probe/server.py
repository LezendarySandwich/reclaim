import http.server, urllib.parse, json, sys, threading, time
RESULT = []
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.urlparse(self.path)
        p = urllib.parse.parse_qs(q.query)
        if 'd' in p:
            RESULT.append(p['d'][0])
            print("REPORT:", p['d'][0], flush=True)
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin','*')
        self.end_headers(); self.wfile.write(b'ok')
        if RESULT:
            threading.Thread(target=lambda:(time.sleep(0.4), s.shutdown())).start()
    def log_message(self,*a): pass
s = http.server.HTTPServer(('127.0.0.1',8731), H)
t = threading.Thread(target=s.serve_forever); t.start()
for _ in range(400):
    if RESULT: break
    time.sleep(0.1)
if not RESULT: print("NO_REPORT", flush=True); s.shutdown()
t.join()
