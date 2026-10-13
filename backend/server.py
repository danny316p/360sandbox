"""Small Flickr proxy and static-file server for the copilot1 Street View UI.

Set FLICKR_API_KEY before starting:
    FLICKR_API_KEY=... python backend/server.py

The key stays on the server; the browser only receives normalized photo data.
"""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import urlopen
import json
import os


ROOT = Path(__file__).resolve().parent.parent
FLICKR_ENDPOINT = "https://www.flickr.com/services/rest/"
DEFAULT_QUERY = "golden gate bridge"


class StreetViewHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "copilot1"), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/photos":
            self.send_photos(parse_qs(parsed.query))
            return
        if parsed.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def send_photos(self, query):
        api_key = os.environ.get("FLICKR_API_KEY")
        if not api_key:
            self.send_json(500, {"error": "FLICKR_API_KEY is not configured on the server."})
            return

        text = query.get("text", [DEFAULT_QUERY])[0].strip() or DEFAULT_QUERY
        tags = query.get("tags", ["360,equirectangular"])[0]
        try:
            per_page = min(max(int(query.get("per_page", ["12"])[0]), 1), 30)
        except ValueError:
            self.send_json(400, {"error": "per_page must be a number between 1 and 30."})
            return

        params = {
            "method": "flickr.photos.search",
            "api_key": api_key,
            "text": text,
            "tags": tags,
            "tagmode": "all",
            "content_type": "1",
            "media": "photos",
            "safe_search": "1",
            "sort": "relevance",
            "per_page": per_page,
            "format": "json",
            "nojsoncallback": "1",
            "extras": "url_m,url_o,original_format,owner_name,date_upload",
        }
        try:
            with urlopen(f"{FLICKR_ENDPOINT}?{urlencode(params)}", timeout=12) as response:
                payload = json.load(response)
        except (HTTPError, URLError, TimeoutError) as error:
            self.send_json(502, {"error": f"Flickr request failed: {error.reason if hasattr(error, 'reason') else error}"})
            return
        except json.JSONDecodeError:
            self.send_json(502, {"error": "Flickr returned an invalid response."})
            return

        if payload.get("stat") != "ok":
            self.send_json(502, {"error": payload.get("message", "Flickr rejected the request.")})
            return

        photos = []
        for photo in payload.get("photos", {}).get("photo", []):
            image_url = photo.get("url_o") or photo.get("url_m")
            if not image_url:
                continue
            photo_id = photo["id"]
            owner = photo["owner"]
            photos.append({
                "id": photo_id,
                "title": photo.get("title") or "Untitled panorama",
                "ownerName": photo.get("ownername") or owner,
                "imageUrl": image_url,
                "thumbnailUrl": photo.get("url_m") or image_url,
                "pageUrl": f"https://www.flickr.com/photos/{owner}/{photo_id}",
                "dateUpload": photo.get("dateupload"),
            })
        self.send_json(200, {"query": text, "count": len(photos), "photos": photos})

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        print(f"[street-view] {format % args}")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"Street View UI: http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), StreetViewHandler).serve_forever()
