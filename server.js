const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const db = new Database(path.join(__dirname, "school.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS students (id INTEGER PRIMARY KEY, adm TEXT UNIQUE, name TEXT NOT NULL, gender TEXT,
  grade INTEGER NOT NULL, stream TEXT, guardian TEXT, phone TEXT, status TEXT DEFAULT 'Active');
CREATE TABLE IF NOT EXISTS teachers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tsc TEXT, subjects TEXT, classes TEXT);
CREATE TABLE IF NOT EXISTS attendance (date TEXT, class TEXT, student_id INTEGER, status TEXT, PRIMARY KEY (date, class, student_id));
CREATE TABLE IF NOT EXISTS fee_structure (section TEXT PRIMARY KEY, amount REAL);
CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER, amount REAL, date TEXT, ref TEXT);
CREATE TABLE IF NOT EXISTS marks (student_id INTEGER, subject TEXT, term TEXT, assessment TEXT, score REAL, comment TEXT,
  PRIMARY KEY (student_id, subject, term, assessment));
CREATE TABLE IF NOT EXISTS timetable (id INTEGER PRIMARY KEY, cls TEXT, day TEXT, period INTEGER, subject TEXT, teacher TEXT, room TEXT);
CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, name TEXT, role TEXT, salt TEXT, hash TEXT);
CREATE TABLE IF NOT EXISTS classes (name TEXT PRIMARY KEY);
`);
// Upgrade an existing school.db without losing data
const addCol = (t, c, def) => { if (!db.prepare("PRAGMA table_info(" + t + ")").all().some(x => x.name === c)) db.exec("ALTER TABLE " + t + " ADD COLUMN " + c + " " + def) };
addCol("users", "approved", "INTEGER DEFAULT 1");
addCol("users", "classes", "TEXT DEFAULT '[]'");
addCol("users", "subjects", "TEXT DEFAULT '[]'");
addCol("users", "ct", "TEXT DEFAULT ''");
addCol("marks", "by_id", "INTEGER");
addCol("marks", "by_name", "TEXT DEFAULT ''");
addCol("payments", "item", "TEXT DEFAULT 'Tuition'");
addCol("payments", "by_name", "TEXT DEFAULT ''");
db.prepare("INSERT OR IGNORE INTO fee_structure VALUES ('Primary', 25000), ('JSS', 35000)").run();

// A student's class is built from the grade and stream columns, e.g. "Grade 6A"
const CLS = "'Grade ' || s.grade || COALESCE(s.stream, '')";
const gradeOf = c => +(String(c).match(/\d/) || [1])[0];
for (let g = 1; g <= 9; g++) db.prepare("INSERT OR IGNORE INTO classes VALUES (?)").run("Grade " + g);
db.prepare("INSERT OR IGNORE INTO classes SELECT DISTINCT " + CLS + " FROM students s").run();

/* ---------- passwords ---------- */
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
const safeEq = (a, b) => { const x = Buffer.from(String(a)),
        y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y) };
const newPw = () => crypto.randomBytes(7).toString("base64url");

function setPw(rowid, pw) { const salt = crypto.randomBytes(16).toString("hex");
    db.prepare("UPDATE users SET salt = ?, hash = ? WHERE rowid = ?").run(salt, hash(pw, salt), rowid) }

function addUser(username, name, role, pw, approved, classes, subjects) {
    const salt = crypto.randomBytes(16).toString("hex");
    return db.prepare("INSERT INTO users (username, name, role, salt, hash, approved, classes, subjects, ct) VALUES (?,?,?,?,?,?,?,?, '')")
        .run(username, name, role, salt, hash(pw, salt), approved ? 1 : 0, JSON.stringify(classes || []), JSON.stringify(subjects || []));
}
if (!db.prepare("SELECT 1 FROM users").get()) {
    const pw = process.env.ADMIN_PASSWORD || newPw();
    addUser("admin", "Administrator", "admin", pw, true);
    console.log("FIRST RUN - admin login: admin /", pw, "(change it after signing in)");
}
// Replace the old built-in passwords (admin123, teacher123, bursar123) if they are still in use
for (const [un, old] of Object.entries({ admin: "admin123", teacher: "teacher123", bursar: "bursar123" })) {
    const u = db.prepare("SELECT rowid AS id, * FROM users WHERE username = ?").get(un);
    if (u && safeEq(hash(old, u.salt), u.hash)) { const p = newPw();
        setPw(u.id, p);
        console.log('SECURITY: the default password for "' + un + '" was replaced. New password:', p) }
}
if (process.argv.includes("--reset-admin")) {
    const a = db.prepare("SELECT rowid AS id, username FROM users WHERE role = 'admin' ORDER BY rowid LIMIT 1").get();
    const p = process.env.ADMIN_PASSWORD || newPw();
    setPw(a.id, p);
    db.prepare("UPDATE users SET approved = 1 WHERE rowid = ?").run(a.id);
    console.log("ADMIN PASSWORD RESET - login: " + a.username + " / " + p);
}

/* ---------- reading data (each role gets only what it needs) ---------- */
const JSONL = s => { try { return JSON.parse(s || "[]") } catch (e) { return [] } };
const pub = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, approved: !!u.approved, classes: JSONL(u.classes), subjects: JSONL(u.subjects), ct: u.ct || "" });
const classList = () => db.prepare("SELECT name FROM classes").all().map(r => r.name).sort((a, b) => gradeOf(a) - gradeOf(b) || a.localeCompare(b));
const getUsers = () => db.prepare("SELECT rowid AS id, * FROM users ORDER BY rowid").all();

function getAtt(only) {
    const att = {};
    for (const r of db.prepare("SELECT * FROM attendance").all()) {
        if (only && r.class !== only) continue;
        const k = r.date + "|" + r.class;
        (att[k] = att[k] || {})[r.student_id] = r.status;
    }
    return att;
}

function view(u) {
    const out = { me: pub(u), classes: classList(), tt: db.prepare("SELECT id, cls, day, period, subject, teacher, room FROM timetable").all() };
    const students = db.prepare("SELECT s.id, s.adm, s.name, s.gender, s.guardian, s.phone, s.status, " + CLS + " AS cls FROM students s ORDER BY s.id").all();
    const marks = db.prepare("SELECT m.student_id AS sid, " + CLS + " AS cls, m.subject AS sub, m.term, m.assessment AS ass, m.score, m.comment, m.by_id AS by, m.by_name AS byName FROM marks m JOIN students s ON s.id = m.student_id").all();
    const fees = {};
    db.prepare("SELECT * FROM fee_structure").all().forEach(r => fees[r.section] = r.amount);
    const pay = () => db.prepare("SELECT id, student_id AS sid, amount AS amt, date, ref, item, by_name AS by FROM payments").all();
    if (u.role === "admin") return Object.assign(out, { fees, students, pay: pay(), marks, att: getAtt(), users: getUsers().map(pub) });
    if (u.role === "bursar") return Object.assign(out, { fees, students, pay: pay(), marks: [], att: {} });
    const p = pub(u),
        mine = new Set([...p.classes, p.ct].filter(Boolean));
    const st = students.filter(s => mine.has(s.cls)),
        ids = new Set(st.map(s => s.id));
    return Object.assign(out, { students: st, pay: [], marks: marks.filter(m => ids.has(m.sid) && (m.cls === p.ct || m.by === u.id)), att: p.ct ? getAtt(p.ct) : {} });
}

/* ---------- actions (every change is checked against the user's role) ---------- */
const E = (c, m) => Object.assign(new Error(m), { c });
const T = (x, n = 80) => String(x == null ? "" : x).trim().slice(0, n);
const arr = (x, n) => Array.isArray(x) ? x.map(i => T(i, 60)).filter(Boolean).slice(0, n) : [];
const need = (u, ...r) => { if (!r.includes(u.role)) throw E(403, "You do not have permission for this action") };
const own = (u, c) => { if (u.role !== "admin" && !(u.role === "teacher" && u.ct && u.ct === c)) throw E(403, "Only the admin or the class teacher can do this") };
const cl = c => { if (!db.prepare("SELECT 1 FROM classes WHERE name = ?").get(c)) throw E(400, "Unknown class"); return c };
const strong = p => typeof p === "string" && p.length >= 8 && p.length <= 100;
const uname = x => {
    x = T(x, 30).toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(x)) throw E(400, "Username: 3-30 letters, numbers, . _ -");
    if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(x)) throw E(400, "Username already taken");
    return x;
};
const clsOf = id => { const s = db.prepare("SELECT " + CLS + " AS cls, s.status FROM students s WHERE s.id = ?").get(id); return s };
const sessions = new Map();

const A = {
    "student.add": (u, b) => {
        const c = cl(b.cls);
        own(u, c);
        const name = T(b.name);
        if (!name) throw E(400, "Name is required");
        const m = c.match(/^Grade (\d+)(.*)$/);
        const id = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM students").get().n;
        let adm = new Date().getFullYear() + "-" + String(id).padStart(3, "0");
        if (db.prepare("SELECT 1 FROM students WHERE adm = ?").get(adm)) adm += "-" + id;
        db.prepare("INSERT INTO students (id, adm, name, gender, grade, stream, guardian, phone, status) VALUES (?,?,?,?,?,?,?,?, 'Active')")
            .run(id, adm, name, b.gender === "M" ? "M" : "F", +m[1], m[2].trim(), T(b.guardian), T(b.phone, 20));
    },
    "student.status": (u, b) => {
        const s = clsOf(b.id);
        if (!s) throw E(404, "Student not found");
        own(u, s.cls);
        if (!["Active", "Transferred", "Withdrawn"].includes(b.status)) throw E(400, "Bad status");
        db.prepare("UPDATE students SET status = ? WHERE id = ?").run(b.status, b.id);
    },
    "student.del": (u, b) => {
        need(u, "admin");
        db.transaction(() => ["payments", "marks", "attendance"].forEach(t => db.prepare("DELETE FROM " + t + " WHERE student_id = ?").run(b.id)))();
        db.prepare("DELETE FROM students WHERE id = ?").run(b.id);
    },
    "att.save": (u, b) => {
        const c = cl(b.cls);
        own(u, c);
        if (!/^\d{4}-\d\d-\d\d$/.test(b.date)) throw E(400, "Bad date");
        db.transaction(() => {
            db.prepare("DELETE FROM attendance WHERE date = ? AND class = ?").run(b.date, c);
            const ins = db.prepare("INSERT INTO attendance VALUES (?,?,?,?)");
            db.prepare("SELECT s.id FROM students s WHERE s.status = 'Active' AND " + CLS + " = ?").all(c)
                .forEach(s => ins.run(b.date, c, s.id, ["P", "A", "L"].includes(b.rec && b.rec[s.id]) ? b.rec[s.id] : "P"));
        })();
    },
    "fees.set": (u, b) => {
        need(u, "admin", "bursar");
        const f = db.prepare("INSERT OR REPLACE INTO fee_structure VALUES (?,?)");
        f.run("Primary", Math.max(0, +b.Primary || 0));
        f.run("JSS", Math.max(0, +b.JSS || 0));
    },
    "pay.add": (u, b) => {
        need(u, "admin", "bursar");
        if (!db.prepare("SELECT 1 FROM students WHERE id = ?").get(b.sid)) throw E(404, "Student not found");
        const amt = +b.amt;
        if (!(amt > 0)) throw E(400, "Enter a valid amount");
        db.prepare("INSERT INTO payments (student_id, amount, date, ref, item, by_name) VALUES (?,?,?,?,?,?)")
            .run(b.sid, amt, new Date().toISOString().slice(0, 10), T(b.ref, 40), T(b.item, 40) || "Tuition", u.name);
    },
    "marks.save": (u, b) => {
        const c = cl(b.cls),
            sub = T(b.sub, 60),
            term = T(b.term, 10),
            ass = T(b.ass, 60) || "End of term";
        need(u, "admin", "teacher");
        const p = pub(u);
        if (u.role === "teacher" && !([...p.classes, p.ct].includes(c) && p.subjects.includes(sub))) throw E(403, "You can only enter marks for classes and subjects on your profile");
        if (!sub || !["Term 1", "Term 2", "Term 3"].includes(term)) throw E(400, "Choose subject and term");
        const del = db.prepare("DELETE FROM marks WHERE student_id = ? AND subject = ? AND term = ? AND assessment = ?");
        const ins = db.prepare("INSERT INTO marks (student_id, subject, term, assessment, score, comment, by_id, by_name) VALUES (?,?,?,?,?,?,?,?)");
        db.transaction(() => {
            for (const r of(Array.isArray(b.rows) ? b.rows : [])) {
                const s = clsOf(r.sid);
                if (!s || s.cls !== c || s.status !== "Active") continue;
                del.run(r.sid, sub, term, ass);
                if (r.score !== "" && r.score != null && !isNaN(+r.score)) ins.run(r.sid, sub, term, ass, Math.min(100, Math.max(0, +r.score)), T(r.comment, 120), u.id, u.name);
            }
        })();
    },
    "me.set": (u, b) => {
        need(u, "teacher");
        const names = classList();
        db.prepare("UPDATE users SET classes = ?, subjects = ? WHERE rowid = ?")
            .run(JSON.stringify(arr(b.classes, 30).filter(c => names.includes(c))), JSON.stringify(arr(b.subjects, 20)), u.id);
    },
    "me.pw": (u, b) => {
        if (!safeEq(hash(String(b.old), u.salt), u.hash)) throw E(400, "Current password is wrong");
        if (!strong(b.new)) throw E(400, "Password must be at least 8 characters");
        setPw(u.id, b.new);
    },
    "class.add": (u, b) => {
        need(u, "admin");
        const n = T(b.name, 20);
        if (!/^Grade [1-9][A-Za-z0-9 ]{0,10}$/.test(n) || db.prepare("SELECT 1 FROM classes WHERE name = ?").get(n)) throw E(400, 'Use a new name like "Grade 6A"');
        db.prepare("INSERT INTO classes VALUES (?)").run(n);
    },
    "user.add": (u, b) => {
        need(u, "admin");
        if (!["teacher", "bursar"].includes(b.role)) throw E(400, "Bad role");
        const n = T(b.name);
        if (!n) throw E(400, "Name is required");
        if (!strong(b.password)) throw E(400, "Password must be at least 8 characters");
        addUser(uname(b.username), n, b.role, b.password, true);
    },
    "user.set": (u, b) => {
        need(u, "admin");
        const t = getUsers().find(x => x.id === b.id);
        if (!t) throw E(404, "User not found");
        if ("approved" in b && t.role !== "admin") db.prepare("UPDATE users SET approved = ? WHERE rowid = ?").run(b.approved ? 1 : 0, t.id);
        if ("ct" in b && t.role === "teacher") {
            if (b.ct) { cl(b.ct);
                db.prepare("UPDATE users SET ct = '' WHERE ct = ?").run(b.ct) }
            db.prepare("UPDATE users SET ct = ? WHERE rowid = ?").run(b.ct || "", t.id);
        }
        if (b.approved === false)
            for (const [k, v] of sessions)
                if (v.uid === t.id) sessions.delete(k);
    },
    "user.pw": (u, b) => {
        need(u, "admin");
        if (!getUsers().some(x => x.id === b.id)) throw E(404, "User not found");
        if (!strong(b.password)) throw E(400, "Password must be at least 8 characters");
        setPw(b.id, b.password);
    },
    "user.del": (u, b) => {
        need(u, "admin");
        const t = getUsers().find(x => x.id === b.id);
        if (!t || t.role === "admin") throw E(400, "This account cannot be removed");
        db.prepare("DELETE FROM users WHERE rowid = ?").run(t.id);
        for (const [k, v] of sessions)
            if (v.uid === t.id) sessions.delete(k);
    },
    "tt.add": (u, b) => {
        need(u, "admin");
        const c = cl(b.cls),
            p = +b.period,
            sub = T(b.subject, 60);
        if (!["Mon", "Tue", "Wed", "Thu", "Fri"].includes(b.day) || !(p >= 1 && p <= 8)) throw E(400, "Bad day or period");
        if (!sub) throw E(400, "Subject is required");
        db.transaction(() => {
            db.prepare("DELETE FROM timetable WHERE cls = ? AND day = ? AND period = ?").run(c, b.day, p);
            const id = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM timetable").get().n;
            db.prepare("INSERT INTO timetable VALUES (?,?,?,?,?,?,?)").run(id, c, b.day, p, sub, T(b.teacher, 60), T(b.room, 10));
        })();
    },
    "tt.del": (u, b) => { need(u, "admin");
        db.prepare("DELETE FROM timetable WHERE id = ?").run(b.id) }
};

/* ---------- web server ---------- */
const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
    res.set({
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
    });
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    next();
});
app.use(express.json({ limit: "300kb" }));
app.use(express.static(path.join(__dirname, "public")));

const tries = new Map();

function limit(req, res, next) {
    const ip = req.socket.remoteAddress,
        t = tries.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - t.t > 9e5) { t.n = 0;
        t.t = Date.now() }
    if (t.n >= 10) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    t.n++;
    tries.set(ip, t);
    next();
}

app.get("/api/meta", (req, res) => res.json({ classes: classList() }));

app.post("/api/login", limit, (req, res) => {
    const b = req.body || {};
    const u = db.prepare("SELECT rowid AS id, * FROM users WHERE username = ?").get(T(b.username, 30).toLowerCase());
    if (!u || !safeEq(hash(String(b.password || ""), u.salt), u.hash)) return res.status(401).json({ error: "Wrong username or password" });
    if (!u.approved) return res.status(403).json({ error: "Your account is waiting for admin approval" });
    tries.delete(req.socket.remoteAddress);
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { uid: u.id, exp: Date.now() + 72e5 });
    res.json({ token });
});

app.post("/api/register", limit, (req, res) => {
    try {
        const b = req.body || {},
            n = T(b.name);
        if (!n) throw E(400, "Enter your full name");
        if (!strong(b.password)) throw E(400, "Password must be at least 8 characters");
        const names = classList(),
            classes = arr(b.classes, 30).filter(c => names.includes(c)),
            subjects = arr(b.subjects, 20);
        if (!classes.length || !subjects.length) throw E(400, "Select at least one class and one subject");
        addUser(uname(b.username), n, "teacher", b.password, false, classes, subjects);
        res.json({ ok: true });
    } catch (err) { fail(res, err) }
});

function auth(req, res, next) {
    const token = (req.headers.authorization || "").replace("Bearer ", ""),
        s = sessions.get(token);
    const u = s && s.exp > Date.now() && db.prepare("SELECT rowid AS id, * FROM users WHERE rowid = ?").get(s.uid);
    if (!u || !u.approved) { sessions.delete(token); return res.status(401).json({ error: "Please sign in again" }) }
    s.exp = Date.now() + 72e5;
    req.user = u;
    req.token = token;
    next();
}

function fail(res, err) {
    if (!err.c) console.error("Request error:", err);
    res.status(err.c || 400).json({ error: err.c ? err.message : "Server error - see the terminal window" });
}

app.get("/api/data", auth, (req, res) => { try { res.json(view(req.user)) } catch (err) { fail(res, err) } });
app.post("/api/logout", auth, (req, res) => { sessions.delete(req.token);
    res.json({ ok: true }) });
app.post("/api/act", auth, (req, res) => {
    try {
        const f = A[(req.body || {}).a];
        if (!f) throw E(400, "Unknown action");
        f(req.user, req.body);
        res.json({ ok: true });
    } catch (err) { fail(res, err) }
});
app.use((err, req, res, next) => res.status(400).json({ error: "Bad request" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("School system running at http://localhost:" + PORT));