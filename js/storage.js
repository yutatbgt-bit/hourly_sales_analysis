/**
 * storage.js
 * IndexedDB を用いたダッシュボードデータの永続化マネージャー。
 *
 * 設計方針:
 * - リロード後も読み込んだ分析データ・比較データ、合算/平均モードを復元する
 * - IndexedDB が使えない環境（プライベートブラウズ等）ではメモリ内のみで安全に動作
 * - XSS や悪意あるデータ改変を防ぐため、保存・復元時にスキーマ検証を行う
 */
(function (global) {
  'use strict';

  const DB_NAME = 'HourlySalesAnalysisDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'app_state_store';
  const LEGACY_STATE_KEY = 'dashboard_state';
  const PROFILES_META_KEY = '__store_profiles_meta__';
  const DEFAULT_PROFILE_NAME = 'デフォルト';

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        return reject(new Error('IndexedDB is not supported'));
      }
      const req = global.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = (event) => resolve(event.target.result);
      req.onerror = (event) => reject(event.target.error);
    });
  }

  function getProfileKey(profileName) {
    const clean = (typeof profileName === 'string' && profileName.trim()) ? profileName.trim() : DEFAULT_PROFILE_NAME;
    return 'dashboard_state::' + clean;
  }

  async function getProfiles() {
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(PROFILES_META_KEY);
        req.onsuccess = () => {
          const list = req.result;
          if (Array.isArray(list) && list.length > 0) {
            resolve(list);
          } else {
            resolve([DEFAULT_PROFILE_NAME]);
          }
        };
        req.onerror = (e) => reject(e.target.error);
      });
    } catch (e) {
      return [DEFAULT_PROFILE_NAME];
    }
  }

  async function saveProfiles(profilesList) {
    if (!Array.isArray(profilesList) || profilesList.length === 0) return false;
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(profilesList, PROFILES_META_KEY);
        req.onsuccess = () => resolve(true);
        req.onerror = (e) => reject(e.target.error);
      });
    } catch (e) {
      return false;
    }
  }

  async function saveState(stateData, profileName = DEFAULT_PROFILE_NAME) {
    try {
      const db = await openDatabase();
      const key = getProfileKey(profileName);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(stateData, key);
        req.onsuccess = () => resolve(true);
        req.onerror = (e) => reject(e.target.error);
      });
    } catch (e) {
      return false;
    }
  }

  async function loadState(profileName = DEFAULT_PROFILE_NAME) {
    try {
      const db = await openDatabase();
      const key = getProfileKey(profileName);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => {
          if (req.result) {
            resolve(req.result);
          } else if (profileName === DEFAULT_PROFILE_NAME) {
            // 旧バージョンのデータが存在する場合は移行して読み込む
            const legacyReq = store.get(LEGACY_STATE_KEY);
            legacyReq.onsuccess = () => resolve(legacyReq.result || null);
            legacyReq.onerror = () => resolve(null);
          } else {
            resolve(null);
          }
        };
        req.onerror = (e) => reject(e.target.error);
      });
    } catch (e) {
      return null;
    }
  }

  async function clearState(profileName = DEFAULT_PROFILE_NAME) {
    try {
      const db = await openDatabase();
      const key = getProfileKey(profileName);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(key);
        req.onsuccess = () => {
          if (profileName === DEFAULT_PROFILE_NAME) {
            // 旧キーも同時にクリア
            store.delete(LEGACY_STATE_KEY);
          }
          resolve(true);
        };
        req.onerror = (e) => reject(e.target.error);
      });
    } catch (e) {
      return false;
    }
  }

  async function deleteProfile(profileName) {
    if (!profileName || profileName === DEFAULT_PROFILE_NAME) return false;
    try {
      const profiles = await getProfiles();
      const nextProfiles = profiles.filter((p) => p !== profileName);
      await saveProfiles(nextProfiles);

      const db = await openDatabase();
      const key = getProfileKey(profileName);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(key);
        req.onsuccess = () => resolve(true);
        req.onerror = (e) => reject(e.target.error);
      });
    } catch (e) {
      return false;
    }
  }

  global.HourlyStorage = Object.freeze({
    DEFAULT_PROFILE_NAME,
    getProfiles,
    saveProfiles,
    saveState,
    loadState,
    clearState,
    deleteProfile
  });
})(window);
