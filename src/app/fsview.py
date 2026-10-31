# Box file browser: read-only listing/reading/search over the whole box filesystem, for the web UI.
# Runs inside the box (python3 -c), request JSON on stdin, one JSON reply on stdout.
# Kernel/virtual filesystems and known secret files (keys, tokens, vault data, env files, browser login stores) are never listed or served.
import json, os, sys, base64, re, stat, mimetypes, time

# Whole directory trees that are never browsable (virtual filesystems leak env/secrets: /proc/<pid>/environ).
DENY_TOP = ("/proc", "/sys", "/dev", "/run/secrets", "/var/run/secrets")
# Folder names hidden anywhere: credentials and keyrings.
DENY_DIRS = {".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".bitwarden", "Bitwarden CLI", ".password-store", ".raubot", ".wrangler", "gcloud", "gh", ".terraform.d", ".cloudflared", "mdata", "messenger-bridge"}
# File names hidden anywhere.
DENY_NAME = re.compile(r"(^\.env($|\.)|\.env$|^\.dev\.vars|^\.npmrc$|^\.yarnrc|^\.pypirc$|^\.netrc$|^_netrc$|^\.git-credentials$|^\.pgpass$|^\.my\.cnf$|^\.boto$|^\.s3cfg$"
    r"|^id_(rsa|dsa|ecdsa|ed25519)|^ssh_host_|\.(pem|key|p12|pfx|kdbx|keystore|jks|asc|gpg|ppk)$|^authorized_keys$|^known_hosts"
    r"|^cf-svc|^cf-env|^vault|^auth\.json$|^shadow-?$|^gshadow-?$|^sudoers$|^master\.key$"
    r"|^(Cookies|Login Data|Web Data|Local State|Login Data For Account)(-journal)?$"
    r"|_history$|^\.lesshst$|^\.viminfo$|^bridge\.db|\.sock$"
    r"|(^|[._-])(tokens?|secrets?|credentials?|passwords?|passwd|apikey|api[._-]key)([._-]|$))", re.I)
# A path segment pair that is a secret even though each name alone isn't: git config holds token remotes.
DENY_PAIR = {(".git", "config"), (".git", "FETCH_HEAD"), ("gh", "hosts.yml")}

FULL = 20 * 2**20
MAX_ENTRIES = 5000

def bad(name): return name in DENY_DIRS or bool(DENY_NAME.search(name))

def under(p, top): return p == top or p.startswith(top + "/")

def blocked(p):
    """Why p (normalized absolute) is hidden, or None."""
    if any(under(p, t) for t in DENY_TOP): return "system folder"
    parts = [x for x in p.split("/") if x]
    if any(bad(x) for x in parts): return "secret"
    for a, b in zip(parts, parts[1:]):
        if (a, b) in DENY_PAIR: return "secret"
    return None

def check(p):
    if not isinstance(p, str) or not p.startswith("/") or "\0" in p: raise PermissionError("bad path")
    norm = os.path.normpath(p)
    if norm.startswith("//"): norm = "/" + norm.lstrip("/")
    real = os.path.realpath(norm)
    if blocked(norm) or blocked(real): raise PermissionError("blocked")
    return norm, real

def entry(d, name):
    p = (d.rstrip("/") + "/" + name) if d != "/" else "/" + name
    if bad(name): return None
    try:
        _, real = check(p)
        ls = os.lstat(p)
        st = os.stat(real)
    except Exception:
        return None
    e = {"name": name, "dir": stat.S_ISDIR(st.st_mode), "size": st.st_size, "mtime": int(st.st_mtime)}
    if stat.S_ISLNK(ls.st_mode): e["link"] = True
    if not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)): e["special"] = True
    return e

def listing(p):
    p, real = check(p)
    if not os.path.isdir(real): raise NotADirectoryError("not a folder")
    out = []
    with os.scandir(real) as it:
        for de in it:
            e = entry(p, de.name)
            if e: out.append(e)
    out.sort(key=lambda x: (not x["dir"], x["name"].lower()))
    st = os.stat(real)
    return {"path": p, "mtime": int(st.st_mtime), "entries": out[:MAX_ENTRIES], "total": len(out)}

# Search skips bulky trees (they still browse fine).
SKIP = {"node_modules", ".git", "__pycache__", ".cache", ".npm"}

def find(root, q, limit=200, budget=4.0):
    root, real = check(root)
    q = q.lower()
    t0, hits, seen = time.time(), [], 0
    for d, dirs, files in os.walk(real):
        if time.time() - t0 > budget: return {"hits": hits, "partial": True, "scanned": seen}
        shown = root + d[len(real):] if d != real else root
        dirs[:] = sorted(x for x in dirs if x not in SKIP and not blocked(shown.rstrip("/") + "/" + x))
        for n in dirs + files:
            seen += 1
            if q in n.lower():
                path = shown.rstrip("/") + "/" + n
                if blocked(path): continue
                hits.append({"path": path, "dir": n in dirs})
                if len(hits) >= limit: return {"hits": hits, "partial": True, "scanned": seen}
    return {"hits": hits, "partial": False, "scanned": seen}

def main():
    a = json.load(sys.stdin); op = a.get("op")
    if op == "roots":
        home = os.path.expanduser("~")
        return {"roots": [r for r in ["/workspace", "/scratch", home, "/"] if os.path.isdir(r)], "home": home}
    if op == "lists":
        out = {}
        for p in (a.get("paths") or [])[:64]:
            try: out[p] = listing(p)
            except FileNotFoundError: out[p] = {"error": "not found", "status": 404}
            except PermissionError as e: out[p] = {"error": str(e), "status": 403}
            except Exception as e: out[p] = {"error": type(e).__name__, "status": 400}
        return {"lists": out}
    if op == "find":
        q = str(a.get("q") or "").strip()
        if len(q) < 2: raise ValueError("query too short")
        return find(a.get("path") or "/workspace", q, min(int(a.get("limit") or 200), 500))
    if op == "list": return listing(a.get("path"))
    p, real = check(a.get("path"))
    st = os.stat(real)
    if op == "stat":
        return {"path": p, "dir": stat.S_ISDIR(st.st_mode), "size": st.st_size, "mtime": int(st.st_mtime), "mime": mimetypes.guess_type(p)[0]}
    if op == "read":
        if not stat.S_ISREG(st.st_mode): raise IsADirectoryError("not a file")
        size = st.st_size
        off = max(0, int(a.get("offset") or 0))
        ln = a.get("length")
        if ln is None:
            if size > FULL: return {"error": "too big", "size": size, "status": 413}
            ln = size
        ln = max(0, min(int(ln), FULL))
        with open(real, "rb") as f:
            f.seek(off); b = f.read(ln)
        return {"path": p, "size": size, "offset": off, "mtime": int(st.st_mtime), "mime": mimetypes.guess_type(p)[0], "b64": base64.b64encode(b).decode()}
    raise ValueError("bad op")

if __name__ == "__main__":
    try: r = main()
    except PermissionError as e: r = {"error": str(e), "status": 403}
    except FileNotFoundError: r = {"error": "not found", "status": 404}
    except (NotADirectoryError, IsADirectoryError, ValueError) as e: r = {"error": str(e), "status": 400}
    except Exception as e: r = {"error": type(e).__name__, "status": 500}
    sys.stdout.write(json.dumps(r))
