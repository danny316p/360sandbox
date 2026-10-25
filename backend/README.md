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

When `PHOTOSET_ID` is set, the backend loads photos from that album using Flickr's `flickr.photosets.getPhotos` endpoint. Otherwise it loads the configured user's photos using `flickr.people.getPhotos`. Before returning photos, it checks Flickr's original dimensions and only accepts images with a 2:1 aspect ratio (within 1%); photos without dimension metadata or with other aspect ratios are excluded. This is the equirectangular shape required for a full 360° panorama. Flickr thumbnails are used for the photo strip, and the largest available panorama derivative is used in the viewer. Pannellum supports mouse/touch drag, scroll-wheel zoom, and the on-screen zoom and reset controls. The search field filters suitable photos by title or photographer locally. Each result links to its Flickr page for comments and favorites.
