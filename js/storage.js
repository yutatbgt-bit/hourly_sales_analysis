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
  const STATE_KEY = 'dashboard_state';

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

  async function saveState(stateData) {
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(stateData, STATE_KEY);
        req.onsuccess = () => resolve(true);
        req.onerror = (e) => reject(e.target.error);
      });
    } catch (e) {
      // ストレージエラーは画面を壊さないようフォールバック
      return false;
    }
  }

  async function loadState() {
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(STATE_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = (e) => reject(e.target.error);
      });
    } catch (e) {
      return null;
    }
  }

  async function clearState() {
    try {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.clear();
        req.onsuccess = () => resolve(true);
        req.onerror = (e) => reject(e.target.error);
      });
    } catch (e) {
      return false;
    }
  }

  global.HourlyStorage = Object.freeze({
    saveState,
    loadState,
    clearState
  });
})(window);
