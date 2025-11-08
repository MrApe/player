const DB_NAME = "aerobic-player";
const DB_VERSION = 1;
const TRACK_STORE = "tracks";
const SETTINGS_STORE = "settings";
const SETTINGS_KEY = "playerSettings";

let dbPromise;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(TRACK_STORE)) {
        const trackStore = db.createObjectStore(TRACK_STORE, { keyPath: "id" });
        trackStore.createIndex("order", "order", { unique: false });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getDB() {
  if (!dbPromise) {
    dbPromise = openDatabase();
  }
  return dbPromise;
}

function waitForTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
    tx.onerror = () => reject(tx.error);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllTrackRecords() {
  const db = await getDB();
  const tx = db.transaction(TRACK_STORE, "readonly");
  const store = tx.objectStore(TRACK_STORE);
  const records = await requestToPromise(store.getAll());
  await waitForTransaction(tx);
  if (!records) {
    return [];
  }
  return [...records].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export async function saveTrackRecord(record) {
  const db = await getDB();
  const tx = db.transaction(TRACK_STORE, "readwrite");
  tx.objectStore(TRACK_STORE).put(record);
  await waitForTransaction(tx);
}

export async function deleteTrackRecord(id) {
  const db = await getDB();
  const tx = db.transaction(TRACK_STORE, "readwrite");
  tx.objectStore(TRACK_STORE).delete(id);
  await waitForTransaction(tx);
}

export async function persistTrackOrder(records) {
  const db = await getDB();
  const tx = db.transaction(TRACK_STORE, "readwrite");
  const store = tx.objectStore(TRACK_STORE);
  records.forEach((record) => {
    store.put(record);
  });
  await waitForTransaction(tx);
}

export async function saveSettings(settings) {
  const db = await getDB();
  const tx = db.transaction(SETTINGS_STORE, "readwrite");
  tx.objectStore(SETTINGS_STORE).put({ key: SETTINGS_KEY, value: settings });
  await waitForTransaction(tx);
}

export async function loadSettings() {
  const db = await getDB();
  const tx = db.transaction(SETTINGS_STORE, "readonly");
  const request = tx.objectStore(SETTINGS_STORE).get(SETTINGS_KEY);
  const record = await requestToPromise(request);
  await waitForTransaction(tx);
  return record ? record.value : null;
}
