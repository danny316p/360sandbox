const panel = document.querySelector(".bottom-panel");
const mapCard = document.querySelector("#mapCard");
const menu = document.querySelector("#sideMenu");
const panorama = document.querySelector(".panorama");
const thumbnailRow = document.querySelector("#thumbnailRow");
const photoStatus = document.querySelector("#photoStatus");
const photoCount = document.querySelector("#photoCount");
const viewerStatus = document.querySelector("#viewerStatus");
const videoControls = document.querySelector("#videoControls");
const videoPlayPause = document.querySelector("#videoPlayPause");
const videoSeek = document.querySelector("#videoSeek");
const videoTime = document.querySelector("#videoTime");
const searchInput = document.querySelector(".location-search input");
let userPhotos = [];
let viewer = null;
let viewerReady = false;
let pendingScene = null;
let currentPhoto = null;
let currentVideo = null;
let videoSelectionToken = 0;
const videoScenes = new Map();
const videoControlListeners = new WeakSet();
let autoRotate = false;
let noticeTimeout;

document.querySelector("#collapsePanel").addEventListener("click", (event) => {
  panel.classList.toggle("collapsed");
  event.currentTarget.textContent = panel.classList.contains("collapsed") ? "⌃" : "⌄";
  event.currentTarget.setAttribute("aria-label", panel.classList.contains("collapsed") ? "Expand photo panel" : "Collapse photo panel");
});

document.querySelector("#mapExpand").addEventListener("click", () => {
  setMapExpanded(!mapCard.classList.contains("expanded"));
});

document.querySelector("#mapToggle").addEventListener("click", () => {
  setMapVisible(mapCard.hidden);
});

function setMapVisible(visible) {
  mapCard.hidden = !visible;
  const mapToggle = document.querySelector("#mapToggle");
  mapToggle.setAttribute("aria-pressed", String(visible));
  document.querySelector("#mapToggleLabel").textContent = visible ? "Hide map" : "Show map";
}

function setMapExpanded(expanded) {
  mapCard.classList.toggle("expanded", expanded);
  document.querySelector("#mapToggle").setAttribute("aria-expanded", String(expanded));
  document.querySelector("#mapExpand").setAttribute("aria-label", expanded ? "Shrink map preview" : "Expand map preview");
}

function setMenuOpen(open) {
  menu.classList.toggle("open", open);
  menu.setAttribute("aria-hidden", String(!open));
  document.querySelector("#menuBackdrop").hidden = !open;
  document.querySelector("#menuButton").setAttribute("aria-expanded", String(open));
}

document.querySelector("#menuButton").addEventListener("click", () => {
  setMenuOpen(true);
  document.querySelector("#menuClose").focus();
});

document.querySelector("#menuClose").addEventListener("click", () => {
  setMenuOpen(false);
  document.querySelector("#menuButton").focus();
});

document.querySelector("#menuBackdrop").addEventListener("click", () => setMenuOpen(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menu.classList.contains("open")) {
    setMenuOpen(false);
    document.querySelector("#menuButton").focus();
  }
});

document.querySelector("#autoRotateButton").addEventListener("click", (event) => {
  autoRotate = !autoRotate;
  event.currentTarget.setAttribute("aria-pressed", String(autoRotate));
  document.querySelector("#autoRotateState").textContent = autoRotate ? "On" : "Off";
  if (viewer) {
    if (autoRotate) viewer.startAutoRotate(2, 0);
    else viewer.stopAutoRotate();
  }
});

function showNotice(message) {
  const notice = document.querySelector("#appNotice");
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(noticeTimeout);
  noticeTimeout = setTimeout(() => { notice.hidden = true; }, 3000);
}

document.querySelector("#shareButton").addEventListener("click", async () => {
  if (!currentPhoto) {
    showNotice("Select a photo before sharing.");
    return;
  }
  try {
    await navigator.clipboard.writeText(currentPhoto.pageUrl);
    showNotice("Flickr photo link copied.");
  } catch (error) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      showNotice("Clipboard access was blocked. Open the Flickr photo link to share it.");
      return;
    }
    showNotice("Could not copy the Flickr photo link.");
  }
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
  videoSelectionToken += 1;
  const selectionToken = videoSelectionToken;
  document.querySelector(".thumbnail.active")?.classList.remove("active");
  thumbnail.classList.add("active");
  document.querySelector("#sceneTitle").textContent = photo.title;
  document.querySelector(".scene-label p").textContent = `By ${photo.ownerName}`;
  const flickrLink = document.querySelector("#flickrLink");
  flickrLink.href = photo.pageUrl;
  flickrLink.hidden = false;
  currentPhoto = photo;
  const isVideo = photo.mediaType === "video";
  panorama.classList.toggle("is-video", isVideo);
  if (isVideo) {
    const cachedVideo = videoScenes.get(photo.id);
    if (currentVideo && currentVideo !== cachedVideo) currentVideo.pause();
    if (viewer) viewer.stopAutoRotate();
    videoControls.hidden = false;
    viewerStatus.textContent = "Loading 360° video…";
    viewerStatus.hidden = false;
    loadVideoScene(photo, selectionToken);
    return;
  }
  if (currentVideo) currentVideo.pause();
  currentVideo = null;
  videoControls.hidden = true;
  if (viewer && viewer.getScene() !== photo.sceneId) {
    viewerStatus.textContent = "Loading panorama…";
    viewerStatus.hidden = false;
    requestScene(photo.sceneId);
  } else if (viewer && autoRotate) {
    viewer.startAutoRotate(2, 0);
  }
}

async function loadVideoScene(photo, selectionToken) {
  try {
    let video = videoScenes.get(photo.id);
    if (!video) {
      const response = await fetch(`/api/video-source?id=${encodeURIComponent(photo.id)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Flickr could not provide this video.");
      if (selectionToken !== videoSelectionToken) return;

      video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.preload = "auto";
      video.playsInline = true;
      video.src = data.videoUrl;
      video.load();
      await waitForVideoMetadata(video);
      videoScenes.set(photo.id, video);
    }
    if (selectionToken !== videoSelectionToken) {
      video.pause();
      return;
    }

    currentVideo = video;
    photo.sceneId = `video-${photo.id}`;
    const scene = {
      type: "equirectangular",
      panorama: video,
      dynamic: true,
      dynamicUpdate: true,
      title: photo.title,
      author: photo.ownerName,
      hfov: 100,
      pitch: 0,
      yaw: 0
    };
    if (!viewer) {
      initializeViewerWithScene(photo.sceneId, scene);
    } else {
      viewer.addScene(photo.sceneId, scene);
      if (viewer.getScene() !== photo.sceneId) {
        requestScene(photo.sceneId);
      } else if (viewerReady) {
        viewerStatus.hidden = true;
      }
    }
    updateVideoControls(video);
    if (!videoControlListeners.has(video)) {
      video.addEventListener("timeupdate", () => updateVideoControls(video));
      video.addEventListener("play", () => updateVideoControls(video));
      video.addEventListener("pause", () => updateVideoControls(video));
      video.addEventListener("ended", () => updateVideoControls(video));
      video.addEventListener("error", () => {
        if (currentVideo === video) {
          viewerStatus.textContent = "Flickr’s video stream stopped unexpectedly.";
          viewerStatus.hidden = false;
        }
      });
      videoControlListeners.add(video);
    }
    video.play().catch(() => {
      if (currentVideo === video) updateVideoControls(video);
    });
  } catch (error) {
    if (selectionToken !== videoSelectionToken) return;
    viewerStatus.textContent = `Could not load this Flickr video: ${error.message}`;
    viewerStatus.hidden = false;
  }
}

function waitForVideoMetadata(video) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    video.addEventListener("loadedmetadata", resolve, { once: true });
    video.addEventListener("error", () => {
      reject(new Error("Flickr’s video stream could not be played in this browser."));
    }, { once: true });
  });
}

function initializeViewerWithScene(sceneId, scene) {
  if (!window.pannellum) {
    throw new Error("The 360° viewer could not be loaded. Check your connection and reload.");
  }
  viewer = window.pannellum.viewer("panoramaViewer", {
    default: { firstScene: sceneId },
    scenes: { [sceneId]: scene },
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
    escapeHTML: true
  });
  viewerReady = false;
  addViewerListeners();
}

function initializeViewer(photos) {
  const panoramaPhotos = photos.filter((photo) => photo.mediaType !== "video");
  if (panoramaPhotos.length === 0) return;
  if (viewer) return;
  if (!window.pannellum) {
    viewerStatus.textContent = "The 360° viewer could not be loaded. Check your connection and reload.";
    viewerStatus.hidden = false;
    return;
  }

  const scenes = {};
  panoramaPhotos.forEach((photo) => {
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
    default: { firstScene: panoramaPhotos[0].sceneId },
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
  viewerReady = false;
  addViewerListeners();
}

function addViewerListeners() {
  const handleViewerLoad = () => {
    viewerReady = true;
    viewerStatus.hidden = true;
    if (autoRotate && currentPhoto?.mediaType !== "video") viewer.startAutoRotate(2, 0);
    if (pendingScene) {
      const sceneId = pendingScene;
      pendingScene = null;
      requestScene(sceneId);
    }
  };
  viewer.on("load", handleViewerLoad);
  viewer.on("error", (error) => {
    viewerReady = true;
    viewerStatus.textContent = `Could not load this panorama: ${error}`;
    viewerStatus.hidden = false;
  });
  if (viewer.isLoaded()) handleViewerLoad();
}

function requestScene(sceneId) {
  if (!viewer || viewer.getScene() === sceneId) return;
  if (!viewerReady) {
    pendingScene = sceneId;
    return;
  }
  viewerReady = false;
  viewer.loadScene(sceneId, 0, 0, 100);
}

function formatVideoTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

function updateVideoControls(video) {
  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    videoSeek.value = "0";
    videoTime.textContent = `${formatVideoTime(video.currentTime)} / 0:00`;
  } else {
    videoSeek.value = String(Math.round(video.currentTime / video.duration * 1000));
    videoTime.textContent = `${formatVideoTime(video.currentTime)} / ${formatVideoTime(video.duration)}`;
  }
  const isPlaying = !video.paused && !video.ended;
  videoPlayPause.textContent = isPlaying ? "Ⅱ" : "▶";
  videoPlayPause.setAttribute("aria-label", isPlaying ? "Pause video" : "Play video");
}

videoPlayPause.addEventListener("click", () => {
  if (!currentVideo) return;
  if (currentVideo.paused) {
    currentVideo.play().catch((error) => showNotice(`Could not play this video: ${error.message}`));
  } else {
    currentVideo.pause();
  }
});

videoSeek.addEventListener("input", () => {
  if (currentVideo && Number.isFinite(currentVideo.duration)) {
    currentVideo.currentTime = Number(videoSeek.value) / 1000 * currentVideo.duration;
  }
});

function renderPhotos(data) {
  thumbnailRow.querySelectorAll(".thumbnail").forEach((thumbnail) => thumbnail.remove());
  photoCount.textContent = `${data.length} item${data.length === 1 ? "" : "s"}`;
  photoStatus.hidden = data.length > 0;
  if (data.length === 0) {
    photoStatus.textContent = userPhotos.length === 0
      ? "No suitable 360° photos or videos found."
      : "No photos or videos match this filter.";
  }
  data.forEach((photo, index) => {
    const thumbnail = document.createElement("button");
    thumbnail.className = `thumbnail${index === 0 ? " active" : ""}`;
    thumbnail.type = "button";
    thumbnail.setAttribute("aria-label", `${photo.mediaType === "video" ? "360 degree video" : "360 degree photo"}: ${photo.title}`);
    const image = document.createElement("img");
    image.className = "thumb-art";
    if (photo.thumbnailUrl) image.src = photo.thumbnailUrl;
    image.alt = "";
    const title = document.createElement("strong");
    title.textContent = photo.title;
    const attribution = document.createElement("small");
    attribution.textContent = `Flickr · ${photo.ownerName}`;
    thumbnail.append(image, title, attribution);
    if (photo.mediaType === "video") {
      const badge = document.createElement("span");
      badge.className = "media-badge";
      badge.textContent = "▶ 360° video";
      thumbnail.append(badge);
    }
    thumbnail.addEventListener("click", () => selectPhoto(photo, thumbnail));
    thumbnailRow.append(thumbnail);
    if (index === 0) {
      selectPhoto(photo, thumbnail);
    }
  });
}

async function loadPhotos() {
  photoStatus.hidden = false;
  photoStatus.textContent = "Loading photos from Flickr…";
  try {
    const perPage = 500;
    const firstPage = await fetchPhotoPage(1, perPage);
    const allPhotos = firstPage.photos;
    for (let page = 2; page <= firstPage.pages; page += 1) {
      photoStatus.textContent = `Loading Flickr album (${page} of ${firstPage.pages})…`;
      const nextPage = await fetchPhotoPage(page, perPage);
      allPhotos.push(...nextPage.photos);
    }
    userPhotos = allPhotos;
    initializeViewer(userPhotos);
    if (firstPage.profileUrl) {
      const accountLink = document.querySelector("#accountLink");
      accountLink.href = firstPage.profileUrl;
      if (firstPage.avatarUrl) {
        const avatar = document.createElement("img");
        avatar.src = firstPage.avatarUrl;
        avatar.alt = "";
        avatar.addEventListener("error", () => {
          avatar.remove();
          accountLink.textContent = "F";
        }, { once: true });
        accountLink.replaceChildren(avatar);
      }
      accountLink.hidden = false;
      const profileMenuLink = document.querySelector("#profileMenuLink");
      profileMenuLink.href = firstPage.profileUrl;
      profileMenuLink.hidden = false;
    }
    filterPhotos();
  } catch (error) {
    photoCount.textContent = "Unavailable";
    photoStatus.textContent = error.message;
    viewerStatus.textContent = `Could not load Flickr photos: ${error.message}`;
    viewerStatus.hidden = false;
  }
}

async function fetchPhotoPage(page, perPage) {
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  const response = await fetch(`/api/photos?${params}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The photo service returned an error.");
  if (!Array.isArray(data.photos) || !Number.isInteger(data.pages)) {
    throw new Error("The photo service returned an invalid album page.");
  }
  return data;
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
