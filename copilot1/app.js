const panel = document.querySelector(".bottom-panel");
const mapCard = document.querySelector("#mapCard");
const menu = document.querySelector("#sideMenu");
const panorama = document.querySelector(".panorama");
const thumbnailRow = document.querySelector("#thumbnailRow");
const photoStatus = document.querySelector("#photoStatus");
const photoCount = document.querySelector("#photoCount");
const searchInput = document.querySelector(".location-search input");

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

document.querySelector("#resetView").addEventListener("click", () => {
  panorama.animate(
    [{ filter: "hue-rotate(0deg)" }, { filter: "hue-rotate(14deg)" }, { filter: "hue-rotate(0deg)" }],
    { duration: 450 }
  );
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
  panorama.classList.add("has-photo");
  panorama.style.backgroundImage = `linear-gradient(90deg, rgba(3,13,15,.28), transparent 55%), url("${photo.imageUrl}")`;
  panorama.style.backgroundPosition = "center";
  panorama.style.backgroundSize = "cover";
}

function renderPhotos(data) {
  thumbnailRow.querySelectorAll(".thumbnail").forEach((thumbnail) => thumbnail.remove());
  photoCount.textContent = `${data.count} photo${data.count === 1 ? "" : "s"}`;
  photoStatus.hidden = data.count > 0;
  data.photos.forEach((photo, index) => {
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
    if (index === 0) selectPhoto(photo, thumbnail);
  });
}

async function loadPhotos(text) {
  photoStatus.hidden = false;
  photoStatus.textContent = "Loading Flickr panoramas…";
  try {
    const response = await fetch(`/api/photos?${new URLSearchParams({ text, tags: "360,equirectangular" })}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The photo service returned an error.");
    renderPhotos(data);
  } catch (error) {
    photoCount.textContent = "Unavailable";
    photoStatus.textContent = error.message;
  }
}

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadPhotos(searchInput.value.trim() || "golden gate bridge");
});
document.querySelector(".clear-search").addEventListener("click", () => {
  searchInput.value = "";
  searchInput.focus();
});
document.querySelector("#flickrLink").hidden = true;
loadPhotos(searchInput.value);
