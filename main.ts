// mend -- apply an AI-written edit to a tree of text files.
//
// The edit arrives in one of four formats: a unified diff, a set of
// SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls written as
// JSON. mend reads the whole patch first, applies every edit in order to an
// in-memory copy of the tree, and writes the result only when no edit
// failed: every file is changed, or nothing is.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// PATCH is a patch file relative to the working directory; without it (or
// with "-") the patch is read from standard input.

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------- errors

// A parse fault carries the 1-based patch line the format blames.
function ParseFault(line) {
  this.line = line;
}

// ------------------------------------------------------------ text model

// Split a patch into its lines: split at "\n", drop the empty piece after a
// final "\n", and remove one trailing "\r" from each line.
function patchLines(text) {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map(function (s) {
    return s.endsWith("\r") ? s.slice(0, -1) : s;
  });
}

// A blank line is empty or only whitespace.
function isBlank(s) {
  return s.trim() === "";
}

// A file's own line model: its break (CRLF when its first line feed follows
// a carriage return, else LF), its lines split at that break, and whether
// its text ends with the break.
function splitContent(content) {
  if (content === "") return { lines: [], brk: "\n", ends: false };
  const nl = content.indexOf("\n");
  const brk = nl > 0 && content[nl - 1] === "\r" ? "\r\n" : "\n";
  const parts = content.split(brk);
  const ends = content.endsWith(brk);
  if (ends) parts.pop();
  return { lines: parts, brk: brk, ends: ends };
}

function joinContent(lines, brk, ends) {
  if (lines.length === 0) return "";
  return lines.join(brk) + (ends ? brk : "");
}

// ------------------------------------------------------------ path safety

function isSafePath(p) {
  if (p === "" || p.startsWith("/") || p.indexOf("\\") !== -1) return false;
  const segs = p.split("/");
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === "" || segs[i] === "." || segs[i] === "..") return false;
  }
  return true;
}

// ------------------------------------------------------- line matching

function stripTrail(s) {
  return s.replace(/[ \t]+$/, "");
}
function stripBoth(s) {
  return s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}
function leadingWS(s) {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}

function lineEqAt(a, b, tier) {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

// Find O in file lines F: the first tier with at least one occurrence, and
// every occurrence position at that tier. Returns null when O occurs at no
// tier. O must hold at least one line.
function findOccurrences(F, O, strict) {
  const tiers = strict ? [0] : [0, 1, 2];
  for (let t = 0; t < tiers.length; t++) {
    const tier = tiers[t];
    const positions = [];
    for (let i = 0; i + O.length <= F.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (!lineEqAt(F[i + j], O[j], tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier: tier, positions: positions };
  }
  return null;
}

// Build the lines that replace a match. entries describes N in order: a
// "ctx" entry takes the file's own matched line, an "add" entry takes the
// patch's text, re-indented at tier 2.
function buildReplacement(F, pos, O, entries, tier) {
  const out = [];
  let fLead = "";
  let pLead = "";
  if (tier === 2) {
    fLead = leadingWS(F[pos]);
    pLead = leadingWS(O[0]);
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind === "ctx") {
      out.push(F[pos + e.oIdx]);
    } else {
      let text = e.text;
      if (tier === 2 && text !== "" && !/^[ \t]+$/.test(text) && text.startsWith(pLead)) {
        text = fLead + text.slice(pLead.length);
      }
      out.push(text);
    }
  }
  return out;
}

// Turn body lines (unified or V4A) into O (old lines) and N (entries).
// body items are {kind: "ctx"|"del"|"add"|"bs", text}.
function bodyToON(body) {
  const O = [];
  const entries = [];
  for (let i = 0; i < body.length; i++) {
    const b = body[i];
    if (b.kind === "ctx") {
      O.push(b.text);
      entries.push({ kind: "ctx", oIdx: O.length - 1 });
    } else if (b.kind === "del") {
      O.push(b.text);
    } else if (b.kind === "add") {
      entries.push({ kind: "add", text: b.text });
    }
  }
  return { O: O, entries: entries };
}

// Whether a "\" line follows the body's last context or "+" line.
function backslashAfterLast(body) {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i].kind === "ctx" || body[i].kind === "add") {
      return i + 1 < body.length && body[i + 1].kind === "bs";
    }
  }
  return false;
}

// ------------------------------------------------------------ invocation

function parseArgs(argv) {
  let format = "auto";
  let formatSeen = false;
  let check = false;
  let strict = false;
  let patchArg = null;
  let positional = 0;
  let afterDashDash = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!afterDashDash && a === "--") {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && a.startsWith("-") && a !== "-") {
      if (a === "--check") {
        if (check) return null;
        check = true;
      } else if (a === "--strict") {
        if (strict) return null;
        strict = true;
      } else if (a.startsWith("--format=")) {
        if (formatSeen) return null;
        formatSeen = true;
        const v = a.slice("--format=".length);
        if (["unified", "search-replace", "v4a", "json", "auto"].indexOf(v) === -1) return null;
        format = v;
      } else {
        return null;
      }
    } else {
      positional++;
      if (positional > 1) return null;
      patchArg = a;
    }
  }
  return { format: format, check: check, strict: strict, patchArg: patchArg };
}

// ------------------------------------------------------- format detection

function detectFormat(lines) {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank !== -1) {
    if (lines[firstNonBlank].trim() === "*** Begin Patch") return "v4a";
    const m = /\S/.exec(lines[firstNonBlank]);
    if (m && (m[0] === "[" || m[0] === "{")) return "json";
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/\s+$/, "") === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) return "unified";
    if (lines[i].startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
      return "unified";
    }
  }
  return null;
}

// ============================================================ UNIFIED

function parseUnified(lines) {
  const sections = [];
  let cur = null;

  function newSection() {
    const s = {
      gitOld: undefined,
      gitNew: undefined,
      minusPath: undefined, // null means /dev/null
      plusPath: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  }
  function inHeader() {
    return cur !== null && cur.hunks.length === 0;
  }
  function headerPath(text) {
    let p = text.slice(4);
    const tab = p.indexOf("\t");
    if (tab !== -1) p = p.slice(0, tab);
    p = p.replace(/^ +/, "").replace(/ +$/, "");
    if (p === "/dev/null") return null;
    if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
    return p;
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new ParseFault(i + 1);
      cur = newSection();
      cur.gitOld = m[1];
      cur.gitNew = m[2];
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      if (cur === null) throw new ParseFault(i + 1);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hm) throw new ParseFault(i + 1);
      const hunk = { a: parseInt(hm[1], 10), body: [] };
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (l.startsWith("diff --git ")) break;
        if (l.startsWith("--- ") && j + 1 < lines.length && lines[j + 1].startsWith("+++ ")) break;
        if (l === "") hunk.body.push({ kind: "ctx", text: "", fromEmpty: true });
        else if (l[0] === " ") hunk.body.push({ kind: "ctx", text: l.slice(1) });
        else if (l[0] === "-") hunk.body.push({ kind: "del", text: l.slice(1) });
        else if (l[0] === "+") hunk.body.push({ kind: "add", text: l.slice(1) });
        else if (l[0] === "\\") hunk.body.push({ kind: "bs", text: l.slice(1) });
        else break;
        j++;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1];
        if (last.kind === "ctx" && last.text === "" && last.fromEmpty) {
          hunk.body.pop();
        } else break;
      }
      cur.hunks.push(hunk);
      i = j;
      continue;
    }
    if (line.startsWith("--- ")) {
      const followed = i + 1 < lines.length && lines[i + 1].startsWith("+++ ");
      if (followed) {
        if (inHeader() && cur.minusPath === undefined) {
          cur.minusPath = headerPath(line);
          cur.plusPath = headerPath(lines[i + 1]);
        } else {
          cur = newSection();
          cur.minusPath = headerPath(line);
          cur.plusPath = headerPath(lines[i + 1]);
        }
        i += 2;
        continue;
      }
      if (inHeader()) throw new ParseFault(i + 2);
      i++;
      continue;
    }
    if (inHeader()) {
      if (line.startsWith("rename from ")) cur.renameFrom = line.slice("rename from ".length);
      else if (line.startsWith("rename to ")) cur.renameTo = line.slice("rename to ".length);
      else if (line.startsWith("new file mode")) cur.newFile = true;
      else if (line.startsWith("deleted file mode")) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new ParseFault(1);

  // Turn each section into an edit.
  const edits = [];
  for (let s = 0; s < sections.length; s++) {
    const sec = sections[s];
    const oldRaw = sec.minusPath !== undefined ? sec.minusPath : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
    const newRaw = sec.plusPath !== undefined ? sec.plusPath : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
    const isCreate = sec.minusPath === null || sec.newFile;
    const isDelete = sec.plusPath === null || sec.deletedFile;
    if (isCreate) {
      edits.push({ format: "unified", kind: "create", newPath: newRaw, hunks: sec.hunks });
    } else if (isDelete) {
      edits.push({ format: "unified", kind: "delete", oldPath: oldRaw });
    } else if (oldRaw !== newRaw) {
      edits.push({ format: "unified", kind: "move", oldPath: oldRaw, newPath: newRaw, hunks: sec.hunks });
    } else {
      edits.push({ format: "unified", kind: "change", oldPath: oldRaw, newPath: newRaw, hunks: sec.hunks });
    }
  }
  return edits;
}

// Apply a section's hunks to a line model. Returns {lines, ends} or null
// when a hunk finds no match.
function applyHunks(model, hunks, strict) {
  const lines = model.lines.slice();
  let ends = model.ends;
  let d = 0;
  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h];
    const on = bodyToON(hunk.body);
    const O = on.O;
    const entries = on.entries;
    if (O.length === 0) {
      const pos = Math.min(hunk.a + d, lines.length);
      const atEnd = pos === lines.length;
      const newLines = buildReplacement(lines, pos, O, entries, 0);
      for (let k = newLines.length - 1; k >= 0; k--) lines.splice(pos, 0, newLines[k]);
      if (atEnd && newLines.length > 0) ends = !backslashAfterLast(hunk.body);
      d += newLines.length;
      continue;
    }
    const occ = findOccurrences(lines, O, strict);
    if (occ === null) return null;
    const target = hunk.a - 1 + d;
    let best = occ.positions[0];
    let bestDist = Math.abs(best - target);
    for (let k = 1; k < occ.positions.length; k++) {
      const dist = Math.abs(occ.positions[k] - target);
      if (dist < bestDist) {
        best = occ.positions[k];
        bestDist = dist;
      }
    }
    const reachesEnd = best + O.length === lines.length;
    const newLines = buildReplacement(lines, best, O, entries, occ.tier);
    lines.splice(best, O.length, ...newLines);
    if (reachesEnd) ends = !backslashAfterLast(hunk.body);
    d += newLines.length - O.length;
  }
  return { lines: lines, ends: ends };
}

// ===================================================== SEARCH / REPLACE

function parseSearchReplace(lines) {
  const blocks = [];
  let prevEnd = -1;
  let prevPath = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].replace(/\s+$/, "") === "<<<<<<< SEARCH") {
      let eq = -1;
      let rep = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].replace(/\s+$/, "") === "=======") {
          eq = j;
          break;
        }
      }
      if (eq !== -1) {
        for (let j = eq + 1; j < lines.length; j++) {
          if (lines[j].replace(/\s+$/, "") === ">>>>>>> REPLACE") {
            rep = j;
            break;
          }
        }
      }
      if (eq === -1 || rep === -1) throw new ParseFault(i + 1);
      // The path: nearest qualifying line before the SEARCH line.
      let p = null;
      for (let j = i - 1; j > prevEnd; j--) {
        if (isBlank(lines[j])) continue;
        const t = lines[j].trim();
        if (t.startsWith("```")) continue;
        p = t;
        break;
      }
      if (p === null) {
        if (prevPath !== null) p = prevPath;
        else throw new ParseFault(i + 1);
      }
      blocks.push({
        format: "search-replace",
        kind: "block",
        path: p,
        oldLines: lines.slice(i + 1, eq),
        newLines: lines.slice(eq + 1, rep),
      });
      prevPath = p;
      prevEnd = rep;
      i = rep + 1;
      continue;
    }
    i++;
  }
  if (blocks.length === 0) throw new ParseFault(1);
  return blocks;
}

// ================================================================ V4A

function parseV4A(lines) {
  let begin = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      begin = i;
      break;
    }
  }
  if (begin === -1) throw new ParseFault(1);
  if (lines[begin].trim() !== "*** Begin Patch") throw new ParseFault(begin + 1);
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      end = i;
      break;
    }
  }
  if (lines[end].trim() !== "*** End Patch") throw new ParseFault(lines.length + 1);

  const sections = [];
  let cur = null;
  function startSection(kind, p, headLine) {
    cur = { kind: kind, path: p, headLine: headLine, raw: [] };
    sections.push(cur);
  }
  for (let i = begin + 1; i < end; i++) {
    const line = lines[i];
    if (line.startsWith("*** Add File: ")) {
      startSection("add", line.slice("*** Add File: ".length).trim(), i + 1);
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      startSection("delete", line.slice("*** Delete File: ".length).trim(), i + 1);
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      startSection("update", line.slice("*** Update File: ".length).trim(), i + 1);
      continue;
    }
    if (cur === null) {
      if (isBlank(line)) continue;
      throw new ParseFault(i + 1);
    }
    cur.raw.push({ text: line, num: i + 1 });
  }

  const edits = [];
  for (let s = 0; s < sections.length; s++) {
    const sec = sections[s];
    const raw = sec.raw;
    while (raw.length > 0 && isBlank(raw[raw.length - 1].text)) raw.pop();
    if (sec.kind === "add") {
      const fileLines = [];
      for (let k = 0; k < raw.length; k++) {
        const t = raw[k].text;
        if (t.startsWith("+")) fileLines.push(t.slice(1));
        else if (t === "") fileLines.push("");
        else throw new ParseFault(raw[k].num);
      }
      edits.push({ format: "v4a", kind: "add", path: sec.path, fileLines: fileLines });
    } else if (sec.kind === "delete") {
      if (raw.length > 0) throw new ParseFault(raw[0].num);
      edits.push({ format: "v4a", kind: "delete", path: sec.path });
    } else {
      // update
      let moveTo = null;
      const chunks = [];
      let chunk = null;
      for (let k = 0; k < raw.length; k++) {
        const t = raw[k].text;
        const num = raw[k].num;
        if (k === 0 && t.startsWith("*** Move to: ")) {
          moveTo = t.slice("*** Move to: ".length).trim();
          continue;
        }
        if (t.startsWith("@@")) {
          const anchorText = t.slice(2).trim();
          chunk = { anchor: anchorText === "" ? null : anchorText, eof: false, body: [] };
          chunks.push(chunk);
          continue;
        }
        if (t.trim() === "*** End of File") {
          if (chunk === null) throw new ParseFault(num);
          chunk.eof = true;
          chunk = null;
          continue;
        }
        if (t === "" || t[0] === " " || t[0] === "-" || t[0] === "+") {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, body: [] };
            chunks.push(chunk);
          }
          if (t === "") chunk.body.push({ kind: "ctx", text: "" });
          else if (t[0] === " ") chunk.body.push({ kind: "ctx", text: t.slice(1) });
          else if (t[0] === "-") chunk.body.push({ kind: "del", text: t.slice(1) });
          else chunk.body.push({ kind: "add", text: t.slice(1) });
          continue;
        }
        throw new ParseFault(num);
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(sec.headLine);
      edits.push({ format: "v4a", kind: "update", path: sec.path, moveTo: moveTo, chunks: chunks });
    }
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

// Apply one V4A update's chunks. Returns the new line model or null.
function applyChunks(model, chunks, strict) {
  const lines = model.lines.slice();
  let cursor = 0;
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    if (chunk.anchor !== null) {
      const tiers = strict ? [0] : [0, 1, 2];
      let found = -1;
      for (let t = 0; t < tiers.length && found === -1; t++) {
        for (let i = cursor; i < lines.length; i++) {
          if (lineEqAt(lines[i], chunk.anchor, tiers[t])) {
            found = i;
            break;
          }
        }
      }
      if (found === -1) return null;
      cursor = found + 1;
    }
    const on = bodyToON(chunk.body);
    const O = on.O;
    const entries = on.entries;
    if (O.length === 0) {
      const pos = chunk.eof ? lines.length : cursor;
      const newLines = buildReplacement(lines, pos, O, entries, 0);
      for (let k = newLines.length - 1; k >= 0; k--) lines.splice(pos, 0, newLines[k]);
      cursor = pos + newLines.length;
      continue;
    }
    const tiers = strict ? [0] : [0, 1, 2];
    let chosen = -1;
    let chosenTier = 0;
    for (let t = 0; t < tiers.length && chosen === -1; t++) {
      for (let i = cursor; i + O.length <= lines.length; i++) {
        let ok = true;
        for (let j = 0; j < O.length; j++) {
          if (!lineEqAt(lines[i + j], O[j], tiers[t])) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (chunk.eof && i + O.length !== lines.length) continue;
        chosen = i;
        chosenTier = tiers[t];
        break;
      }
    }
    if (chosen === -1) return null;
    const newLines = buildReplacement(lines, chosen, O, entries, chosenTier);
    lines.splice(chosen, O.length, ...newLines);
    cursor = chosen + newLines.length;
  }
  return { lines: lines, ends: model.ends };
}

// ================================================================ JSON

function validateJsonEdit(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (typeof obj.path !== "string") return null;
  if (obj.command === "create") {
    if (typeof obj.file_text !== "string") return null;
    return { format: "json", kind: "create", path: obj.path, fileText: obj.file_text };
  }
  if (obj.command === "str_replace") {
    if (typeof obj.old_str !== "string" || obj.old_str === "") return null;
    if (obj.new_str !== undefined && typeof obj.new_str !== "string") return null;
    return {
      format: "json",
      kind: "str_replace",
      path: obj.path,
      oldStr: obj.old_str,
      newStr: obj.new_str === undefined ? "" : obj.new_str,
    };
  }
  if (obj.command === "insert") {
    if (typeof obj.insert_line !== "number" || !Number.isInteger(obj.insert_line)) return null;
    if (typeof obj.new_str !== "string") return null;
    return { format: "json", kind: "insert", path: obj.path, insertLine: obj.insert_line, newStr: obj.new_str };
  }
  return null;
}

function parseJson(text, lines) {
  const edits = [];
  if (text.trim().startsWith("[")) {
    // Array form: any fault is blamed on the line where the array starts.
    let arrLine = 1;
    const idx = text.indexOf("[");
    arrLine = text.slice(0, idx).split("\n").length;
    let arr;
    try {
      arr = JSON.parse(text);
    } catch (e) {
      throw new ParseFault(arrLine);
    }
    if (!Array.isArray(arr)) throw new ParseFault(arrLine);
    for (let i = 0; i < arr.length; i++) {
      const v = validateJsonEdit(arr[i]);
      if (v === null) throw new ParseFault(arrLine);
      edits.push(v);
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === "") continue;
      let obj;
      try {
        obj = JSON.parse(lines[i]);
      } catch (e) {
        throw new ParseFault(i + 1);
      }
      const v = validateJsonEdit(obj);
      if (v === null) throw new ParseFault(i + 1);
      edits.push(v);
    }
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

// ============================================================ applying

// state: Map path -> content string, the virtual tree.
// Returns null on success, or {code, path} on failure.
function applyEdit(state, edit, strict, moves) {
  if (edit.format === "unified") return applyUnified(state, edit, strict, moves);
  if (edit.format === "search-replace") return applySearchReplace(state, edit, strict);
  if (edit.format === "v4a") return applyV4A(state, edit, strict, moves);
  return applyJson(state, edit);
}

function fail(code, p) {
  return { code: code, path: p };
}

function applyUnified(state, edit, strict, moves) {
  if (edit.kind === "create") {
    if (!isSafePath(edit.newPath)) return fail("unsafe", edit.newPath);
    if (state.has(edit.newPath)) return fail("exists", edit.newPath);
    const fileLines = [];
    let lastAddHunk = null;
    for (let h = 0; h < edit.hunks.length; h++) {
      const body = edit.hunks[h].body;
      for (let k = 0; k < body.length; k++) {
        if (body[k].kind === "add") {
          fileLines.push(body[k].text);
          lastAddHunk = edit.hunks[h];
        }
      }
    }
    let ends = true;
    if (lastAddHunk !== null) ends = !backslashAfterLast(lastAddHunk.body);
    state.set(edit.newPath, joinContent(fileLines, "\n", ends));
    return null;
  }
  if (edit.kind === "delete") {
    if (!isSafePath(edit.oldPath)) return fail("unsafe", edit.oldPath);
    if (!state.has(edit.oldPath)) return fail("missing", edit.oldPath);
    state.delete(edit.oldPath);
    return null;
  }
  // move or change
  if (!isSafePath(edit.oldPath)) return fail("unsafe", edit.oldPath);
  if (edit.kind === "move" && !isSafePath(edit.newPath)) return fail("unsafe", edit.newPath);
  if (!state.has(edit.oldPath)) return fail("missing", edit.oldPath);
  if (edit.kind === "move" && state.has(edit.newPath)) return fail("exists", edit.newPath);
  const model = splitContent(state.get(edit.oldPath));
  const result = applyHunks(model, edit.hunks, strict);
  if (result === null) return fail("no-match", edit.oldPath);
  const content = joinContent(result.lines, model.brk, result.ends);
  if (edit.kind === "move") {
    state.set(edit.newPath, content);
    state.delete(edit.oldPath);
    moves.push({ oldPath: edit.oldPath, newPath: edit.newPath });
  } else {
    state.set(edit.oldPath, content);
  }
  return null;
}

function applySearchReplace(state, edit, strict) {
  const p = edit.path;
  if (!isSafePath(p)) return fail("unsafe", p);
  if (edit.oldLines.length === 0) {
    if (state.has(p)) return fail("exists", p);
    state.set(p, joinContent(edit.newLines, "\n", true));
    return null;
  }
  if (!state.has(p)) return fail("missing", p);
  const model = splitContent(state.get(p));
  const occ = findOccurrences(model.lines, edit.oldLines, strict);
  if (occ === null) return fail("no-match", p);
  if (occ.positions.length > 1) return fail("ambiguous", p);
  const pos = occ.positions[0];
  const entries = edit.newLines.map(function (t) {
    return { kind: "add", text: t };
  });
  const newLines = buildReplacement(model.lines, pos, edit.oldLines, entries, occ.tier);
  const lines = model.lines.slice();
  lines.splice(pos, edit.oldLines.length, ...newLines);
  state.set(p, joinContent(lines, model.brk, model.ends));
  return null;
}

function applyV4A(state, edit, strict, moves) {
  const p = edit.path;
  if (!isSafePath(p)) return fail("unsafe", p);
  if (edit.kind === "add") {
    if (state.has(p)) return fail("exists", p);
    state.set(p, joinContent(edit.fileLines, "\n", true));
    return null;
  }
  if (edit.kind === "delete") {
    if (!state.has(p)) return fail("missing", p);
    state.delete(p);
    return null;
  }
  // update
  if (edit.moveTo !== null && !isSafePath(edit.moveTo)) return fail("unsafe", edit.moveTo);
  if (!state.has(p)) return fail("missing", p);
  if (edit.moveTo !== null && state.has(edit.moveTo)) return fail("exists", edit.moveTo);
  const model = splitContent(state.get(p));
  const result = applyChunks(model, edit.chunks, strict);
  if (result === null) return fail("no-match", p);
  const content = joinContent(result.lines, model.brk, result.ends);
  if (edit.moveTo !== null) {
    state.set(edit.moveTo, content);
    state.delete(p);
    moves.push({ oldPath: p, newPath: edit.moveTo });
  } else {
    state.set(p, content);
  }
  return null;
}

function countOccurrences(text, needle) {
  let count = 0;
  let idx = 0;
  for (;;) {
    const found = text.indexOf(needle, idx);
    if (found === -1) return count;
    count++;
    idx = found + 1;
  }
}

function applyJson(state, edit) {
  const p = edit.path;
  if (!isSafePath(p)) return fail("unsafe", p);
  if (edit.kind === "create") {
    if (state.has(p)) return fail("exists", p);
    state.set(p, edit.fileText);
    return null;
  }
  if (edit.kind === "str_replace") {
    if (!state.has(p)) return fail("missing", p);
    const content = state.get(p);
    const model = splitContent(content);
    let text = content;
    let oldStr = edit.oldStr;
    let newStr = edit.newStr;
    if (model.brk === "\r\n") {
      text = text.replace(/\r\n/g, "\n");
      oldStr = oldStr.replace(/\r\n/g, "\n");
      newStr = newStr.replace(/\r\n/g, "\n");
    }
    const count = countOccurrences(text, oldStr);
    if (count === 0) return fail("no-match", p);
    if (count > 1) return fail("ambiguous", p);
    const at = text.indexOf(oldStr);
    let result = text.slice(0, at) + newStr + text.slice(at + oldStr.length);
    if (model.brk === "\r\n") result = result.replace(/\n/g, "\r\n");
    state.set(p, result);
    return null;
  }
  // insert
  if (!state.has(p)) return fail("missing", p);
  const model = splitContent(state.get(p));
  if (edit.insertLine < 0 || edit.insertLine > model.lines.length) return fail("no-match", p);
  const newLines = patchLines(edit.newStr);
  const lines = model.lines.slice();
  for (let k = newLines.length - 1; k >= 0; k--) lines.splice(edit.insertLine, 0, newLines[k]);
  state.set(p, joinContent(lines, model.brk, model.ends));
  return null;
}

// ============================================================ the tree

function snapshotTree(root) {
  const map = new Map();
  function walk(dir, prefix) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const rel = prefix === "" ? e.name : prefix + "/" + e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) {
        try {
          map.set(rel, fs.readFileSync(full, "utf8"));
        } catch (err) {
          /* unreadable files are left out of the tree */
        }
      }
    }
  }
  walk(root, "");
  return map;
}

function byteCompare(a, b) {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return Buffer.compare(ba, bb);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts === null) {
    process.stdout.write("error: usage\n");
    process.exitCode = 2;
    return;
  }

  let patchText;
  if (opts.patchArg === null || opts.patchArg === "-") {
    try {
      patchText = fs.readFileSync(0, "utf8");
    } catch (e) {
      process.stdout.write("error: no-patch\n");
      process.exitCode = 2;
      return;
    }
  } else {
    try {
      patchText = fs.readFileSync(opts.patchArg, "utf8");
    } catch (e) {
      process.stdout.write("error: no-patch\n");
      process.exitCode = 2;
      return;
    }
  }

  const lines = patchLines(patchText);
  let format = opts.format;
  if (format === "auto") {
    format = detectFormat(lines);
    if (format === null) {
      process.stdout.write("error: format\n");
      process.exitCode = 2;
      return;
    }
  }

  let edits;
  try {
    if (format === "unified") edits = parseUnified(lines);
    else if (format === "search-replace") edits = parseSearchReplace(lines);
    else if (format === "v4a") edits = parseV4A(lines);
    else edits = parseJson(patchText, lines);
  } catch (e) {
    if (e instanceof ParseFault) {
      process.stdout.write("error: parse " + e.line + "\n");
      process.exitCode = 2;
      return;
    }
    throw e;
  }

  const root = process.cwd();
  const initial = snapshotTree(root);
  const state = new Map(initial);
  const moves = [];
  const failures = [];
  for (let i = 0; i < edits.length; i++) {
    const f = applyEdit(state, edits[i], opts.strict, moves);
    if (f !== null) failures.push(f);
  }

  if (failures.length > 0) {
    let out = "";
    for (let i = 0; i < failures.length; i++) {
      out += "error: " + failures[i].code + " " + failures[i].path + "\n";
    }
    out += "failed: " + failures.length + " of " + edits.length + " edits\n";
    process.stdout.write(out);
    process.exitCode = 1;
    return;
  }

  // Diff the final tree against the initial one.
  const changeLines = []; // {sortKey, text}
  const movedOld = new Set();
  const movedNew = new Set();
  for (let i = 0; i < moves.length; i++) {
    const mv = moves[i];
    if (initial.has(mv.oldPath) && !state.has(mv.oldPath) && !initial.has(mv.newPath) && state.has(mv.newPath)) {
      changeLines.push({ sortKey: mv.newPath, text: "R " + mv.oldPath + " -> " + mv.newPath });
      movedOld.add(mv.oldPath);
      movedNew.add(mv.newPath);
    }
  }
  const allPaths = new Set();
  initial.forEach(function (v, k) {
    allPaths.add(k);
  });
  state.forEach(function (v, k) {
    allPaths.add(k);
  });
  allPaths.forEach(function (p) {
    const had = initial.has(p);
    const has = state.has(p);
    if (had && !has) {
      if (!movedOld.has(p)) changeLines.push({ sortKey: p, text: "D " + p });
    } else if (!had && has) {
      if (!movedNew.has(p)) changeLines.push({ sortKey: p, text: "A " + p });
    } else if (had && has && initial.get(p) !== state.get(p)) {
      changeLines.push({ sortKey: p, text: "M " + p });
    }
  });
  changeLines.sort(function (x, y) {
    return byteCompare(x.sortKey, y.sortKey);
  });

  if (!opts.check) {
    for (let i = 0; i < changeLines.length; i++) {
      const text = changeLines[i].text;
      if (text.startsWith("D ")) {
        const p = text.slice(2);
        try {
          fs.unlinkSync(path.join(root, p));
        } catch (e) {
          /* already gone */
        }
      } else if (text.startsWith("R ")) {
        const parts = text.slice(2).split(" -> ");
        const oldP = parts[0];
        const newP = parts.slice(1).join(" -> ");
        try {
          fs.unlinkSync(path.join(root, oldP));
        } catch (e) {
          /* already gone */
        }
        const full = path.join(root, newP);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, state.get(newP), "utf8");
      } else {
        const p = text.slice(2);
        const full = path.join(root, p);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, state.get(p), "utf8");
      }
    }
  }

  let out = "";
  for (let i = 0; i < changeLines.length; i++) out += changeLines[i].text + "\n";
  out += changeLines.length === 1 ? "ok: 1 file\n" : "ok: " + changeLines.length + " files\n";
  process.stdout.write(out);
  process.exitCode = 0;
}

main();
