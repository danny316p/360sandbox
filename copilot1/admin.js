const loginPanel = document.querySelector("#loginPanel");
const editorPanel = document.querySelector("#editorPanel");
const loginMessage = document.querySelector("#loginMessage");
const mapMessage = document.querySelector("#mapMessage");
const saveMessage = document.querySelector("#saveMessage");
const mapStage = document.querySelector("#mapStage");
const mapImage = document.querySelector("#adminMapImage");
const mapPlaceholder = document.querySelector("#mapPlaceholder");
const markerLayer = document.querySelector("#adminMapMarkers");
const stopList = document.querySelector("#stopList");
const placedStopList = document.querySelector("#placedStopList");
const stopFilter = document.querySelector("#stopFilter");
const stopCount = document.querySelector("#stopCount");
let manifest = { version: 1, map: null, markers: [] };
let photos = [];
let selectedPhotoId = null;
let draggedPhotoId = null;

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function showMessage(element, message, isError = false) {
  element.textContent = message;
  element.hidden = !message;
  element.classList.toggle("is-error", isError);
}

async function checkSession() {
  try {
    const status = await requestJson("/api/admin/status");
    if (status.authenticated) await openEditor();
  } catch (error) {
    showMessage(loginMessage, error.message, true);
  }
}

document.querySelector("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage(loginMessage, "Signing in…");
  try {
    await requestJson("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: document.querySelector("#adminPassword").value })
    });
    document.querySelector("#adminPassword").value = "";
    await openEditor();
  } catch (error) {
    showMessage(loginMessage, error.message, true);
  }
});

async function openEditor() {
  loginPanel.hidden = true;
  editorPanel.hidden = false;
  await Promise.all([loadMapManifest(), loadPhotoLibrary()]);
}

document.querySelector("#logoutButton").addEventListener("click", async () => {
  try {
    await requestJson("/api/admin/logout", { method: "POST", body: "{}" });
    editorPanel.hidden = true;
    loginPanel.hidden = false;
  } catch (error) {
    showMessage(saveMessage, error.message, true);
  }
});

async function loadMapManifest() {
  try {
    manifest = await requestJson("/api/map");
    if (!Array.isArray(manifest.markers)) manifest.markers = [];
    renderMapEditor();
    renderPlacedStops();
  } catch (error) {
    showMessage(saveMessage, error.message, true);
  }
}

async function loadPhotoLibrary() {
  stopCount.textContent = "Loading…";
  try {
    const first = await fetchPhotoPage(1);
    photos = first.photos;
    for (let page = 2; page <= first.pages; page += 1) {
      stopCount.textContent = `Loading ${page} of ${first.pages}…`;
      const next = await fetchPhotoPage(page);
      photos.push(...next.photos);
    }
    stopCount.textContent = `${photos.length} items`;
    renderPhotoLibrary();
    renderPlacedStops();
  } catch (error) {
    stopCount.textContent = "Unavailable";
    showMessage(saveMessage, error.message, true);
  }
}

async function fetchPhotoPage(page) {
  return requestJson(`/api/photos?page=${page}&per_page=500`);
}

document.querySelector("#mapPhotoForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage(mapMessage, "Loading Flickr photo…");
  try {
    const value = document.querySelector("#mapPhotoUrl").value.trim();
    const data = await requestJson(`/api/map-photo?id=${encodeURIComponent(value)}`);
    if (manifest.markers.length > 0 && !window.confirm("Changing the map will remove all current stop placements. Continue?")) {
      showMessage(mapMessage, "Map photo was not changed.");
      return;
    }
    manifest.map = data;
    manifest.markers = [];
    renderMapEditor();
    renderPlacedStops();
    showMessage(mapMessage, `Using “${data.title}” by ${data.ownerName}. Save the map to publish it.`);
  } catch (error) {
    showMessage(mapMessage, error.message, true);
  }
});

function renderMapEditor() {
  markerLayer.replaceChildren();
  if (!manifest.map) {
    mapImage.hidden = true;
    mapPlaceholder.hidden = false;
    return;
  }
  if (mapImage.src !== manifest.map.imageUrl) mapImage.src = manifest.map.imageUrl;
  mapImage.alt = `${manifest.map.title} by ${manifest.map.ownerName}`;
  mapImage.hidden = false;
  mapPlaceholder.hidden = true;
  const attribution = document.querySelector("#mapAttribution");
  attribution.replaceChildren();
  attribution.append("Map image: ");
  const link = document.createElement("a");
  link.href = manifest.map.photoUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = `${manifest.map.title} · ${manifest.map.ownerName}`;
  attribution.append(link);
  attribution.hidden = false;

  manifest.markers.forEach((marker, index) => {
    const pin = document.createElement("button");
    pin.className = `admin-pin${marker.photoId === selectedPhotoId ? " selected" : ""}`;
    pin.type = "button";
    pin.style.left = `${marker.x * 100}%`;
    pin.style.top = `${marker.y * 100}%`;
    pin.setAttribute("aria-label", `Move stop ${index + 1}`);
    const number = document.createElement("span");
    number.textContent = String(index + 1);
    pin.append(number);
    pin.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectedPhotoId = marker.photoId;
      draggedPhotoId = marker.photoId;
      mapStage.setPointerCapture(event.pointerId);
      renderPhotoLibrary();
      renderPlacedStops();
      renderMapEditor();
    });
    markerLayer.append(pin);
  });
}

mapStage.addEventListener("click", (event) => {
  if (event.target.closest(".admin-pin")) return;
  if (!manifest.map) {
    showMessage(mapMessage, "Choose a Flickr photo to use as the map first.", true);
    return;
  }
  if (!selectedPhotoId) {
    showMessage(saveMessage, "Select a photo or video from the stops list first.", true);
    return;
  }
  const position = getMapPosition(event);
  const existing = manifest.markers.find((marker) => marker.photoId === selectedPhotoId);
  const photo = photos.find((item) => item.id === selectedPhotoId);
  if (!photo) return;
  const details = {
    title: photo.title,
    ownerName: photo.ownerName,
    pageUrl: photo.pageUrl,
    thumbnailUrl: photo.thumbnailUrl,
    mediaType: photo.mediaType
  };
  if (existing) Object.assign(existing, position, { photo: details });
  else manifest.markers.push({ photoId: selectedPhotoId, ...position, photo: details });
  renderMapEditor();
  renderPlacedStops();
  renderPhotoLibrary();
});

mapStage.addEventListener("pointermove", (event) => {
  if (!draggedPhotoId) return;
  const marker = manifest.markers.find((item) => item.photoId === draggedPhotoId);
  if (marker) Object.assign(marker, getMapPosition(event));
  renderMapEditor();
  renderPlacedStops();
});
mapStage.addEventListener("pointerup", () => { draggedPhotoId = null; });
mapStage.addEventListener("pointercancel", () => { draggedPhotoId = null; });

function getMapPosition(event) {
  const bounds = mapStage.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
  };
}

function renderPhotoLibrary() {
  const filter = stopFilter.value.trim().toLocaleLowerCase();
  stopList.replaceChildren();
  photos
    .filter((photo) => `${photo.title} ${photo.ownerName}`.toLocaleLowerCase().includes(filter))
    .forEach((photo) => {
      const option = document.createElement("button");
      option.className = `admin-stop-option${photo.id === selectedPhotoId ? " selected" : ""}`;
      option.type = "button";
      const image = document.createElement("img");
      image.src = photo.thumbnailUrl || "";
      image.alt = "";
      const copy = document.createElement("span");
      copy.className = "admin-stop-copy";
      const title = document.createElement("strong");
      title.textContent = photo.title;
      const attribution = document.createElement("small");
      attribution.textContent = `${photo.mediaType === "video" ? "360° video" : "360° photo"} · ${photo.ownerName}`;
      copy.append(title, attribution);
      option.append(image, copy);
      option.addEventListener("click", () => {
        selectedPhotoId = photo.id;
        renderPhotoLibrary();
        renderMapEditor();
        showMessage(saveMessage, `Selected “${photo.title}”. Click the map to place it.`);
      });
      stopList.append(option);
    });
}

function renderPlacedStops() {
  placedStopList.replaceChildren();
  manifest.markers.forEach((marker, index) => {
    const photo = photos.find((item) => item.id === marker.photoId);
    const row = document.createElement("div");
    row.className = "placed-stop-item";
    const copy = document.createElement("span");
    copy.className = "placed-stop-copy";
    const title = document.createElement("strong");
    title.textContent = `${index + 1}. ${photo ? photo.title : `Flickr item ${marker.photoId}`}`;
    const position = document.createElement("small");
    position.textContent = `${Math.round(marker.x * 100)}%, ${Math.round(marker.y * 100)}%`;
    copy.append(title, position);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${title.textContent}`);
    remove.addEventListener("click", () => {
      manifest.markers = manifest.markers.filter((item) => item.photoId !== marker.photoId);
      renderMapEditor();
      renderPlacedStops();
      renderPhotoLibrary();
    });
    row.append(copy, remove);
    placedStopList.append(row);
  });
  if (manifest.markers.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No stops placed yet.";
    placedStopList.append(empty);
  }
}

stopFilter.addEventListener("input", renderPhotoLibrary);

document.querySelector("#saveMapButton").addEventListener("click", async () => {
  showMessage(saveMessage, "Saving map…");
  try {
    manifest = await requestJson("/api/map", {
      method: "PUT",
      body: JSON.stringify(manifest)
    });
    renderMapEditor();
    renderPlacedStops();
    showMessage(saveMessage, "Map saved. The public viewer will use the updated positions.");
  } catch (error) {
    showMessage(saveMessage, error.message, true);
  }
});

document.querySelector("#exportMapButton").addEventListener("click", () => {
  const blob = new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "map.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

checkSession();
