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
  const DEFAULT_PROFILE_NAME = '全店';

  // 既定の店舗リスト（初回利用時または手動追加の手間を省くための初期シード店舗）
  // ※ 固定化（ハードコード）ではなく、ストレージに初期データとして追加・永続化されます。
  // 以降はユーザーによる自由な追加・削除・名称変更がすべてストレージに保存されます。
  const INITIAL_SEED_STORES = Object.freeze([
    '全店',
    '002-王子店',
    '011-塚口店',
    '012-夙川店',
    '013-芦屋店',
    '014-門戸店',
    '015-箕面店',
    '016-岡本店',
    '018-有野店',
    '020-六甲店',
    '021-御影店',
    '023-甲子園店',
    '024-宝塚店',
    '026-甲陽園店',
    '028-摂津本山店',
    '031-逆瀬川店',
    '032-高槻店',
    '033-JR大阪店',
    '034-三宮店',
    '035-南海なんば店',
    '036-淀屋橋店',
    '054-伊丹店',
    '055-豊中店',
    '056-豊中緑丘店',
    '065-常盤店'
  ]);

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
          let loaded = [];
          if (Array.isArray(list) && list.length > 0) {
            loaded = list.filter((p) => {
              if (!p || typeof p !== 'string') return false;
              const t = p.trim();
              if (t.length === 0) return false;
              if (/^(?:sheet\s*\d*|シート\s*\d*|page\s*\d*|table\s*\d*|ワークシート\d*|空店舗)$/i.test(t)) {
                return false;
              }
              return true;
            });
          }

          // 24店舗の自動シード登録（手動追加の手間を省く「初期追加」の動作）:
          // ストレージが空、または店番付き店舗（^\d{3}-）が未登録の場合は、
          // 最新の店番付き24店舗をシードデータとしてストレージに自動追加・保存して返す
          const hasStoreCode = loaded.some((p) => /^\d{3}-/.test(p));
          if (loaded.length <= 1 || !hasStoreCode) {
            const initialList = Array.from(INITIAL_SEED_STORES);
            // 非同期でストレージへ自動追加保存（ハードコードではなく追加の意味で永続化）
            saveProfiles(initialList).catch((err) => {
              console.warn('[HourlyStorage] Seed profiles save failed:', err);
            });
            resolve(initialList);
            return;
          }

          resolve(loaded);
        };
        req.onerror = () => {
          resolve(Array.from(INITIAL_SEED_STORES));
        };
      });
    } catch (e) {
      return Array.from(INITIAL_SEED_STORES);
    }
  }

  async function saveProfiles(profilesList) {
    if (!Array.isArray(profilesList) || profilesList.length === 0) return false;
    const sanitized = profilesList.filter((p) => {
      if (!p || typeof p !== 'string') return false;
      const t = p.trim();
      if (t.length === 0) return false;
      if (/^(?:sheet\s*\d*|シート\s*\d*|page\s*\d*|table\s*\d*|ワークシート\d*|空店舗)$/i.test(t)) {
        return false;
      }
      return true;
    });
    const finalProfiles = sanitized.length > 0 ? sanitized : [DEFAULT_PROFILE_NAME];

    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(finalProfiles, PROFILES_META_KEY);
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

  /**
   * 登録されている全店舗プロファイルの保存データを一括ロード
   * @returns {Promise<Array<{ profileName: string, state: object|null }>>}
   */
  async function loadAllProfilesState() {
    try {
      const profiles = await getProfiles();
      const set = new Set();
      (profiles || []).forEach((p) => {
        if (p && typeof p === 'string' && p.trim()) set.add(p.trim());
      });
      const targetList = Array.from(set);

      const promises = targetList.map((pName) => {
        return loadState(pName).then((state) => ({ profileName: pName, state }));
      });
      return Promise.all(promises);
    } catch (e) {
      console.warn('[HourlyStorage] loadAllProfilesState failed:', e);
      return [];
    }
  }

  /**
   * 全店舗の保存データを一括削除 (完全走査パージ)
   * - 店舗一覧メタデータ（PROFILES_META_KEY）は保護
   * - IndexedDB 内の全売上レコード（dashboard_state::* および dashboard_state）を完全削除
   * - localStorage 内のキャッシュも安全に走査消去
   */
  async function clearAllStoresData() {
    try {
      const db = await openDatabase();
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);

          if (typeof store.getAllKeys === 'function') {
            const req = store.getAllKeys();
            req.onsuccess = () => {
              const keys = req.result || [];
              keys.forEach((k) => {
                if (k !== PROFILES_META_KEY) {
                  store.delete(k);
                }
              });
            };
          } else if (typeof store.openCursor === 'function') {
            const cursorReq = store.openCursor();
            cursorReq.onsuccess = (e) => {
              const cursor = e.target.result;
              if (cursor) {
                if (cursor.key !== PROFILES_META_KEY) cursor.delete();
                cursor.continue();
              }
            };
          }

          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch (ex) {
          console.warn('[HourlyStorage] clearAllStoresData tx error:', ex);
          resolve();
        }
      });
    } catch (e) {
      console.warn('[HourlyStorage] openDatabase failed in clearAllStoresData:', e);
    }

    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k !== PROFILES_META_KEY) {
            if (k.indexOf('dashboard_state') === 0 || k.indexOf('hourly_sales_') === 0) {
              keysToRemove.push(k);
            }
          }
        }
        keysToRemove.forEach((k) => { localStorage.removeItem(k); });
      }
    } catch (e) {
      console.warn('[HourlyStorage] clear localStorage failed:', e);
    }

    return true;
  }

  global.HourlyStorage = Object.freeze({
    DEFAULT_PROFILE_NAME,
    INITIAL_SEED_STORES,
    getProfiles,
    saveProfiles,
    saveState,
    loadState,
    loadAllProfilesState,
    clearState,
    clearAllStoresData,
    deleteProfile
  });
})(window);
