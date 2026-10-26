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
PANORAMA_ASPECT_RATIO = 2
PANORAMA_ASPECT_TOLERANCE = 0.01


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
            api_key, user_id, photoset_id = load_flickr_config()
        except (OSError, ValueError) as error:
            self.send_json(500, {"error": str(error)})
            return

        try:
            per_page = min(max(int(query.get("per_page", ["500"])[0]), 1), 500)
            page = max(int(query.get("page", ["1"])[0]), 1)
        except ValueError:
            self.send_json(400, {"error": "page and per_page must be positive numbers."})
            return

        params = {
            "method": "flickr.photosets.getPhotos" if photoset_id else "flickr.people.getPhotos",
            "api_key": api_key,
            "per_page": per_page,
            "page": page,
            "media": "all",
            "format": "json",
            "nojsoncallback": "1",
            "extras": "url_t,url_m,url_l,url_h,url_k,url_o,o_dims,original_format,owner_name,date_upload,tags,media",
        }
        if photoset_id:
            params["photoset_id"] = photoset_id
            params["user_id"] = user_id
        else:
            params["user_id"] = user_id
            params["safe_search"] = "1"
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

        result_key = "photoset" if photoset_id else "photos"
        result = payload.get(result_key, {})
        photos = []
        for photo in result.get("photo", []):
            photo_id = photo["id"]
            owner = photo.get("owner") or result.get("owner") or user_id
            media_type = photo.get("media", "photo")
            if media_type == "video":
                photos.append({
                    "id": photo_id,
                    "mediaType": "video",
                    "title": photo.get("title") or "Untitled 360° video",
                    "ownerName": photo.get("ownername") or owner,
                    "thumbnailUrl": photo.get("url_t") or photo.get("url_m"),
                    "pageUrl": f"https://www.flickr.com/photos/{owner}/{photo_id}",
                    "embedUrl": f"https://www.flickr.com/photos/{owner}/{photo_id}/player/",
                    "dateUpload": photo.get("dateupload"),
                })
                continue

            dimensions = photo_dimensions(photo)
            if not is_equirectangular(dimensions):
                continue
            panorama_url = (
                photo.get("url_k")
                or photo.get("url_h")
                or photo.get("url_l")
                or photo.get("url_o")
                or photo.get("url_m")
            )
            if not panorama_url:
                continue
            photos.append({
                "id": photo_id,
                "mediaType": "photo",
                "title": photo.get("title") or "Untitled panorama",
                "ownerName": photo.get("ownername") or owner,
                "panoramaUrl": panorama_url,
                "thumbnailUrl": photo.get("url_t") or photo.get("url_m") or panorama_url,
                "width": dimensions[0],
                "height": dimensions[1],
                "pageUrl": f"https://www.flickr.com/photos/{owner}/{photo_id}",
                "dateUpload": photo.get("dateupload"),
            })
        self.send_json(200, {
            "userId": user_id,
            "profileUrl": f"https://www.flickr.com/people/{user_id}/",
            "photosetId": photoset_id,
            "page": result.get("page", page),
            "pages": result.get("pages", 1),
            "total": len(photos),
            "sourceTotal": result.get("total", len(photos)),
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


def parse_original_dimensions(value):
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"\s*(\d+)\s*[x,]\s*(\d+)\s*", value)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def photo_dimensions(photo):
    dimensions = parse_original_dimensions(photo.get("o_dims"))
    if dimensions:
        return dimensions

    for width_key, height_key in (
        ("width_o", "height_o"),
        ("o_width", "o_height"),
        ("width_k", "height_k"),
        ("width_h", "height_h"),
        ("width_l", "height_l"),
        ("width_m", "height_m"),
    ):
        try:
            width = int(photo[width_key])
            height = int(photo[height_key])
        except (KeyError, TypeError, ValueError):
            continue
        if width > 0 and height > 0:
            return width, height
    return None


def is_equirectangular(dimensions):
    if not dimensions:
        return False
    width, height = dimensions
    if width <= 0 or height <= 0:
        return False
    aspect_ratio = width / height
    return abs(aspect_ratio - PANORAMA_ASPECT_RATIO) <= (
        PANORAMA_ASPECT_RATIO * PANORAMA_ASPECT_TOLERANCE
    )


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

    photoset_match = re.search(r"""\bPHOTOSET_ID\s*:\s*(["'])([^"']*)\1""", config)
    photoset_id = photoset_match.group(2).strip() if photoset_match else ""
    if photoset_id == "YOUR_PHOTOSET_ID":
        photoset_id = ""
    return values["API_KEY"], values["USER_ID"], photoset_id


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"Street View UI: http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), StreetViewHandler).serve_forever()
