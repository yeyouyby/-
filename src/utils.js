import crypto from "node:crypto";

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

export function randomRoomCode(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return result;
}

export function sanitizeName(name) {
  const normalized = String(name ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return normalized.slice(0, 16) || "无名战士";
}

export function sample(array, count) {
  const source = [...array];
  const selected = [];
  while (source.length > 0 && selected.length < count) {
    const index = Math.floor(Math.random() * source.length);
    selected.push(source.splice(index, 1)[0]);
  }
  return selected;
}
