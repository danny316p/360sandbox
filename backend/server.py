#!/usr/bin/env python3
"""Small Flickr proxy and static-file server for the copilot1 Street View UI.

Set up secrets/config.js from secrets/config.example.js before starting:
    python3 backend/server.py

The key stays on the server; the browser only receives normalized photo data.
"""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import urlopen
import json
import os
import re


ROOT = Path(__file__).resolve().parent.parent
FLICKR_ENDPOINT = "https://www.flickr.com/services/rest/"
FLICKR_CONFIG = ROOT / "secrets" / "config.js"


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
        try:
            api_key, user_id = load_flickr_config()
        except (OSError, ValueError) as error:
            self.send_json(500, {"error": str(error)})
            return

        try:
            per_page = min(max(int(query.get("per_page", ["30"])[0]), 1), 500)
            page = max(int(query.get("page", ["1"])[0]), 1)
        except ValueError:
            self.send_json(400, {"error": "page and per_page must be positive numbers."})
            return

        params = {
            "method": "flickr.people.getPhotos",
            "api_key": api_key,
            "user_id": user_id,
            "safe_search": "1",
            "per_page": per_page,
            "page": page,
            "format": "json",
            "nojsoncallback": "1",
            "extras": "url_m,url_o,original_format,owner_name,date_upload,tags",
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
        result = payload.get("photos", {})
        self.send_json(200, {
            "userId": user_id,
            "page": result.get("page", page),
            "pages": result.get("pages", 1),
            "total": result.get("total", len(photos)),
            "count": len(photos),
            "photos": photos,
        })

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


def load_flickr_config():
    try:
        config = FLICKR_CONFIG.read_text(encoding="utf-8")
    except FileNotFoundError as error:
        raise ValueError(
            "Flickr config is missing. Copy secrets/config.example.js to secrets/config.js "
            "and set its API_KEY and USER_ID."
        ) from error

    values = {}
    for name in ("API_KEY", "USER_ID"):
        match = re.search(rf"""\b{name}\s*:\s*(["'])([^"']+)\1""", config)
        if not match:
            raise ValueError(f"Flickr {name} is missing from secrets/config.js.")
        values[name] = match.group(2).strip()
        if not values[name] or values[name] == f"YOUR_{name}":
            raise ValueError(f"Set a valid Flickr {name} in secrets/config.js.")
    return values["API_KEY"], values["USER_ID"]


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"Street View UI: http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), StreetViewHandler).serve_forever()
