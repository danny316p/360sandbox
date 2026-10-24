# Flickr backend

The backend serves `copilot1` and loads public photos from the configured Flickr user without exposing account configuration to the browser. It reads `API_KEY` and `USER_ID` from `secrets/config.js`, using the same CommonJS config style as `publicFlickrLandingPages`.

1. Create a Flickr API key at <https://www.flickr.com/services/api/keys/>.
2. Copy `secrets/config.example.js` to `secrets/config.js` and set `API_KEY` to your Flickr API key and `USER_ID` to the Flickr user's NSID (for example, `12345678@N00`). The real config file is ignored by Git.
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

The backend calls Flickr's `flickr.people.getPhotos` endpoint for the configured user. The search field filters the loaded photos by title or photographer locally. Each result includes `imageUrl`, `thumbnailUrl`, and `pageUrl`; `pageUrl` opens the Flickr page where visitors can comment or favorite the photo.
