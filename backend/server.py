#!/usr/bin/env python3
"""Small Flickr proxy and static-file server for the copilot1 Street View UI.

Set up secrets/config.js from secrets/config.example.js before starting:
    python3 backend/server.py

The key stays on the server; the browser only receives normalized photo data.
"""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from html.parser import HTMLParser
from pathlib import Path
from http.cookies import CookieError, SimpleCookie
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen
import hmac
import json
import os
import re
import secrets
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent
FLICKR_ENDPOINT = "https://www.flickr.com/services/rest/"
FLICKR_CONFIG = ROOT / "secrets" / "config.js"
MAP_FILE = ROOT / "copilot1" / "map.json"
PANORAMA_ASPECT_RATIO = 2
PANORAMA_ASPECT_TOLERANCE = 0.01
ADMIN_SESSION_SECONDS = 12 * 60 * 60
ADMIN_SESSIONS = {}
MAX_JSON_BODY = 1024 * 1024


class StreetViewHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "copilot1"), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/photos":
            self.send_photos(parse_qs(parsed.query))
            return
        if parsed.path == "/api/map":
            self.send_map()
            return
        if parsed.path == "/api/map-photo":
            if not self.has_admin_session():
                self.send_json(401, {"error": "Sign in as an administrator to select a map photo."})
                return
            self.send_map_photo(parse_qs(parsed.query))
            return
        if parsed.path == "/api/admin/status":
            self.send_json(200, {"authenticated": self.has_admin_session()})
            return
        if parsed.path == "/api/video-source":
            self.send_video_source(parse_qs(parsed.query))
            return
        if parsed.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/admin/login":
            self.admin_login()
            return
        if parsed.path == "/api/admin/logout":
            self.admin_logout()
            return
        self.send_json(404, {"error": "Not found."})

    def do_PUT(self):
        if urlparse(self.path).path != "/api/map":
            self.send_json(404, {"error": "Not found."})
            return
        if not self.has_admin_session():
            self.send_json(401, {"error": "Sign in as an administrator to save the map."})
            return
        if not self.request_origin_is_same_site():
            self.send_json(403, {"error": "Cross-site map updates are not allowed."})
            return
        try:
            data = self.read_json_body()
            validated = validate_map_manifest(data)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})
            return
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=MAP_FILE.parent,
                prefix="map-",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary.write(json.dumps(validated, indent=2) + "\n")
                temporary_path = Path(temporary.name)
            os.replace(temporary_path, MAP_FILE)
        except OSError as error:
            self.send_json(500, {"error": f"Could not save the map: {error}"})
            return
        self.send_json(200, validated)

    def admin_login(self):
        if not self.request_origin_is_same_site():
            self.send_json(403, {"error": "Cross-site sign-in is not allowed."})
            return
        try:
            configured_password = load_admin_password()
        except (OSError, ValueError) as error:
            self.send_json(500, {"error": str(error)})
            return
        if not configured_password:
            self.send_json(503, {"error": "Set ADMIN_PASSWORD in secrets/config.js before using the admin tool."})
            return
        try:
            data = self.read_json_body()
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})
            return
        password = data.get("password")
        if not isinstance(password, str) or not hmac.compare_digest(
            password.encode("utf-8"), configured_password.encode("utf-8")
        ):
            self.send_json(401, {"error": "Incorrect admin password."})
            return

        self.clear_expired_admin_sessions()
        token = secrets.token_urlsafe(32)
        ADMIN_SESSIONS[token] = time.time() + ADMIN_SESSION_SECONDS
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto", "").lower() == "https" else ""
        self.send_header(
            "Set-Cookie",
            f"street_view_admin={token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age={ADMIN_SESSION_SECONDS}{secure}",
        )
        self.end_headers()
        self.wfile.write(b'{"authenticated":true}')

    def admin_logout(self):
        token = self.admin_session_token()
        if token:
            ADMIN_SESSIONS.pop(token, None)
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto", "").lower() == "https" else ""
        self.send_header("Set-Cookie", f"street_view_admin=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0{secure}")
        self.end_headers()
        self.wfile.write(b'{"authenticated":false}')

    def send_map(self):
        try:
            manifest = json.loads(MAP_FILE.read_text(encoding="utf-8"))
        except FileNotFoundError:
            manifest = {"version": 1, "map": None, "markers": []}
        except (OSError, json.JSONDecodeError) as error:
            self.send_json(500, {"error": f"Could not read the saved map: {error}"})
            return
        self.send_json(200, manifest)

    def send_map_photo(self, query):
        photo_id = parse_flickr_photo_id(query.get("id", [""])[0])
        if not photo_id:
            self.send_json(400, {"error": "Enter a valid Flickr photo URL or photo ID."})
            return
        try:
            api_key, _, _, _ = load_flickr_config()
            info = flickr_api_request({
                "method": "flickr.photos.getInfo",
                "api_key": api_key,
                "photo_id": photo_id,
            })
            sizes = flickr_api_request({
                "method": "flickr.photos.getSizes",
                "api_key": api_key,
                "photo_id": photo_id,
            })
            owner = info["photo"]["owner"]["nsid"]
            photo_url = f"https://www.flickr.com/photos/{owner}/{photo_id}"
            image_url = largest_flickr_image(sizes.get("sizes", {}).get("size", []))
            if not image_url:
                raise ValueError("Flickr did not provide a usable image for this photo.")
            payload = {
                "id": photo_id,
                "title": info["photo"].get("title", {}).get("_content") or "Flickr map photo",
                "ownerName": info["photo"].get("owner", {}).get("username") or owner,
                "photoUrl": photo_url,
                "imageUrl": image_url,
            }
        except (HTTPError, URLError, TimeoutError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            self.send_json(502, {"error": f"Could not load that Flickr photo: {error}"})
            return
        self.send_json(200, payload)

    def send_video_source(self, query):
        photo_id = query.get("id", [""])[0]
        if not re.fullmatch(r"\d{1,20}", photo_id):
            self.send_json(400, {"error": "A valid Flickr photo ID is required."})
            return

        try:
            video_url = resolve_flickr_video_url(photo_id)
        except (HTTPError, URLError, TimeoutError, ValueError) as error:
            self.send_json(502, {"error": f"Could not load the Flickr video: {error}"})
            return
        self.send_json(200, {"videoUrl": video_url})

    def send_photos(self, query):
        try:
            api_key, user_id, photoset_id, _ = load_flickr_config()
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
            "extras": "url_t,url_m,url_l,url_h,url_k,url_o,o_dims,original_format,owner_name,icon_server,date_upload,tags,media",
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
        profile = next(
            (photo for photo in result.get("photo", []) if photo.get("owner") == user_id),
            {},
        )
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
            "avatarUrl": flickr_avatar_url(profile),
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

    def read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid request body length.") from error
        if length < 1 or length > MAX_JSON_BODY:
            raise ValueError("Request body must be between 1 byte and 1 MB.")
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except UnicodeDecodeError as error:
            raise ValueError("Request body must be UTF-8 encoded JSON.") from error
        if not isinstance(data, dict):
            raise ValueError("The request body must be a JSON object.")
        return data

    def admin_session_token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except CookieError:
            return None
        morsel = cookie.get("street_view_admin")
        return morsel.value if morsel else None

    def has_admin_session(self):
        self.clear_expired_admin_sessions()
        token = self.admin_session_token()
        expires_at = ADMIN_SESSIONS.get(token)
        return expires_at is not None and expires_at > time.time()

    def clear_expired_admin_sessions(self):
        now = time.time()
        for token, expires_at in list(ADMIN_SESSIONS.items()):
            if expires_at <= now:
                del ADMIN_SESSIONS[token]

    def request_origin_is_same_site(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        return urlparse(origin).netloc.lower() == self.headers.get("Host", "").lower()

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


def flickr_avatar_url(profile):
    icon_server = str(profile.get("iconserver", "0"))
    if icon_server == "0":
        return "https://www.flickr.com/images/buddyicon.gif"
    icon_farm = profile.get("iconfarm")
    if not icon_farm:
        return "https://www.flickr.com/images/buddyicon.gif"
    user_id = profile.get("owner")
    if not user_id:
        return "https://www.flickr.com/images/buddyicon.gif"
    return f"https://farm{icon_farm}.staticflickr.com/{icon_server}/buddyicons/{user_id}.jpg"


def parse_flickr_photo_id(value):
    value = value.strip()
    if re.fullmatch(r"\d{1,20}", value):
        return value
    parsed = urlparse(value)
    if parsed.scheme in {"http", "https"} and parsed.hostname == "flic.kr":
        short_link = re.fullmatch(r"/p/([1-9a-km-zA-HJ-NP-Z]{1,12})/?", parsed.path)
        if not short_link:
            return None
        alphabet = "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"
        photo_id = 0
        for character in short_link.group(1):
            photo_id = photo_id * len(alphabet) + alphabet.index(character)
        return str(photo_id)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {
        "flickr.com",
        "www.flickr.com",
    }:
        return None
    match = re.fullmatch(r"/photos/[^/]+/(\d+)/?", parsed.path)
    return match.group(1) if match else None


def flickr_api_request(params):
    with urlopen(f"{FLICKR_ENDPOINT}?{urlencode({**params, 'format': 'json', 'nojsoncallback': '1'})}", timeout=12) as response:
        payload = json.load(response)
    if payload.get("stat") != "ok":
        raise ValueError(payload.get("message", "Flickr rejected the request."))
    return payload


def largest_flickr_image(sizes):
    usable = []
    for size in sizes:
        source = size.get("source", "")
        parsed = urlparse(source)
        if (
            parsed.scheme == "https"
            and parsed.hostname
            and parsed.hostname.endswith(".staticflickr.com")
            and size.get("width", 0) > 0
        ):
            usable.append(size)
    if not usable:
        return None
    preferred = [size for size in usable if size.get("width", 0) <= 4096]
    return max(preferred or usable, key=lambda size: size.get("width", 0))["source"]


def validate_map_manifest(data):
    if data.get("version") != 1:
        raise ValueError("Map data version must be 1.")
    map_photo = data.get("map")
    if map_photo is not None:
        if not isinstance(map_photo, dict):
            raise ValueError("Map photo data must be an object.")
        photo_id = str(map_photo.get("id", ""))
        if not re.fullmatch(r"\d{1,20}", photo_id):
            raise ValueError("Map photo must have a valid Flickr photo ID.")
        for field in ("title", "ownerName"):
            if not isinstance(map_photo.get(field), str):
                raise ValueError(f"Map photo is missing {field}.")
        for field, hosts in (
            ("photoUrl", {"www.flickr.com"}),
            ("imageUrl", None),
        ):
            value = map_photo.get(field)
            parsed = urlparse(value) if isinstance(value, str) else None
            if (
                not parsed
                or parsed.scheme != "https"
                or not parsed.hostname
                or (
                    parsed.hostname not in hosts
                    if hosts
                    else not parsed.hostname.endswith(".staticflickr.com")
                )
            ):
                raise ValueError(f"Map photo has an invalid {field}.")
        map_photo = {
            "id": photo_id,
            "title": map_photo["title"][:300],
            "ownerName": map_photo["ownerName"][:200],
            "photoUrl": map_photo["photoUrl"],
            "imageUrl": map_photo["imageUrl"],
        }

    markers = data.get("markers")
    if not isinstance(markers, list) or len(markers) > 1000:
        raise ValueError("Map markers must be a list of at most 1000 items.")
    if markers and map_photo is None:
        raise ValueError("Choose a map photo before placing markers.")
    normalized_markers = []
    seen_ids = set()
    for marker in markers:
        if not isinstance(marker, dict):
            raise ValueError("Each map marker must be an object.")
        photo_id = str(marker.get("photoId", ""))
        x = marker.get("x")
        y = marker.get("y")
        if (
            not re.fullmatch(r"\d{1,20}", photo_id)
            or photo_id in seen_ids
            or isinstance(x, bool)
            or isinstance(y, bool)
            or not isinstance(x, (int, float))
            or not isinstance(y, (int, float))
            or not 0 <= x <= 1
            or not 0 <= y <= 1
        ):
            raise ValueError("Markers need unique Flickr photo IDs and X/Y positions from 0 to 1.")
        seen_ids.add(photo_id)
        marker_photo = marker.get("photo")
        if not isinstance(marker_photo, dict):
            raise ValueError("Each marker must include its Flickr photo details.")
        if not isinstance(marker_photo.get("title"), str) or not isinstance(
            marker_photo.get("ownerName"), str
        ):
            raise ValueError("Marker Flickr details need a title and owner name.")
        page_url = marker_photo.get("pageUrl")
        parsed_page = urlparse(page_url) if isinstance(page_url, str) else None
        if (
            not parsed_page
            or parsed_page.scheme != "https"
            or parsed_page.hostname != "www.flickr.com"
        ):
            raise ValueError("Marker Flickr details have an invalid photo page URL.")
        thumbnail_url = marker_photo.get("thumbnailUrl")
        if thumbnail_url:
            parsed_thumbnail = urlparse(thumbnail_url)
            if (
                parsed_thumbnail.scheme != "https"
                or not parsed_thumbnail.hostname
                or not parsed_thumbnail.hostname.endswith(".staticflickr.com")
            ):
                raise ValueError("Marker Flickr details have an invalid thumbnail URL.")
        media_type = marker_photo.get("mediaType")
        if media_type not in {"photo", "video"}:
            raise ValueError("Marker media type must be photo or video.")
        normalized_markers.append({
            "photoId": photo_id,
            "x": x,
            "y": y,
            "photo": {
                "title": marker_photo["title"][:300],
                "ownerName": marker_photo["ownerName"][:200],
                "pageUrl": page_url,
                "thumbnailUrl": thumbnail_url,
                "mediaType": media_type,
            },
        })
    return {"version": 1, "map": map_photo, "markers": normalized_markers}


class FlickrVideoSourceParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.video_url = None

    def handle_starttag(self, tag, attrs):
        if tag == "video" and self.video_url is None:
            self.video_url = dict(attrs).get("src")


def resolve_flickr_video_url(photo_id):
    embed_url = f"https://embedr.flickr.com/photos/{photo_id}"
    with urlopen(embed_url, timeout=12) as response:
        parser = FlickrVideoSourceParser()
        parser.feed(response.read().decode("utf-8"))

    if not parser.video_url:
        raise ValueError("Flickr did not provide a playable video source.")

    player_url = urljoin(embed_url, parser.video_url)
    parsed_player_url = urlparse(player_url)
    if (
        parsed_player_url.scheme != "https"
        or parsed_player_url.hostname != "www.flickr.com"
        or "/play/" not in parsed_player_url.path
    ):
        raise ValueError("Flickr returned an unsupported video source.")

    request = Request(player_url, method="HEAD")
    with urlopen(request, timeout=12) as response:
        stream_url = response.geturl()
    parsed_stream_url = urlparse(stream_url)
    if (
        parsed_stream_url.scheme != "https"
        or not parsed_stream_url.hostname
        or not parsed_stream_url.hostname.endswith(".staticflickr.com")
        or not parsed_stream_url.path.endswith(".mp4")
    ):
        raise ValueError("Flickr did not redirect to a supported MP4 stream.")
    return stream_url


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
    admin_password_match = re.search(r"""\bADMIN_PASSWORD\s*:\s*(["'])(.*?)\1""", config)
    admin_password = admin_password_match.group(2) if admin_password_match else ""
    return values["API_KEY"], values["USER_ID"], photoset_id, admin_password


def load_admin_password():
    password = load_flickr_config()[3]
    if password and (
        len(password) < 12 or password == "CHANGE_THIS_TO_A_STRONG_PASSWORD"
    ):
        raise ValueError("Set ADMIN_PASSWORD to a unique password with at least 12 characters.")
    return password


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"Street View UI: http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), StreetViewHandler).serve_forever()
