// read / edit / write for codemode, run in the box. Same semantics as pi's built-in tools (pi-durable), plus line numbers and images.
import { applyEditsToNormalizedContent, detectLineEnding, generateDiffString, normalizeToLF, restoreLineEndings, stripBom } from "../../node_modules/@earendil-works/pi-durable/dist/tools/edit-diff.js";
import { truncateHead } from "../../node_modules/@earendil-works/pi-durable/dist/truncate.js";

/** Runs a shell command in the box with stdin; stdout and stderr apart. */
export type Exec = (cmd: string, stdin: string, seconds: number) => Promise<{ out: string; err: string; exitCode: number }>;
export type Put = (path: string, bytes: Uint8Array) => Promise<void>;

export const MAX_LINES = 2000;
/** Bytes of file text per read: under the 30 KB tool result clip, with room for line numbers. */
export const MAX_BYTES = 24 * 1024;
const MAX_FILE = 20 << 20;

const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export const abs = (p: string) => (p.startsWith("/") ? p : p.startsWith("~/") ? "/root/" + p.slice(2) : "/workspace/" + p.replace(/^\.\//, ""));

const b64decode = (s: string) => Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0));

// Prints "<kind> <mime> <size> [WxH]" then the base64 body. Images over 2000px or 4 MB are shrunk to JPEG first.
const READ = `set -e
[ -e "$F" ] || { echo "ENOENT" >&2; exit 2; }
[ -d "$F" ] && { echo "EISDIR" >&2; exit 3; }
sz=$(stat -c %s "$F"); m=$(file -b --mime-type "$F")
case "$m" in image/png|image/jpeg|image/gif|image/webp)
  d=$(identify -format '%w %h' "$F[0]" 2>/dev/null || echo "0 0"); set -- $d
  if [ "$sz" -gt 4000000 ] || [ "\${1:-0}" -gt 2000 ] || [ "\${2:-0}" -gt 2000 ]; then
    t=$(mktemp --suffix=.jpg); convert "$F[0]" -resize '2000x2000>' -quality 85 "$t"; echo "image image/jpeg $sz \${1}x\${2}"; base64 -w0 "$t"; rm -f "$t"
  else echo "image $m $sz \${1}x\${2}"; base64 -w0 "$F"; fi;;
*) [ "$sz" -gt ${MAX_FILE} ] && { echo "EBIG $sz" >&2; exit 4; }; echo "text $m $sz"; base64 -w0 "$F";;
esac`;

async function load(exec: Exec, path: string) {
	const r = await exec("F=" + q(path) + "; " + READ, "", 60);
	if (r.exitCode) {
		const e = r.err.trim();
		if (e.startsWith("ENOENT")) throw new Error("File not found: " + path);
		if (e.startsWith("EISDIR")) throw new Error(path + " is a directory. Use tools.bash({ command: \"ls " + path + "\" }).");
		if (e.startsWith("EBIG")) throw new Error(path + " is " + e.split(" ")[1] + " bytes, too big to read. Use bash (head, grep, sed -n) on it.");
		throw new Error("read " + path + ": " + (e || r.out).slice(0, 500));
	}
	const nl = r.out.indexOf("\n");
	const [kind, mime, size, dims] = r.out.slice(0, nl).split(" ");
	return { kind, mime, size: Number(size), dims, b64: r.out.slice(nl + 1) };
}

export type ImageBlock = { type: "image"; mimeType: string; data: string; image_url: string; path: string; size: number; dims?: string };

/** Text comes back as "N\tline" rows, with a hint when there is more; images as an image block (data URL in image_url, for image()). */
export async function read(exec: Exec, { path, offset, limit }: { path: string; offset?: number; limit?: number }): Promise<string | ImageBlock> {
	const p = abs(path);
	const f = await load(exec, p);
	if (f.kind === "image") return { type: "image", mimeType: f.mime, data: f.b64, image_url: "data:" + f.mime + ";base64," + f.b64, path: p, size: f.size, dims: f.dims };
	const bytes = b64decode(f.b64);
	if (bytes.includes(0)) throw new Error(path + " looks binary (" + f.mime + ", " + f.size + " bytes). Use bash (xxd, file, strings) on it.");
	const all = new TextDecoder().decode(bytes).split("\n");
	if (all.length > 1 && all[all.length - 1] === "") all.pop();
	const total = all.length;
	const start = offset ? Math.max(0, Math.floor(offset) - 1) : 0;
	if (start >= total && start > 0) throw new Error("Offset " + offset + " is beyond end of file (" + total + " lines total)");
	const end = limit !== undefined ? Math.min(start + Math.max(1, Math.floor(limit)), total) : total;
	const t = truncateHead(all.slice(start, end).join("\n"), { maxLines: MAX_LINES, maxBytes: MAX_BYTES });
	const w = String(end).length;
	const num = (lines: string[]) => lines.map((l, i) => String(start + 1 + i).padStart(w, " ") + "\t" + l).join("\n");
	if (t.firstLineExceedsLimit) {
		const line = all[start], n = MAX_BYTES / 2;
		return num([line.slice(0, n)]) + "\n\n[Line " + (start + 1) + " is " + line.length + " chars; showing the first " + n + ". Use bash: sed -n '" + (start + 1) + "p' " + p + " | cut -c" + (n + 1) + "-]";
	}
	let out = num(t.content.split("\n"));
	if (t.truncated) {
		const last = start + t.outputLines;
		out += "\n\n[Showing lines " + (start + 1) + "-" + last + " of " + total + (t.truncatedBy === "bytes" ? " (" + MAX_BYTES / 1024 + "KB limit)" : "") + ". Use offset=" + (last + 1) + " to continue.]";
	} else if (end < total) out += "\n\n[" + (total - end) + " more lines in file. Use offset=" + (end + 1) + " to continue.]";
	return out;
}

/** Creates parent directories; overwrites. */
export async function write(put: Put, { path, content }: { path: string; content: string }) {
	if (typeof content !== "string") throw new Error("write needs content as a string");
	const bytes = new TextEncoder().encode(content);
	await put(abs(path), bytes);
	return "Wrote " + bytes.length + " bytes to " + abs(path);
}

type Edit = { oldText: string; newText: string };
/** Repairs the shapes models often send: edits as a JSON string or one object, or top-level oldText/newText. */
const editsOf = (a: { edits?: unknown; oldText?: string; newText?: string }): Edit[] => {
	let e = a.edits;
	if (typeof e === "string") try { e = JSON.parse(e); } catch {}
	const list: Edit[] = Array.isArray(e) ? [...e] : e && typeof e === "object" ? [e as Edit] : [];
	if (typeof a.oldText === "string" && typeof a.newText === "string") list.push({ oldText: a.oldText, newText: a.newText });
	if (!list.length) throw new Error("edit needs edits: [{ oldText, newText }] with at least one replacement.");
	return list;
};

/** Exact-text replacements, each matched against the original file and unique in it. Returns a line-numbered diff. */
export async function edit(exec: Exec, put: Put, args: { path: string; edits?: unknown; oldText?: string; newText?: string }) {
	const p = abs(args.path);
	const edits = editsOf(args);
	const f = await load(exec, p);
	if (f.kind !== "text") throw new Error(args.path + " is not a text file");
	const raw = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false }).decode(b64decode(f.b64));
	const { bom, text } = stripBom(raw);
	const ending = detectLineEnding(text);
	const { baseContent, newContent } = applyEditsToNormalizedContent(normalizeToLF(text), edits, args.path);
	await put(p, new TextEncoder().encode(bom + restoreLineEndings(newContent, ending)));
	const { diff } = generateDiffString(baseContent, newContent);
	const d = diff.length > 20_000 ? diff.slice(0, 20_000) + "\n… (diff cut; read the file to see the rest)" : diff;
	return "Edited " + p + " (" + edits.length + " replacement" + (edits.length > 1 ? "s" : "") + ")\n" + d;
}
