// Packs addon/ into build/zotero-researcher-<version>.xpi (a zip with forward-slash paths).
// Dependency-free: uses zlib's raw deflate and a small ZIP writer.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const src = join(root, "addon");
const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
// ZR_BUILD_VERSION builds an otherwise identical XPI with another version (update tests)
if (process.env.ZR_BUILD_VERSION) manifest.version = process.env.ZR_BUILD_VERSION;

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const files = walk(src).sort();
const locals = [];
const centrals = [];
let offset = 0;
const { time, date } = dosTime(new Date());

for (const file of files) {
  const name = Buffer.from(relative(src, file).split(sep).join("/"), "utf8");
  let data = file === join(src, "manifest.json") ? Buffer.from(JSON.stringify(manifest, null, 2) + "\n") : readFileSync(file);
  // Version-stamp resource URLs (?v=__ZR_VERSION__) so an update bypasses Zotero's
  // stylesheet/script caches instead of mixing new markup with old CSS.
  if (file.endsWith(".xhtml")) data = Buffer.from(data.toString("utf8").replaceAll("__ZR_VERSION__", manifest.version));
  const deflated = deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(useDeflate ? 8 : 0, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, name, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(useDeflate ? 8 : 0, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);

  offset += local.length + name.length + body.length;
}

const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(join(root, "build"), { recursive: true });
const out = join(root, "build", `zotero-researcher-${manifest.version}.xpi`);
writeFileSync(out, Buffer.concat([...locals, ...centrals, end]));
console.log(`Wrote ${relative(root, out)} (${files.length} files, ${(offset + centralSize + 22) >> 10} KiB)`);
