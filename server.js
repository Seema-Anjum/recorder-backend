import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { fileURLToPath } from "url" ;
import morgan from "morgan";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

const app = express();
const PORT = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

// --- storage dir --- 
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, {recursive: true});

// --- multer setup --- 
const storage = multer.diskStorage({
    destination: (_, __, cb) => cb(null, uploadDir),
    filename: (_, file, cb) => {
        // keep .webm extension 
        // adding timestamp 
        const ext = path.extname(file.originalname) || ".webm";
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    }
});

const upload = multer({storage});
// --- sqlite setup ---
const dbPath = path.join(__dirname, "database.db");
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      filesize INTEGER NOT NULL,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// --- health ---
app.get("/health", (_, res) => res.json({ ok: true }));

// --- list recordings ---
app.get("/api/recordings", (_, res) => {
  db.all(`SELECT id, filename, filepath, filesize, createdAt FROM recordings ORDER BY id DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });
    // Don’t leak absolute paths to client
    const sanitized = rows.map(r => ({ ...r, filepath: path.basename(r.filepath) }));
    res.json(sanitized);
  });
});

// --- upload recording ---
app.post("/api/recordings", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const { originalname, filename, path: filepath, size } = req.file;

  db.run(
    `INSERT INTO recordings (filename, filepath, filesize) VALUES (?, ?, ?)`,
    [originalname || filename, filepath, size],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to save metadata" });
      }
      res.status(201).json({
        message: "Recording uploaded successfully",
        recording: {
          id: this.lastID,
          filename: originalname || filename,
          filepath: path.basename(filepath),
          filesize: size,
          createdAt: new Date().toISOString()
        }
      });
    }
  );
});

// --- stream a recording (supports Range) ---
app.get("/api/recordings/:id", (req, res) => {
  const { id } = req.params;

  db.get(`SELECT * FROM recordings WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!row) return res.status(404).json({ error: "Recording not found" });

    const absolute = row.filepath;
    if (!fs.existsSync(absolute)) return res.status(404).json({ error: "File missing on server" });

    const stat = fs.statSync(absolute);
    const fileSize = stat.size;
    const range = req.headers.range;

    res.setHeader("Content-Type", "video/webm");

    if (range) {
      // Partial content for seeking
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      const chunkSize = end - start + 1;
      const file = fs.createReadStream(absolute, { start, end });
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "video/webm"
      });
      file.pipe(res);
    } else {
      // Full file
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": "video/webm"
      });
      fs.createReadStream(absolute).pipe(res);
    }
  });
});

// --- optional: delete recording ---
app.delete("/api/recordings/:id", (req, res) => {
  const { id } = req.params;
  db.get(`SELECT * FROM recordings WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!row) return res.status(404).json({ error: "Recording not found" });

    fs.unlink(row.filepath, (fsErr) => {
      if (fsErr && fsErr.code !== "ENOENT") {
        console.error(fsErr);
        return res.status(500).json({ error: "Failed to delete file" });
      }
      db.run(`DELETE FROM recordings WHERE id = ?`, [id], (dbErr) => {
        if (dbErr) return res.status(500).json({ error: "Failed to delete DB record" });
        res.json({ message: "Deleted" });
      });
    });
  });
});

// --- start ---
app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
