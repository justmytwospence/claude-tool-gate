// The few `node:path` and `node:os` helpers the shared bash and directory code needs, POSIX only:
// a Claude Code mod has no Node built-ins. `setEnv` gives it the session's home and temp directory.
let HOME = "/"
let TMP = "/tmp"

export function setEnv(env: { home?: string; tmpdir?: string }): void {
  if (env.home) HOME = normalize(env.home)
  if (env.tmpdir) TMP = normalize(env.tmpdir)
}

export function homedir(): string {
  return HOME
}

export function tmpdir(): string {
  return TMP
}

/** macOS's /var, /tmp and /etc are links into /private: both spellings name the same place. */
export function realpathSync(file: string): string {
  return /^\/(var|tmp|etc)(\/|$)/u.test(file) ? `/private${file}` : file
}

function normalize(p: string): string {
  const absolute = p.startsWith("/")
  const out: string[] = []
  for (const part of p.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop()
      else if (!absolute) out.push("..")
      continue
    }
    out.push(part)
  }
  const joined = out.join("/")
  return absolute ? `/${joined}` : joined || "."
}

const path = {
  sep: "/",
  resolve(...parts: string[]): string {
    let p = ""
    for (const part of parts) {
      if (!part) continue
      p = part.startsWith("/") ? part : p ? `${p}/${part}` : part
    }
    if (!p.startsWith("/")) p = `${HOME}/${p}`
    return normalize(p)
  },
  join(...parts: string[]): string {
    return normalize(parts.filter(Boolean).join("/"))
  },
  dirname(p: string): string {
    const n = normalize(p)
    const i = n.lastIndexOf("/")
    return i <= 0 ? (n.startsWith("/") ? "/" : ".") : n.slice(0, i)
  },
  basename(p: string): string {
    const n = p.replace(/\/+$/u, "")
    return n.slice(n.lastIndexOf("/") + 1)
  },
}

export default path
