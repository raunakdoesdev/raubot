# Streams a block device and counts hits for needles read (hex, one per line) from a file. Writes {bytes, hits: {needle index: count}, offsets: {needle index: [first 8 byte offsets]}} as JSON.
# Used by leaktest.mts for the raw-disk scan; grep can't do this, since a disk has few newlines and grep holds a whole "line" in memory.
import json, os, sys
dev, pat, out = sys.argv[1:4]
needles = [bytes.fromhex(l) for l in open(pat).read().split()]
tail, hits, offsets, size, n = b"", {}, {}, 0, max(map(len, needles))
with open(dev, "rb", buffering=0) as f:
    while chunk := f.read(16 << 20):
        hay = tail + chunk
        for i, b in enumerate(needles):
            at = hay.find(b)
            while at >= 0:
                if at + len(b) > len(tail):
                    hits[i] = hits.get(i, 0) + 1
                    if len(offsets.setdefault(i, [])) < 8:
                        offsets[i].append(size + at - len(tail))
                at = hay.find(b, at + 1)
        tail = hay[-(n - 1):] if n > 1 else b""
        size += len(chunk)
json.dump({"bytes": size, "hits": hits, "offsets": offsets}, open(out, "w"))
