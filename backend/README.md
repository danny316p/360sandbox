# Flickr backend

The backend serves `copilot1` and proxies Flickr photo search without exposing the Flickr API key to the browser.

1. Create a Flickr API key at <https://www.flickr.com/services/api/keys/>.
2. Set `FLICKR_API_KEY` in the server environment.
3. Run `python backend/server.py` from the repository root.
4. Open <http://localhost:8000>.

The UI calls `/api/photos?text=golden%20gate%20bridge&tags=360,equirectangular`. Change the search field and press Enter to query a different location. Each result includes `imageUrl`, `thumbnailUrl`, and `pageUrl`; `pageUrl` opens the Flickr page where visitors can comment or favorite the photo.
