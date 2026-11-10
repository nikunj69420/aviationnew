"""Dev server for the coaching-centre page: serves the whole repo (no caching) plus a
small live-traffic endpoint for the lobby screen.

Run from the repo root:   python dev_server.py        (then open http://localhost:5174/)

GET /api/traffic?airport=BOM|DEL|BLR returns aircraft within ~60 nm of that airport, from the
public ADS-B feed at adsb.lol (data licensed ODbL). Browsers can't call that feed directly (it sends
no CORS headers), so this server fetches it, trims it and caches each airport for 10 seconds.
Only the three airports below are allowed, so this is not an open proxy.
"""
import http.server
import json
import os
import sys
import threading
import time
import urllib.parse
import urllib.request

AIRPORTS = {
    "BOM": (19.0896, 72.8656),
    "DEL": (28.5562, 77.1000),
    "BLR": (13.1986, 77.7066),
}
RADIUS_NM = 60
CACHE_SECONDS = 10
_cache = {}
_lock = threading.Lock()


def fetch_traffic(code):
    lat, lon = AIRPORTS[code]
    with _lock:
        hit = _cache.get(code)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    url = f"https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{RADIUS_NM}"
    req = urllib.request.Request(url, headers={"User-Agent": "AviationSpot360-coaching-centre-dev/1.0"})
    with urllib.request.urlopen(req, timeout=8) as r:
        raw = json.load(r)
    ac = []
    for a in raw.get("ac", []):
        if a.get("lat") is None or a.get("lon") is None:
            continue
        alt = a.get("alt_baro")
        ac.append({
            "id": a.get("hex"),
            "cs": (a.get("flight") or a.get("r") or a.get("hex") or "").strip(),
            "type": a.get("t") or "",
            "lat": a["lat"],
            "lon": a["lon"],
            "alt": 0 if alt == "ground" else alt,
            "gs": a.get("gs"),
            "trk": a.get("track", a.get("true_heading")),
            "vr": a.get("baro_rate", a.get("geom_rate")),
            "sq": a.get("squawk"),
            "age": a.get("seen_pos", 0),
        })
    data = {"airport": code, "time": time.time(), "source": "adsb.lol", "ac": ac}
    with _lock:
        _cache[code] = (time.time(), data)
    return data


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/traffic":
            return super().do_GET()
        code = urllib.parse.parse_qs(parsed.query).get("airport", [""])[0].upper()
        if code not in AIRPORTS:
            return self._json(400, {"error": "airport must be one of " + ", ".join(AIRPORTS)})
        try:
            self._json(200, fetch_traffic(code))
        except Exception as e:  # upstream down or rate-limited: the page falls back to simulated traffic
            self._json(502, {"error": str(e)})

    def _json(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        if "/api/traffic" not in str(args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5174
    print(f"Serving the repo at http://localhost:{port}/")
    http.server.ThreadingHTTPServer(("", port), Handler).serve_forever()
