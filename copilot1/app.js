const panel = document.querySelector(".bottom-panel");
const mapCard = document.querySelector("#mapCard");
const menu = document.querySelector("#sideMenu");
const panorama = document.querySelector(".panorama");
const thumbnailRow = document.querySelector("#thumbnailRow");
const photoStatus = document.querySelector("#photoStatus");
const photoCount = document.querySelector("#photoCount");
const viewerStatus = document.querySelector("#viewerStatus");
const searchInput = document.querySelector(".location-search input");
let userPhotos = [];
let viewer = null;

document.querySelector("#collapsePanel").addEventListener("click", (event) => {
  panel.classList.toggle("collapsed");
  event.currentTarget.textContent = panel.classList.contains("collapsed") ? "⌃" : "⌄";
});

document.querySelector("#mapExpand").addEventListener("click", () => {
  mapCard.classList.toggle("expanded");
});

document.querySelector("#mapToggle").addEventListener("click", () => {
  mapCard.classList.toggle("expanded");
  mapCard.scrollIntoView({ behavior: "smooth", block: "center" });
});

document.querySelector("#menuButton").addEventListener("click", () => {
  menu.classList.add("open");
  menu.setAttribute("aria-hidden", "false");
});

document.querySelector("#menuClose").addEventListener("click", () => {
  menu.classList.remove("open");
  menu.setAttribute("aria-hidden", "true");
});

document.querySelector("#zoomIn").addEventListener("click", () => {
  if (viewer) viewer.setHfov(viewer.getHfov() - 10);
});

document.querySelector("#zoomOut").addEventListener("click", () => {
  if (viewer) viewer.setHfov(viewer.getHfov() + 10);
});

document.querySelector("#resetView").addEventListener("click", () => {
  if (viewer) viewer.lookAt(0, 0, 100, 600);
});

document.querySelector("#fullscreenButton").addEventListener("click", () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.querySelector(".street-view-app").requestFullscreen();
  }
});

function selectPhoto(photo, thumbnail) {
  document.querySelector(".thumbnail.active")?.classList.remove("active");
  thumbnail.classList.add("active");
  document.querySelector("#sceneTitle").textContent = photo.title;
  document.querySelector(".scene-label p").textContent = `By ${photo.ownerName}`;
  const flickrLink = document.querySelector("#flickrLink");
  flickrLink.href = photo.pageUrl;
  flickrLink.hidden = false;
  if (viewer && viewer.getScene() !== photo.sceneId) {
    viewerStatus.textContent = "Loading panorama…";
    viewerStatus.hidden = false;
    viewer.loadScene(photo.sceneId, 0, 0, 100);
  }
}

function initializeViewer(photos) {
  if (photos.length === 0) {
    viewerStatus.textContent = "No 2:1 equirectangular panoramas were found in the configured Flickr source.";
    viewerStatus.hidden = false;
    return;
  }
  if (viewer) return;
  if (!window.pannellum) {
    viewerStatus.textContent = "The 360° viewer could not be loaded. Check your connection and reload.";
    viewerStatus.hidden = false;
    return;
  }

  const scenes = {};
  photos.forEach((photo, index) => {
    photo.sceneId = `photo-${photo.id}`;
    scenes[photo.sceneId] = {
      type: "equirectangular",
      panorama: photo.panoramaUrl,
      title: photo.title,
      author: photo.ownerName,
      hfov: 100,
      pitch: 0,
      yaw: 0
    };
  });

  viewer = window.pannellum.viewer("panoramaViewer", {
    default: { firstScene: photos[0].sceneId },
    scenes,
    autoLoad: true,
    showControls: false,
    showFullscreenCtrl: false,
    showZoomCtrl: false,
    mouseZoom: true,
    keyboardZoom: true,
    draggable: true,
    friction: 0.15,
    hfov: 100,
    minHfov: 35,
    maxHfov: 120,
    crossOrigin: "anonymous",
    escapeHTML: true
  });
  viewer.on("load", () => {
    viewerStatus.hidden = true;
  });
  viewer.on("error", (error) => {
    viewerStatus.textContent = `Could not load this panorama: ${error}`;
    viewerStatus.hidden = false;
  });
}

function renderPhotos(data) {
  thumbnailRow.querySelectorAll(".thumbnail").forEach((thumbnail) => thumbnail.remove());
  photoCount.textContent = `${data.length} photo${data.length === 1 ? "" : "s"}`;
  photoStatus.hidden = data.length > 0;
  if (data.length === 0) {
    photoStatus.textContent = userPhotos.length === 0
      ? "No suitable 360° panoramas found."
      : "No photos match this filter.";
  }
  data.forEach((photo, index) => {
    const thumbnail = document.createElement("button");
    thumbnail.className = `thumbnail${index === 0 ? " active" : ""}`;
    thumbnail.type = "button";
    thumbnail.setAttribute("aria-label", photo.title);
    const image = document.createElement("img");
    image.className = "thumb-art";
    image.src = photo.thumbnailUrl;
    image.alt = "";
    const title = document.createElement("strong");
    title.textContent = photo.title;
    const attribution = document.createElement("small");
    attribution.textContent = `Flickr · ${photo.ownerName}`;
    thumbnail.append(image, title, attribution);
    thumbnail.addEventListener("click", () => selectPhoto(photo, thumbnail));
    thumbnailRow.insertBefore(thumbnail, thumbnailRow.querySelector(".add-photo"));
    if (index === 0) {
      selectPhoto(photo, thumbnail);
    }
  });
}

async function loadPhotos() {
  photoStatus.hidden = false;
  photoStatus.textContent = "Loading photos from Flickr…";
  try {
    const response = await fetch("/api/photos");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The photo service returned an error.");
    userPhotos = data.photos;
    initializeViewer(userPhotos);
    filterPhotos();
  } catch (error) {
    photoCount.textContent = "Unavailable";
    photoStatus.textContent = error.message;
    viewerStatus.textContent = `Could not load Flickr photos: ${error.message}`;
    viewerStatus.hidden = false;
  }
}

function filterPhotos() {
  const filter = searchInput.value.trim().toLocaleLowerCase();
  renderPhotos(userPhotos.filter((photo) =>
    `${photo.title} ${photo.ownerName}`.toLocaleLowerCase().includes(filter)
  ));
}

searchInput.addEventListener("input", filterPhotos);
document.querySelector(".clear-search").addEventListener("click", () => {
  searchInput.value = "";
  filterPhotos();
  searchInput.focus();
});
document.querySelector("#flickrLink").hidden = true;
loadPhotos();
