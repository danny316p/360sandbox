# Flickr backend

The backend serves `copilot1` and loads public photos from the configured Flickr user without exposing account configuration to the browser. It reads `API_KEY` and `USER_ID` from `secrets/config.js`, using the same CommonJS config style as `publicFlickrLandingPages`.

1. Create a Flickr API key at <https://www.flickr.com/services/api/keys/>.
2. Copy `secrets/config.example.js` to `secrets/config.js` and set `API_KEY` to your Flickr API key and `USER_ID` to the Flickr user's NSID (for example, `12345678@N00`). Optionally set `PHOTOSET_ID` to the ID of the album containing your 360° photos. The real config file is ignored by Git.
3. Start the server with Python 3 from the repository root:

   **Windows PowerShell**
   ```powershell
   py -3 backend/server.py
   ```

   **macOS or Linux**
   ```sh
   python3 backend/server.py
   ```

4. Open <http://localhost:8000>.

When `PHOTOSET_ID` is set, the backend loads photos and videos from that album using Flickr's `flickr.photosets.getPhotos` endpoint. Otherwise it loads the configured user's media using Flickr's `flickr.people.getPhotos`. It requests up to Flickr's 500-item page limit and the interface follows every result page, so larger albums are fully loaded. Photos are included only when Flickr's original or derivative dimensions indicate a 2:1 equirectangular image. Photos use Flickr thumbnails in the strip and the largest available panorama derivative in Pannellum. Videos are resolved on demand through Flickr's official embed page, then played as dynamic equirectangular video scenes in Pannellum, with drag/touch pan, zoom, play/pause, and seeking controls. The MP4 streams directly from Flickr to the browser; Flickr's byte-range and cache headers let the browser handle progressive loading and its normal media cache, without storing a second copy on the app server. The search field filters loaded items locally, and each item links to its Flickr page for comments and favorites.
