function loadDurationFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    const url = URL.createObjectURL(blob);
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
      reject(new Error("Metadaten konnten nicht geladen werden"));
    };
    audio.src = url;
    audio.load();
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class Track {
  constructor(record) {
    this.id = record.id;
    this.name = record.name;
    this.type = record.type;
    this.order = record.order ?? 0;
    this.duration = typeof record.duration === "number" ? record.duration : null;
    this._blob = record.blob;
    this._objectUrl = null;
  }

  get blob() {
    return this._blob;
  }

  set blob(value) {
    this._blob = value;
    this.revokeObjectUrl();
  }

  async ensureDuration() {
    if (typeof this.duration === "number" && this.duration > 0) {
      return this.duration;
    }
    if (!this._blob) {
      return 0;
    }
    try {
      this.duration = await loadDurationFromBlob(this._blob);
    } catch {
      this.duration = 0;
    }
    return this.duration;
  }

  getObjectUrl() {
    if (!this._blob) {
      throw new Error("Kein Audiodaten-Blob verfügbar");
    }
    if (!this._objectUrl) {
      this._objectUrl = URL.createObjectURL(this._blob);
    }
    return this._objectUrl;
  }

  revokeObjectUrl() {
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = null;
    }
  }

  toRecord() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      order: this.order,
      duration: this.duration,
      blob: this._blob,
    };
  }
}

export class PlaybackController {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.crossOrigin = "anonymous";
    this.audio.setAttribute("playsinline", "true");
    this.audio.addEventListener("timeupdate", () => this.handleTimeUpdate());
    this.audio.addEventListener("ended", () => this.handleAudioEnded());

    this.statusCallback = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.stopRequested = false;
    this.nextRequested = false;
    this.currentSegment = null;
    this.segmentResolve = null;
    this.gapTimeout = null;
    this.mode = null;
    this.shouldStartPaused = false;
  }

  get playing() {
    return this.isPlaying;
  }

  get paused() {
    return this.isPaused;
  }

  get hasActiveSegment() {
    return Boolean(this.currentSegment && this.currentSegment.kind === "audio");
  }

  setStatusCallback(callback) {
    this.statusCallback = callback;
  }

  notify(payload) {
    if (typeof this.statusCallback === "function") {
      this.statusCallback(payload);
    }
  }

  emitState() {
    this.notify({
      kind: "state",
      mode: this.mode,
      isPlaying: this.isPlaying,
      isPaused: this.isPaused,
    });
  }

  async play(tracks, settings) {
    if (this.isPlaying) {
      return;
    }
    if (!tracks.length) {
      throw new Error("Keine Titel zum Abspielen vorhanden.");
    }

    this.stopRequested = false;
    this.nextRequested = false;
    this.mode = settings.mode;
    this.isPlaying = true;
    this.isPaused = false;
    this.emitState();

    try {
      for (const track of tracks) {
        await track.ensureDuration();
      }

      switch (settings.mode) {
        case "continuous":
          await this.playContinuous(tracks, settings);
          break;
        case "gap":
          await this.playWithGap(tracks, settings);
          break;
        case "single":
          await this.playSingleLoop(tracks, settings);
          break;
        case "half":
          await this.playHalfFrontHalf(tracks, settings);
          break;
        case "chunks":
          await this.playChunks(tracks, settings);
          break;
        default:
          throw new Error(`Unbekannter Modus: ${settings.mode}`);
      }

      if (!this.stopRequested) {
        this.notify({ kind: "message", mode: settings.mode, note: "Fertig." });
      }
    } finally {
      this.cleanup();
    }
  }

  stop() {
    if (!this.isPlaying && !this.currentSegment) {
      return;
    }
    this.stopRequested = true;
    this.nextRequested = false;
    this.shouldStartPaused = false;
    if (this.currentSegment?.kind === "gap") {
      this.finishSegment("stop");
    } else {
      this.audio.pause();
      this.finishSegment("stop");
    }
  }

  pause() {
    if (!this.isPlaying || this.isPaused || !this.hasActiveSegment) {
      return;
    }
    this.audio.pause();
    this.isPaused = true;
    this.emitState();
  }

  async resume() {
    if (!this.isPlaying || !this.isPaused || !this.hasActiveSegment) {
      return;
    }
    try {
      await this.audio.play();
      this.isPaused = false;
      this.emitState();
    } catch (error) {
      console.warn("Wiedergabe konnte nicht fortgesetzt werden:", error);
    }
  }

  async togglePause() {
    if (!this.isPlaying) {
      return;
    }
    if (this.isPaused) {
      await this.resume();
    } else {
      this.pause();
    }
  }

  seekBy(deltaSeconds) {
    if (!this.hasActiveSegment) {
      return;
    }
    const segment = this.currentSegment;
    const target = clamp(
      (this.audio.currentTime || 0) + deltaSeconds,
      segment.start,
      segment.end,
    );
    this.audio.currentTime = target;
    this.notifyProgress(segment, target);
  }

  skipSegment() {
    if (!this.currentSegment) {
      return;
    }
    if (this.currentSegment.kind === "gap") {
      this.finishSegment("skip");
      return;
    }
    this.shouldStartPaused = this.isPaused;
    this.nextRequested = true;
    this.finishSegment("skip");
  }

  async playContinuous(tracks, settings) {
    for (const track of tracks) {
      if (this.stopRequested) {
        break;
      }
      await this.playTrackSegment(track, {
        start: 0,
        end: track.duration ?? 0,
        note: "Durchgehende Wiedergabe",
      });
    }
  }

  async playWithGap(tracks, settings) {
    const pauseDuration = Math.max(0, settings.pauseSeconds ?? 0);
    for (let index = 0; index < tracks.length; index += 1) {
      if (this.stopRequested) {
        break;
      }
      const track = tracks[index];
      await this.playTrackSegment(track, {
        start: 0,
        end: track.duration ?? 0,
        note: pauseDuration > 0 ? `Pause ${pauseDuration}s danach` : "Spielt",
      });
      if (this.stopRequested) {
        break;
      }
      if (pauseDuration > 0 && index < tracks.length - 1) {
        await this.playGap(pauseDuration, `Pause ${pauseDuration}s`);
        if (this.stopRequested) {
          break;
        }
      }
    }
  }

  async playSingleLoop(tracks, settings) {
    const selectedId = settings.selectedTrackId;
    let track = tracks[0];
    if (selectedId) {
      const match = tracks.find((item) => item.id === selectedId);
      if (match) {
        track = match;
      }
    }
    if (!track) {
      throw new Error("Kein Titel für die Einzel-Wiederholung verfügbar.");
    }
    const duration = track.duration ?? 0;
    if (!duration) {
      throw new Error("Keine Spieldauer ermittelbar.");
    }
    while (!this.stopRequested) {
      await this.playTrackSegment(track, {
        start: 0,
        end: duration,
        note: "Wiederholt bis zum Stop.",
      });
      if (this.stopRequested) {
        break;
      }
    }
  }

  async playHalfFrontHalf(tracks, settings) {
    const selectedId = settings.selectedTrackId;
    let track = tracks[0];
    if (selectedId) {
      const match = tracks.find((item) => item.id === selectedId);
      if (match) {
        track = match;
      }
    }
    if (!track) {
      throw new Error("Kein Titel für den Hälfte-Modus verfügbar.");
    }
    const bufferSeconds = Math.max(0, settings.halfBufferSeconds ?? 5);
    const duration = track.duration ?? 0;
    if (!duration) {
      throw new Error("Keine Spieldauer ermittelbar.");
    }
    const halfway = duration / 2;
    const firstEnd = Math.min(duration, halfway + bufferSeconds);
    await this.playTrackSegment(track, {
      start: 0,
      end: firstEnd,
      note: `Bis Hälfte + ${bufferSeconds}s`,
    });
    if (this.stopRequested) {
      return;
    }
    await this.playTrackSegment(track, {
      start: 0,
      end: duration,
      note: "Gesamter Titel",
    });
  }

  async playChunks(tracks, settings) {
    const chunkCount = Math.max(2, Math.floor(settings.chunkCount ?? 3));
    const repeatCount = Math.max(1, Math.floor(settings.chunkRepeats ?? 1));
    const leadBuffer = Math.max(0, settings.chunkLeadBuffer ?? 5);
    const tailBuffer = Math.max(0, settings.chunkTailBuffer ?? 5);

    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
        for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
          if (this.stopRequested) {
            return;
          }
          const track = tracks[trackIndex];
          const duration = track.duration ?? 0;
          if (!duration) {
            continue;
          }
          const chunkStart = (duration / chunkCount) * chunkIndex;
          const chunkEnd =
            chunkIndex === chunkCount - 1
              ? duration
              : (duration / chunkCount) * (chunkIndex + 1);
          const start = clamp(chunkStart - leadBuffer, 0, duration);
          const end = clamp(chunkEnd + tailBuffer, 0, duration);

          await this.playTrackSegment(track, {
            start,
            end,
            note: `Stück ${chunkIndex + 1}/${chunkCount} · Wdh. ${repeatIndex + 1}/${repeatCount}`,
            chunkIndex: chunkIndex + 1,
            chunkTotal: chunkCount,
            repeatIndex: repeatIndex + 1,
            repeatTotal: repeatCount,
          });

          if (this.stopRequested) {
            return;
          }
        }
      }
    }
  }

  async playTrackSegment(track, metadata) {
    if (this.stopRequested) {
      return;
    }
    const duration = track.duration ?? 0;
    if (!duration) {
      return;
    }

    const start = clamp(metadata.start ?? 0, 0, duration);
    const end = clamp(metadata.end ?? duration, 0, duration);
    if (end <= start) {
      return;
    }

    const url = track.getObjectUrl();
    if (this.audio.src !== url) {
      this.audio.src = url;
      await this.waitForMetadata();
    } else if (this.audio.readyState < 1) {
      await this.waitForMetadata();
    }

    this.currentSegment = {
      kind: "audio",
      track,
      start,
      end,
      ...metadata,
    };
    this.nextRequested = false;

    const startPaused = this.shouldStartPaused;
    this.shouldStartPaused = false;
    this.isPaused = startPaused;
    this.emitState();
    this.notifySegmentStart(this.currentSegment);

    this.audio.currentTime = start;
    if (!startPaused) {
      try {
        await this.audio.play();
      } catch (error) {
        if (!this.stopRequested) {
          console.warn("Audio konnte nicht gestartet werden:", error);
        }
        this.currentSegment = null;
        throw error;
      }
    } else {
      this.audio.pause();
    }

    await new Promise((resolve) => {
      this.segmentResolve = resolve;
    });
  }

  async playGap(seconds, note) {
    if (seconds <= 0 || this.stopRequested) {
      return;
    }
    this.currentSegment = {
      kind: "gap",
      duration: seconds,
      note,
    };
    this.notify({
      kind: "gap",
      mode: this.mode,
      note,
    });
    await new Promise((resolve) => {
      this.segmentResolve = resolve;
      this.gapTimeout = setTimeout(() => {
        this.gapTimeout = null;
        this.finishSegment("complete");
      }, seconds * 1000);
    });
  }

  waitForMetadata() {
    return new Promise((resolve, reject) => {
      if (this.audio.readyState >= 1) {
        resolve();
        return;
      }
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Metadaten konnten nicht geladen werden."));
      };
      const cleanup = () => {
        this.audio.removeEventListener("loadedmetadata", onLoaded);
        this.audio.removeEventListener("error", onError);
      };
      this.audio.addEventListener("loadedmetadata", onLoaded);
      this.audio.addEventListener("error", onError);
      this.audio.load();
    });
  }

  handleTimeUpdate() {
    if (!this.hasActiveSegment || this.isPaused) {
      return;
    }
    const segment = this.currentSegment;
    const current = this.audio.currentTime || 0;
    if (this.nextRequested) {
      this.finishSegment("skip");
      return;
    }
    if (current >= segment.end - 0.05) {
      this.finishSegment("complete");
      return;
    }
    this.notifyProgress(segment, current);
  }

  handleAudioEnded() {
    if (this.hasActiveSegment && !this.isPaused) {
      this.finishSegment("complete");
    }
  }

  notifyProgress(segment, currentTime) {
    if (!segment || segment.kind !== "audio") {
      return;
    }
    const safeTime = clamp(currentTime ?? this.audio.currentTime ?? 0, segment.start, segment.end);
    this.notify({
      kind: "progress",
      mode: this.mode,
      trackId: segment.track.id,
      trackName: segment.track.name,
      currentTime: safeTime,
      trackDuration: segment.track.duration ?? 0,
      segmentStart: segment.start,
      segmentEnd: segment.end,
      chunkIndex: segment.chunkIndex,
      chunkTotal: segment.chunkTotal,
      repeatIndex: segment.repeatIndex,
      repeatTotal: segment.repeatTotal,
    });
  }

  notifySegmentStart(segment) {
    this.notify({
      kind: "segment",
      mode: this.mode,
      trackId: segment.track.id,
      trackName: segment.track.name,
      note: segment.note,
      segmentStart: segment.start,
      segmentEnd: segment.end,
      trackDuration: segment.track.duration ?? 0,
      chunkIndex: segment.chunkIndex,
      chunkTotal: segment.chunkTotal,
      repeatIndex: segment.repeatIndex,
      repeatTotal: segment.repeatTotal,
    });
    this.notifyProgress(segment, segment.start);
  }

  finishSegment(reason) {
    if (!this.currentSegment) {
      return;
    }
    const segment = this.currentSegment;
    if (segment.kind === "gap") {
      if (this.gapTimeout) {
        clearTimeout(this.gapTimeout);
        this.gapTimeout = null;
      }
    } else if (segment.kind === "audio") {
      if (!this.audio.paused) {
        this.audio.pause();
      }
      if (reason !== "skip") {
        const target = clamp(this.audio.currentTime || segment.end, segment.start, segment.end);
        this.audio.currentTime = target;
        this.notifyProgress(segment, segment.end);
      }
    }

    this.currentSegment = null;
    if (this.segmentResolve) {
      const resolve = this.segmentResolve;
      this.segmentResolve = null;
      resolve(reason);
    }
  }

  cleanup() {
    if (this.gapTimeout) {
      clearTimeout(this.gapTimeout);
      this.gapTimeout = null;
    }
    this.currentSegment = null;
    this.segmentResolve = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.shouldStartPaused = false;
    this.emitState();
  }
}
