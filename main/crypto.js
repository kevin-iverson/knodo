'use strict';
/**
 * API Key 本地加密存储。
 * 优先使用 Electron safeStorage（Windows 上基于 DPAPI），不可用时降级为 Base64 混淆，
 * 并在解密结果中明确标注是否处于降级状态，供 UI 提示用户。
 */
const { safeStorage } = require('electron');

const ENC_PREFIX = 'enc:';
const PLAIN_PREFIX = 'plain:';

function isEncryptionAvailable() {
  try {
    return !!(safeStorage && safeStorage.isEncryptionAvailable());
  } catch (e) {
    return false;
  }
}

/** 加密 API Key，返回带前缀的可持久化字符串 */
function encryptApiKey(plain) {
  if (!plain) return '';
  if (isEncryptionAvailable()) {
    const buf = safeStorage.encryptString(plain);
    return ENC_PREFIX + buf.toString('base64');
  }
  // 降级：仅 Base64 编码（非加密，仅避免明文落盘）
  return PLAIN_PREFIX + Buffer.from(plain, 'utf8').toString('base64');
}

/**
 * 解密 API Key。
 * @returns {{ value: string, degraded: boolean }} degraded 表示当前是否处于非加密降级状态
 */
function decryptApiKey(stored) {
  if (!stored) return { value: '', degraded: false };
  if (stored.startsWith(ENC_PREFIX)) {
    if (!isEncryptionAvailable()) {
      return { value: '', degraded: true };
    }
    try {
      const value = safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
      return { value, degraded: false };
    } catch (e) {
      return { value: '', degraded: true };
    }
  }
  if (stored.startsWith(PLAIN_PREFIX)) {
    return {
      value: Buffer.from(stored.slice(PLAIN_PREFIX.length), 'base64').toString('utf8'),
      degraded: true,
    };
  }
  return { value: '', degraded: false };
}

module.exports = { isEncryptionAvailable, encryptApiKey, decryptApiKey };
