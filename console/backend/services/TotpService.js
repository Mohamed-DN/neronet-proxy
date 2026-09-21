const crypto = require('crypto');
const QRCode = require('qrcode');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode Buffer to RFC 4648 Base32 string (no padding)
 */
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Decode RFC 4648 Base32 string to Buffer
 */
function base32Decode(base32Str) {
  const cleaned = base32Str.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${cleaned[i]}`);
    }

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

class TotpService {
  /**
   * Generate random Base32 secret for TOTP (default 20 bytes = 160 bits)
   */
  static generateSecret(byteLength = 20) {
    const randomBytes = crypto.randomBytes(byteLength);
    return base32Encode(randomBytes);
  }

  /**
   * Generate RFC 6238 TOTP code
   */
  static generateTotp(secret, { timeStep = 30, time = Date.now(), digits = 6, algorithm = 'sha1' } = {}) {
    const key = base32Decode(secret);
    const counter = Math.floor(time / 1000 / timeStep);

    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));

    const hmac = crypto.createHmac(algorithm, key).update(counterBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;

    const binary =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);

    const otp = binary % 10 ** digits;
    return String(otp).padStart(digits, '0');
  }

  /**
   * Verify TOTP code with time drift window (default +/- 1 step = +/- 30s)
   */
  static verifyTotp(token, secret, { window = 1, timeStep = 30, time = Date.now(), digits = 6 } = {}) {
    if (!token || !secret) return false;
    const cleanToken = String(token).trim();
    if (cleanToken.length !== digits) return false;

    const key = base32Decode(secret);
    const currentCounter = Math.floor(time / 1000 / timeStep);

    for (let i = -window; i <= window; i++) {
      const counter = currentCounter + i;
      const counterBuffer = Buffer.alloc(8);
      counterBuffer.writeBigUInt64BE(BigInt(counter));

      const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
      const offset = hmac[hmac.length - 1] & 0x0f;

      const binary =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);

      const otp = String(binary % 10 ** digits).padStart(digits, '0');

      if (crypto.timingSafeEqual(Buffer.from(cleanToken), Buffer.from(otp))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Generate otpauth:// URI and QR code data URL
   */
  static async generateQrCode(username, secret, issuer = 'NeroNet') {
    const encodedIssuer = encodeURIComponent(issuer);
    const encodedUser = encodeURIComponent(username);
    const otpauthUri = `otpauth://totp/${encodedIssuer}:${encodedUser}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;

    const qrDataUrl = await QRCode.toDataURL(otpauthUri, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 256
    });

    return {
      otpauthUri,
      qrDataUrl
    };
  }

  /**
   * Generate a set of single-use alphanumeric recovery codes
   */
  static generateRecoveryCodes(count = 8) {
    const codes = [];
    for (let i = 0; i < count; i++) {
      const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 chars, e.g. 'A1B2C3D4E5'
      codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
    }
    return codes;
  }

  /**
   * SHA-256 hash of a recovery code
   */
  static hashRecoveryCode(code) {
    const clean = String(code).trim().replace(/[-\s]/g, '').toUpperCase();
    return crypto.createHash('sha256').update(clean).digest('hex');
  }

  /**
   * Verify and consume a recovery code from an array of hashed recovery codes
   */
  static verifyAndConsumeRecoveryCode(providedCode, hashedCodes = []) {
    if (!providedCode || !Array.isArray(hashedCodes) || hashedCodes.length === 0) {
      return { valid: false, remainingCodes: hashedCodes };
    }

    const targetHash = TotpService.hashRecoveryCode(providedCode);
    const index = hashedCodes.findIndex((h) => h === targetHash);

    if (index === -1) {
      return { valid: false, remainingCodes: hashedCodes };
    }

    const remainingCodes = [...hashedCodes];
    remainingCodes.splice(index, 1);
    return { valid: true, remainingCodes };
  }
}

module.exports = TotpService;
