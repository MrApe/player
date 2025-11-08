import {
  getAllTrackRecords,
  saveTrackRecord,
  deleteTrackRecord,
  persistTrackOrder,
  saveSettings,
  loadSettings,
} from "./storage.js";
import { Track, PlaybackController } from "./player.js";

const defaultSettings = {
  mode: "continuous",
  pauseSeconds: 2,
  selectedTrackId: null,
  halfBufferSeconds: 5,
  chunkCount: 3,
  chunkRepeats: 1,
  chunkLeadBuffer: 5,
  chunkTailBuffer: 5,
};

const state = {
  tracks: [],
  settings: { ...defaultSettings },
  isPlaying: false,
  isPaused: false,
  currentTrackId: null,
};

const elements = {
  addTracksButton: document.getElementById("addTracksButton"),
  fileInput: document.getElementById("trackFileInput"),
  trackList: document.getElementById("trackList"),
  emptyTrackState: document.getElementById("emptyTrackState"),
  modeSelect: document.getElementById("modeSelect"),
  pauseSeconds: document.getElementById("pauseSeconds"),
  halfBufferSeconds: document.getElementById("halfBufferSeconds"),
  chunkCount: document.getElementById("chunkCount"),
  chunkRepeats: document.getElementById("chunkRepeats"),
  chunkLeadBuffer: document.getElementById("chunkLeadBuffer"),
  chunkTailBuffer: document.getElementById("chunkTailBuffer"),
  playPauseButton: document.getElementById("playPauseButton"),
  seekBackButton: document.getElementById("seekBackButton"),
  seekForwardButton: document.getElementById("seekForwardButton"),
  nextSegmentButton: document.getElementById("nextSegmentButton"),
  stopButton: document.getElementById("stopButton"),
  currentTrackLabel: document.getElementById("currentTrackLabel"),
  currentTimeLabel: document.getElementById("currentTimeLabel"),
  progressFill: document.getElementById("progressFill"),
  segmentHighlight: document.getElementById("segmentHighlight"),
  progressStartLabel: document.getElementById("progressStartLabel"),
  progressEndLabel: document.getElementById("progressEndLabel"),
  nowPlaying: document.getElementById("nowPlaying"),
  chunkStatus: document.getElementById("chunkStatus"),
};

const player = new PlaybackController();
player.setStatusCallback((status) => {
  updateStatus(status);
});

let settingsSaveTimeout = null;

init();

async function init() {
  await restoreState();
  bindEvents();
  renderTrackList();
  applySettingsToInputs();
  updateModeVisibility(state.settings.mode);
  updateButtons();
  resetProgress();
  updateStatus({ kind: "message", note: "Bereit." });
  registerServiceWorker();
}

async function restoreState() {
  const storedSettings = await loadSettings();
  state.settings = {
    ...defaultSettings,
    ...(storedSettings || {}),
  };

  const records = await getAllTrackRecords();
  state.tracks = records.map((record, index) => {
    const track = new Track(record);
    track.order = index;
    return track;
  });

  if (state.tracks.length && !state.settings.selectedTrackId) {
    state.settings.selectedTrackId = state.tracks[0].id;
    queueSettingsSave();
  }
}

function bindEvents() {
  elements.addTracksButton.addEventListener("click", () => {
    elements.fileInput.click();
  });

  elements.fileInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) {
      return;
    }
    await addTracks(files);
  });

  elements.modeSelect.addEventListener("change", (event) => {
    const mode = event.target.value;
    state.settings.mode = mode;
    updateModeVisibility(mode);
    queueSettingsSave();
  });

  bindNumberInput(elements.pauseSeconds, "pauseSeconds");
  bindNumberInput(elements.halfBufferSeconds, "halfBufferSeconds");
  bindNumberInput(elements.chunkCount, "chunkCount", { integer: true, min: 2 });
  bindNumberInput(elements.chunkRepeats, "chunkRepeats", { integer: true, min: 1 });
  bindNumberInput(elements.chunkLeadBuffer, "chunkLeadBuffer", { min: 0 });
  bindNumberInput(elements.chunkTailBuffer, "chunkTailBuffer", { min: 0 });

  elements.playPauseButton.addEventListener("click", handlePlayPause);
  elements.stopButton.addEventListener("click", stopPlayback);
  elements.seekBackButton.addEventListener("click", () => player.seekBy(-5));
  elements.seekForwardButton.addEventListener("click", () => player.seekBy(5));
  elements.nextSegmentButton.addEventListener("click", () => player.skipSegment());
}

function bindNumberInput(element, key, options = {}) {
  element.addEventListener("input", () => {
    const rawValue = element.value;
    let numericValue = options.integer ? parseInt(rawValue, 10) : parseFloat(rawValue);
    if (!Number.isFinite(numericValue)) {
      numericValue = defaultSettings[key];
    }
    if (typeof options.min === "number" && numericValue < options.min) {
      numericValue = options.min;
    }
    if (typeof options.max === "number" && numericValue > options.max) {
      numericValue = options.max;
    }
    state.settings[key] = numericValue;
    queueSettingsSave();
  });
}

function handlePlayPause() {
  if (!state.tracks.length) {
    updateStatus({ kind: "message", note: "Bitte zuerst Titel hinzufügen." });
    return;
  }
  if (!player.playing) {
    startPlayback();
    return;
  }
  if (player.paused) {
    player.resume();
  } else {
    player.pause();
  }
}

async function addTracks(files) {
  for (const file of files) {
    const duration = await getFileDuration(file);
    const id = crypto.randomUUID();
    const record = {
      id,
      name: file.name,
      type: file.type,
      order: state.tracks.length,
      duration,
      blob: file,
    };
    await saveTrackRecord(record);
    const track = new Track(record);
    state.tracks.push(track);
  }

  if (state.tracks.length && !state.settings.selectedTrackId) {
    state.settings.selectedTrackId = state.tracks[0].id;
  }
  queueSettingsSave();
  renderTrackList();
  updateButtons();
}

async function getFileDuration(file) {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    const url = URL.createObjectURL(file);

    const cleanup = () => {
      URL.revokeObjectURL(url);
    };

    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      cleanup();
      resolve(duration);
    };
    audio.onerror = () => {
      cleanup();
      resolve(0);
    };

    audio.src = url;
    audio.load();
  });
}

function renderTrackList() {
  elements.trackList.innerHTML = "";
  if (!state.tracks.length) {
    elements.emptyTrackState.classList.add("visible");
    updateTrackHighlight();
    return;
  }
  elements.emptyTrackState.classList.remove("visible");

  state.tracks.forEach((track, index) => {
    const listItem = document.createElement("li");
    listItem.className = "track-card";
    listItem.dataset.trackId = track.id;

    const focusWrapper = document.createElement("label");
    focusWrapper.className = "track-focus";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "focusTrack";
    radio.value = track.id;
    radio.checked = state.settings.selectedTrackId === track.id;
    radio.addEventListener("change", () => {
      state.settings.selectedTrackId = track.id;
      queueSettingsSave();
    });
    const focusText = document.createElement("span");
    focusText.textContent = "Fokus";
    focusWrapper.append(radio, focusText);

    const meta = document.createElement("div");
    meta.className = "track-meta";
    const title = document.createElement("p");
    title.className = "track-name";
    title.textContent = track.name;
    const duration = document.createElement("span");
    duration.className = "track-duration";
    const formattedDuration = formatDuration(track.duration);
    duration.textContent = formattedDuration ? `Dauer: ${formattedDuration}` : "Dauer unbekannt";
    meta.append(title, duration);

    const actions = document.createElement("div");
    actions.className = "track-actions";

    const upButton = document.createElement("button");
    upButton.className = "ghost-button";
    upButton.textContent = "▲";
    upButton.disabled = index === 0;
    upButton.addEventListener("click", () => moveTrack(track.id, -1));

    const downButton = document.createElement("button");
    downButton.className = "ghost-button";
    downButton.textContent = "▼";
    downButton.disabled = index === state.tracks.length - 1;
    downButton.addEventListener("click", () => moveTrack(track.id, 1));

    const deleteButton = document.createElement("button");
    deleteButton.className = "ghost-button";
    deleteButton.textContent = "Entfernen";
    deleteButton.addEventListener("click", () => removeTrack(track.id));

    actions.append(upButton, downButton, deleteButton);

    listItem.append(focusWrapper, meta, actions);
    elements.trackList.appendChild(listItem);
  });
  updateTrackHighlight();
}

async function moveTrack(trackId, direction) {
  const index = state.tracks.findIndex((track) => track.id === trackId);
  if (index === -1) {
    return;
  }
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= state.tracks.length) {
    return;
  }
  const [track] = state.tracks.splice(index, 1);
  state.tracks.splice(newIndex, 0, track);
  state.tracks.forEach((item, idx) => {
    item.order = idx;
  });
  await persistTrackOrder(state.tracks.map((item) => item.toRecord()));
  renderTrackList();
  updateButtons();
}

async function removeTrack(trackId) {
  const index = state.tracks.findIndex((track) => track.id === trackId);
  if (index === -1) {
    return;
  }
  const [removedTrack] = state.tracks.splice(index, 1);
  if (removedTrack) {
    removedTrack.revokeObjectUrl();
  }
  await deleteTrackRecord(trackId);
  state.tracks.forEach((item, idx) => {
    item.order = idx;
  });
  await persistTrackOrder(state.tracks.map((item) => item.toRecord()));

  if (state.settings.selectedTrackId === trackId) {
    state.settings.selectedTrackId = state.tracks[0]?.id ?? null;
    queueSettingsSave();
  }
  if (state.currentTrackId === trackId) {
    state.currentTrackId = null;
    player.stop();
    resetProgress();
  }
  renderTrackList();
  updateButtons();
}

function applySettingsToInputs() {
  elements.modeSelect.value = state.settings.mode;
  elements.pauseSeconds.value = state.settings.pauseSeconds ?? defaultSettings.pauseSeconds;
  elements.halfBufferSeconds.value =
    state.settings.halfBufferSeconds ?? defaultSettings.halfBufferSeconds;
  elements.chunkCount.value = state.settings.chunkCount ?? defaultSettings.chunkCount;
  elements.chunkRepeats.value = state.settings.chunkRepeats ?? defaultSettings.chunkRepeats;
  elements.chunkLeadBuffer.value =
    state.settings.chunkLeadBuffer ?? defaultSettings.chunkLeadBuffer;
  elements.chunkTailBuffer.value =
    state.settings.chunkTailBuffer ?? defaultSettings.chunkTailBuffer;
}

function updateModeVisibility(mode) {
  document.querySelectorAll(".mode-config").forEach((section) => {
    const sectionMode = section.dataset.mode;
    if (sectionMode === mode) {
      section.classList.add("visible");
    } else {
      section.classList.remove("visible");
    }
  });
}

function updateButtons() {
  const hasTracks = state.tracks.length > 0;
  const isPlaying = player.playing;
  const isPaused = player.paused;
  const hasSeekableSegment = player.hasActiveSegment;

  elements.playPauseButton.disabled = !hasTracks && !isPlaying;
  elements.playPauseButton.textContent = !isPlaying || isPaused ? "Play" : "Pause";
  elements.stopButton.disabled = !isPlaying;
  elements.seekBackButton.disabled = !hasSeekableSegment;
  elements.seekForwardButton.disabled = !hasSeekableSegment;
  elements.nextSegmentButton.disabled = !isPlaying;
}

async function startPlayback() {
  if (player.playing) {
    return;
  }
  if (!state.tracks.length) {
    updateStatus({ kind: "message", note: "Bitte zuerst Titel hinzufügen." });
    return;
  }
  updateButtons();
  try {
    await player.play(state.tracks, state.settings);
  } catch (error) {
    console.error(error);
    updateStatus({ kind: "message", note: error?.message || "Fehler beim Abspielen." });
  }
}

function stopPlayback() {
  player.stop();
  updateStatus({ kind: "message", note: "Gestoppt." });
  updateButtons();
}

function updateStatus(status) {
  if (!status) {
    return;
  }

  switch (status.kind) {
    case "state":
      state.isPlaying = Boolean(status.isPlaying);
      state.isPaused = Boolean(status.isPaused);
      updateButtons();
      if (!status.isPlaying) {
        state.currentTrackId = null;
        resetProgress();
        if (!elements.nowPlaying.textContent) {
          elements.nowPlaying.textContent = "Bereit.";
        }
        elements.chunkStatus.textContent = "";
        updateTrackHighlight();
      }
      break;
    case "segment":
      state.currentTrackId = status.trackId ?? null;
      updateTrackHighlight();
      if (status.trackName) {
        elements.currentTrackLabel.textContent = status.trackName;
        elements.nowPlaying.textContent = status.note
          ? `${status.trackName} · ${status.note}`
          : status.trackName;
      } else {
        elements.currentTrackLabel.textContent = "Kein Titel ausgewählt";
        elements.nowPlaying.textContent = status.note ?? "Bereit.";
      }
      elements.progressStartLabel.textContent = "0:00";
      elements.progressEndLabel.textContent = formatDuration(status.trackDuration) || "0:00";
      updateSegmentHighlight(status.segmentStart, status.segmentEnd, status.trackDuration);
      updateChunkInfo(status);
      break;
    case "progress":
      if (typeof status.currentTime === "number") {
        elements.currentTimeLabel.textContent = formatDuration(status.currentTime) || "00:00";
      }
      updateProgressFill(status.currentTime, status.trackDuration);
      break;
    case "gap":
      elements.currentTrackLabel.textContent = "Pause";
      elements.nowPlaying.textContent = status.note ?? "Pause";
      elements.chunkStatus.textContent = "";
      updateProgressFill(0, 0);
      updateSegmentHighlight(0, 0, 0);
      elements.progressStartLabel.textContent = "0:00";
      elements.progressEndLabel.textContent = "0:00";
      elements.currentTimeLabel.textContent = "00:00";
      break;
    case "message":
      elements.nowPlaying.textContent = status.note ?? "";
      break;
    default:
      break;
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  const totalSeconds = Math.floor(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function resetProgress() {
  elements.currentTrackLabel.textContent = "Kein Titel ausgewählt";
  elements.currentTimeLabel.textContent = "00:00";
  elements.progressStartLabel.textContent = "0:00";
  elements.progressEndLabel.textContent = "0:00";
  updateProgressFill(0, 0);
  updateSegmentHighlight(0, 0, 0);
}

function updateProgressFill(currentTime = 0, duration = 0) {
  const hasDuration = Number.isFinite(duration) && duration > 0;
  const progressValue = hasDuration ? (Math.max(0, currentTime || 0) / duration) * 100 : 0;
  const clamped = Math.min(100, Math.max(0, progressValue));
  elements.progressFill.style.width = `${clamped}%`;
}

function updateSegmentHighlight(start, end, duration) {
  const valid =
    Number.isFinite(duration) &&
    duration > 0 &&
    Number.isFinite(start) &&
    Number.isFinite(end);
  if (!valid) {
    elements.segmentHighlight.style.left = "0%";
    elements.segmentHighlight.style.width = "0%";
    return;
  }
  const safeStart = Math.min(Math.max(start, 0), duration);
  const safeEnd = Math.min(Math.max(end, safeStart), duration);
  const left = (safeStart / duration) * 100;
  const width = Math.max(0, ((safeEnd - safeStart) / duration) * 100);
  elements.segmentHighlight.style.left = `${left}%`;
  elements.segmentHighlight.style.width = `${width}%`;
}

function updateTrackHighlight() {
  const cards = elements.trackList.querySelectorAll(".track-card");
  cards.forEach((card) => {
    card.classList.toggle("playing", card.dataset.trackId === state.currentTrackId);
  });
}

function updateChunkInfo(status) {
  if (status.mode === "chunks" && status.chunkIndex) {
    const details = [];
    details.push(`Stück ${status.chunkIndex}/${status.chunkTotal}`);
    details.push(`Wdh. ${status.repeatIndex}/${status.repeatTotal}`);
    if (Number.isFinite(status.segmentStart) && Number.isFinite(status.segmentEnd)) {
      const startLabel = formatDuration(status.segmentStart) || "00:00";
      const endLabel = formatDuration(status.segmentEnd) || "00:00";
      details.push(`${startLabel} – ${endLabel}`);
    }
    elements.chunkStatus.textContent = details.join(" | ");
  } else {
    elements.chunkStatus.textContent = "";
  }
}

function queueSettingsSave() {
  if (settingsSaveTimeout) {
    clearTimeout(settingsSaveTimeout);
  }
  settingsSaveTimeout = setTimeout(async () => {
    settingsSaveTimeout = null;
    try {
      await saveSettings(state.settings);
    } catch (error) {
      console.error("Speichern der Einstellungen fehlgeschlagen:", error);
    }
  }, 200);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("/service-worker.js")
      .catch((error) => console.warn("Service Worker Registrierung fehlgeschlagen:", error));
  }
}
